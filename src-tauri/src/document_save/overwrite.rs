//! Overwrite-token issuance, cancellation and retry.
pub(crate) use super::*;

use super::save_flow::require_exact_write_authority;

impl DocumentSaveCoordinator {
    pub(crate) fn issue_overwrite_token(
        &self,
        authorization: &FileAuthorizationSession,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<OverwriteToken, String> {
        ensure_main_save_owner(owner)?;
        validate_operation_id(operation_id)?;
        authorization.with_save_authorization_scope(destination, |scope| {
            require_exact_write_authority(scope, pending)?;
            let observed_version = capture_file_version(scope.path())
                .map_err(|error| format!("Cannot observe overwrite destination: {error}"))?
                .ok_or_else(|| {
                    "Cannot issue an overwrite token for a missing destination".to_string()
                })?;
            self.insert_overwrite_token(scope, observed_version, bytes, operation_id, pending)
        })
    }

    pub(crate) fn insert_overwrite_token(
        &self,
        scope: &mut SaveAuthorizationScope<'_>,
        observed_version: FileVersion,
        bytes: &[u8],
        operation_id: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<OverwriteToken, String> {
        let now = self.clock.now();
        let mut tokens = self
            .tokens
            .lock()
            .map_err(|_| "Overwrite token store is poisoned".to_string())?;
        evict_expired_tokens(scope, &mut tokens, now);
        evict_oldest_token_if_capped(scope, &mut tokens);
        if pending.is_some_and(|pending| !scope.matches_pending(pending)) {
            return Err("Pending save-as authorization expired or was evicted".into());
        }
        let id = allocate_unique_token_id(&tokens)?;
        tokens.insert(
            id.clone(),
            OverwriteRecord {
                destination: scope.path().to_path_buf(),
                observed_version,
                intended_sha256: sha256(bytes),
                operation_id: operation_id.to_string(),
                expires_at: now + OVERWRITE_TOKEN_TTL,
                authorization_generation: scope.generation(),
                pending_save_as: pending.cloned(),
                main_owner: true,
            },
        );
        Ok(OverwriteToken(id))
    }

    pub(crate) fn cancel_overwrite_token(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        owner: &str,
    ) -> Result<(), String> {
        let record = self.take_overwrite_record(token)?;
        if let Some(pending) = record.pending_save_as.as_ref() {
            let _ = authorization.cancel_pending_save_authority(pending);
        }
        ensure_main_save_owner(owner)?;
        authorization.with_save_authorization_scope(destination, |scope| {
            if record.destination != scope.path() {
                return Err("Overwrite token does not match the requested destination".into());
            }
            Ok(())
        })
    }

    pub(crate) fn retry_with_token<F>(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        preflight: F,
    ) -> Result<DocumentSaveDisposition, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        self.retry_with_token_and_path(
            authorization,
            token,
            destination,
            bytes,
            operation_id,
            owner,
            preflight,
        )
        .map(|(_, disposition)| disposition)
    }

    pub(crate) fn retry_with_token_and_path<F>(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        preflight: F,
    ) -> Result<(PathBuf, DocumentSaveDisposition), String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let record = self.take_overwrite_record(token)?;
        let pending = record.pending_save_as.clone();
        let result = (|| {
            let mismatch = record.expires_at <= self.clock.now()
                || record.intended_sha256 != sha256(bytes)
                || record.operation_id != operation_id
                || validate_operation_id(operation_id).is_err()
                || !record.main_owner
                || owner != MAIN_SAVE_OWNER;
            if mismatch {
                return Err(
                    "Overwrite token no longer matches the authorized save operation".into(),
                );
            }
            authorization.with_save_authorization_scope(destination, |scope| {
                let mismatch = record.destination != scope.path()
                    || record.authorization_generation != scope.generation()
                    || pending
                        .as_ref()
                        .is_some_and(|pending| !scope.matches_pending(pending));
                if mismatch {
                    return Err(
                        "Overwrite token no longer matches the authorized save operation".into(),
                    );
                }
                if pending.is_none() && !scope.has_exact_write_authority() {
                    scope.refresh_workspace_document_identity();
                    if !scope.has_exact_write_authority() {
                        return Err(
                            "Overwrite token no longer matches the authorized save operation".into(),
                        );
                    }
                }
                preflight(scope.path())?;
                let expected = ExpectedFileState::Exact {
                    version: record.observed_version,
                };
                let path = scope.path().to_path_buf();
                let identity_origins = scope.capture_identity_origins()?;
                let outcome = self.writer.write(scope.path(), bytes, &expected);
                self.finish_write(scope, pending.as_ref(), &identity_origins, outcome)
                    .map(|disposition| (path, disposition))
            })
        })();
        if result.is_err() {
            if let Some(pending) = pending.as_ref() {
                let _ = authorization.cancel_pending_save_authority(pending);
            }
        }
        result
    }

    fn take_overwrite_record(&self, token: &OverwriteToken) -> Result<OverwriteRecord, String> {
        self.tokens
            .lock()
            .map_err(|_| "Overwrite token store is poisoned".to_string())?
            .remove(token.as_str())
            .ok_or_else(|| "Overwrite token is unknown or has already been consumed".to_string())
    }

    pub(crate) fn finish_write(
        &self,
        scope: &mut SaveAuthorizationScope<'_>,
        pending: Option<&PendingSaveAuthority>,
        identity_origins: &SaveIdentityOrigins,
        outcome: io::Result<DurableWriteOutcome>,
    ) -> Result<DocumentSaveDisposition, String> {
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => DurableWriteOutcome::Indeterminate {
                message: format!("The durable writer failed without a proven disposition: {error}"),
                recovery_paths: Vec::new(),
            },
        };
        match &outcome {
            DurableWriteOutcome::ConfirmedCommitted { version, .. } => {
                if let Some(pending) = pending {
                    scope.publish_pending(pending);
                }
                scope.settle_identity_origins(identity_origins, version.platform_identity());
            }
            DurableWriteOutcome::Indeterminate { .. } => {
                if let Some(pending) = pending {
                    scope.invalidate_pending(pending);
                }
            }
            DurableWriteOutcome::ConfirmedNotCommitted { .. }
            | DurableWriteOutcome::Conflict { .. } => {
                if let Some(pending) = pending {
                    scope.invalidate_pending(pending);
                }
            }
        }
        Ok(outcome.into())
    }

    #[cfg(test)]
    pub(crate) fn with_ports(writer: Arc<dyn DocumentWriter>, clock: Arc<dyn MonotonicClock>) -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            writer,
            clock,
        }
    }
}

fn evict_expired_tokens(
    scope: &mut SaveAuthorizationScope<'_>,
    tokens: &mut HashMap<String, OverwriteRecord>,
    now: Instant,
) {
    let expired = tokens
        .iter()
        .filter(|(_, record)| record.expires_at <= now)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(record) = tokens.remove(&id) {
            if let Some(pending) = record.pending_save_as.as_ref() {
                scope.invalidate_pending(pending);
            }
        }
    }
}

fn evict_oldest_token_if_capped(
    scope: &mut SaveAuthorizationScope<'_>,
    tokens: &mut HashMap<String, OverwriteRecord>,
) {
    if tokens.len() >= MAX_OVERWRITE_TOKENS {
        if let Some(oldest) = tokens
            .iter()
            .min_by_key(|(_, record)| record.expires_at)
            .map(|(id, _)| id.clone())
        {
            if let Some(record) = tokens.remove(&oldest) {
                if let Some(pending) = record.pending_save_as.as_ref() {
                    scope.invalidate_pending(pending);
                }
            }
        }
    }
}

fn allocate_unique_token_id(tokens: &HashMap<String, OverwriteRecord>) -> Result<String, String> {
    (0..8)
        .map(|_| random_token_id())
        .find_map(|candidate| match candidate {
            Ok(candidate) if !tokens.contains_key(&candidate) => Some(Ok(candidate)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .transpose()?
        .ok_or_else(|| "Cannot allocate a unique overwrite token".to_string())
}
