//! FileAuthorizationSession operations (segment).
use super::*;

mod session_a_helpers;
use session_a_helpers::prepare_pending_save_mutations;

impl FileAuthorizationSession {
    pub(crate) fn lock(&self) -> Result<AuthorizationGuard<'_>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Authorization state is poisoned".to_string())?;
        #[cfg(test)]
        {
            Ok(AuthorizationGuard::new(guard))
        }
        #[cfg(not(test))]
        {
            Ok(guard)
        }
    }
    #[cfg(test)]
    pub(crate) fn authorization_generation(&self) -> Result<u64, String> {
        Ok(self.lock()?.authorization_generation)
    }
    #[cfg(feature = "packaged-lifecycle-e2e")]
    pub(crate) fn evidence_snapshot(&self) -> Result<AuthorizationEvidenceSnapshot, String> {
        let state = self.lock()?;
        let mut grants = state
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                let (kind, path) = match key {
                    GrantKey::ExactReadWrite(path) => ("exact_rw", path),
                    GrantKey::DirectoryRead(path) => ("directory_read", path),
                    GrantKey::InternalAsset(path) => ("internal_asset", path),
                };
                ledger.origins.iter().map(move |(origin, count)| {
                    let origin = match origin {
                        GrantOrigin::Workspace(_) => "workspace",
                        GrantOrigin::OpenDocument(_) => "open_document",
                        GrantOrigin::SaveAs(_) => "save_as",
                        GrantOrigin::CreatedDocument(_) => "created_document",
                        GrantOrigin::Preview(_) => "preview",
                    };
                    AuthorizationEvidenceGrant {
                        kind,
                        path: path.to_string_lossy().into_owned(),
                        origin,
                        status: match ledger.status {
                            GrantStatus::Active => "active",
                            GrantStatus::Suspended => "suspended",
                        },
                        count: *count,
                    }
                })
            })
            .collect::<Vec<_>>();
        grants.sort_by(|left, right| {
            (
                left.kind,
                left.path.as_str(),
                left.origin,
                left.status,
                left.count,
            )
                .cmp(&(
                    right.kind,
                    right.path.as_str(),
                    right.origin,
                    right.status,
                    right.count,
                ))
        });
        let mut aggregated: Vec<AuthorizationEvidenceGrant> = Vec::with_capacity(grants.len());
        for grant in grants {
            if let Some(existing) = aggregated.last_mut().filter(|existing| {
                existing.kind == grant.kind
                    && existing.path == grant.path
                    && existing.origin == grant.origin
                    && existing.status == grant.status
            }) {
                existing.count = existing.count.saturating_add(grant.count);
            } else {
                aggregated.push(grant);
            }
        }
        Ok(AuthorizationEvidenceSnapshot {
            generation: state.authorization_generation,
            pending_workspace_receipts: state.pending_workspace_authorities.len(),
            grants: aggregated,
        })
    }
    #[cfg(test)]
    pub(crate) fn set_authorization_generation_for_test(
        &self,
        generation: u64,
    ) -> Result<(), String> {
        self.lock()?.authorization_generation = generation;
        Ok(())
    }
    pub(crate) fn with_save_authorization_scope<T>(
        &self,
        path: impl AsRef<Path>,
        operation: impl FnOnce(&mut SaveAuthorizationScope<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = normalize_file_for_write(path)?;
        let mut state = self.lock()?;
        operation(&mut SaveAuthorizationScope {
            state: &mut state,
            path,
        })
    }
    #[cfg(test)]
    pub(crate) fn with_exact_write_authority<T>(
        &self,
        path: impl AsRef<Path>,
        operation: impl FnOnce(&Path, u64) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if !state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &path && exact_grant_is_current(&state, file, ledger))
        }) {
            return Err("Destination file has not been explicitly authorized by open, workspace selection, or save-as".into());
        }
        operation(&path, state.authorization_generation)
    }
    pub(crate) fn reserve_pending_save_authority(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PendingSaveAuthority, String> {
        let path = normalize_file_for_write(path)?;
        let mut state = self.lock()?;
        state
            .authorization_generation
            .checked_add(2)
            .ok_or_else(|| {
                "Authorization generation cannot reserve a save-as transition".to_string()
            })?;
        let id = DocumentGrantId(state.next_document_grant_id);
        let next_document_grant_id = state
            .next_document_grant_id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        let origin = GrantOrigin::SaveAs(id);
        let mut keys = vec![GrantKey::ExactReadWrite(path.clone())];
        if let Some(parent) = path.parent() {
            keys.push(GrantKey::InternalAsset(parent.to_path_buf()));
        }
        let (mutations, next_grant_sequence) =
            prepare_pending_save_mutations(&mut state, &origin, keys)?;
        state.authorization_generation += 1;
        let generation = state.authorization_generation;
        state.next_document_grant_id = next_document_grant_id;
        state.next_grant_sequence = next_grant_sequence;
        if state.pending_save_authorities.len() >= MAX_PENDING_SAVE_AUTHORITIES {
            state.pending_save_authorities.clear();
        }
        state.pending_save_authorities.insert(
            id,
            PendingSaveReservation {
                path: path.clone(),
                mutations,
            },
        );
        Ok(PendingSaveAuthority {
            path,
            id,
            generation,
        })
    }
    pub(crate) fn cancel_pending_save_authority(
        &self,
        pending: &PendingSaveAuthority,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let removed = state.pending_save_authorities.remove(&pending.id).is_some();
        if removed && pending.generation == state.authorization_generation {
            state.authorization_generation += 1;
        }
        Ok(removed)
    }
    #[cfg(test)]
    pub(crate) fn pending_save_authority_count_for_test(&self) -> Result<usize, String> {
        let count = self.lock()?.pending_save_authorities.len();
        debug_assert!(count <= MAX_PENDING_SAVE_AUTHORITIES);
        Ok(count)
    }
    #[cfg(test)]
    pub(crate) fn expire_workspace_authority_for_test(&self, receipt: &str) -> Result<(), String> {
        let token = WorkspaceToken::from_receipt(receipt)?;
        let mut state = self.lock()?;
        let pending = state
            .pending_workspace_authorities
            .get_mut(&token)
            .ok_or_else(|| "Workspace open receipt is unknown".to_string())?;
        pending.expires_at = Instant::now();
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn pending_workspace_authority_count_for_test(&self) -> Result<usize, String> {
        Ok(self.lock()?.pending_workspace_authorities.len())
    }
    #[cfg(test)]
    pub(crate) fn state_fingerprint_for_test(&self) -> String {
        let state = match self.inner.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut workspaces = state
            .workspaces
            .iter()
            .map(|(token, workspace)| format!("{token:?}:{}", workspace.root.display()))
            .collect::<Vec<_>>();
        workspaces.sort();
        let mut workspace_document_origins = state
            .workspace_document_origins
            .iter()
            .map(|(document, workspace)| format!("{document:?}:{workspace:?}"))
            .collect::<Vec<_>>();
        workspace_document_origins.sort();
        let mut document_origin_identities = state
            .document_origin_identities
            .iter()
            .map(|(document, identity)| format!("{document:?}:{identity}"))
            .collect::<Vec<_>>();
        document_origin_identities.sort();
        let mut grants = state
            .grants
            .iter()
            .map(|(key, ledger)| {
                let mut origins = ledger
                    .origins
                    .iter()
                    .map(|(origin, count)| format!("{origin:?}:{count}"))
                    .collect::<Vec<_>>();
                origins.sort();
                format!(
                    "{key:?}:{:?}:{}:{origins:?}",
                    ledger.status, ledger.first_granted_sequence
                )
            })
            .collect::<Vec<_>>();
        grants.sort();
        format!(
            "workspaces={workspaces:?};workspace_document_origins={workspace_document_origins:?};document_origin_identities={document_origin_identities:?};grants={grants:?};counters={:?}",
            (
                state.next_workspace_token_id,
                state.next_document_grant_id,
                state.next_preview_lease_id,
                state.next_grant_sequence,
                state.authorization_generation,
            )
        )
    }
}
