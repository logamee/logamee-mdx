//! Commit, status and lifecycle operations on the facade.
use super::*;

impl RecentFilesState {
    #[cfg(test)]
    pub(crate) fn commit_open(
        &self,
        open_receipt: &str,
        owner_window: &str,
        authorization: &FileAuthorizationSession,
    ) -> Result<OpenCommitResult, String> {
        self.commit_open_with_post_commit(open_receipt, owner_window, authorization, |_| {})
    }

    pub(crate) fn commit_open_with_post_commit(
        &self,
        open_receipt: &str,
        owner_window: &str,
        authorization: &FileAuthorizationSession,
        post_commit: impl FnOnce(&Path),
    ) -> Result<OpenCommitResult, String> {
        let now = self.clock.now();
        let mut runtime = self.lock_runtime()?;
        let pending = runtime
            .take_receipt(open_receipt, owner_window, now)
            .ok_or_else(|| "Open receipt is invalid, expired, or already consumed".to_string())?;
        let prepared_outcome =
            runtime.prepare_terminal_outcome(owner_window, pending.commit_operation_id, now)?;
        let mut prepared_outcome = Some(prepared_outcome);
        let mut indeterminate_error = None;
        let failure_outcome = TerminalOpenOutcome::NotCommitted {
            message: COMMIT_FAILURE_MESSAGE.to_string(),
        };

        let committed = self.store.with_current_store(|store| {
            self.promote_and_commit(
                store,
                authorization,
                &pending.canonical_target,
                &pending.workspace_authorization,
                &mut runtime,
                &mut prepared_outcome,
                &mut indeterminate_error,
            )
        });

        match committed {
            Ok((recent_files, canonical_target)) => {
                drop(runtime);
                post_commit(Path::new(&canonical_target));
                Ok(OpenCommitResult::Committed { recent_files })
            }
            Err(_) if indeterminate_error.is_some() => {
                Err(indeterminate_error
                    .expect("indeterminate commit failure retains its diagnostic"))
            }
            Err(_) => {
                runtime.apply_terminal_outcome(
                    prepared_outcome
                        .take()
                        .expect("failed commit retains its terminal outcome"),
                    failure_outcome,
                );
                Ok(OpenCommitResult::NotCommitted {
                    message: COMMIT_FAILURE_MESSAGE.to_string(),
                })
            }
        }
    }

    fn promote_and_commit(
        &self,
        store: RecentFileStoreV1,
        authorization: &FileAuthorizationSession,
        pending_target: &String,
        pending_authorization: &Option<WorkspaceReadAuthorization>,
        runtime: &mut RecentRuntimeGuard<'_>,
        prepared_outcome: &mut Option<PreparedTerminalOutcome>,
        indeterminate_error: &mut Option<String>,
    ) -> Result<(RecentFilesSnapshot, String), String> {
        let canonical_target = if let Some(authorization) = pending_authorization {
            authorization
                .path()
                .to_str()
                .filter(|target| *target == *pending_target)
                .ok_or_else(|| "Workspace open receipt target changed".to_string())?
                .to_string()
        } else {
            canonicalize_supported_file(pending_target)
                .filter(|target| target == pending_target)
                .ok_or_else(|| "Open target is no longer a supported file".to_string())?
        };
        let original = store;
        let mut promoted = original.clone();
        promoted.promote(canonical_target.clone(), &mut || self.id_source.next_id())?;
        let snapshot = promoted.snapshot()?;
        let retained_snapshot = snapshot.clone();
        let post_commit_target = canonical_target.clone();
        authorization.with_prepared_open_document_grant_for_receipt(
            PathBuf::from(&canonical_target),
            pending_authorization.as_ref(),
            |grant| {
                self.store.persist_locked(&promoted)?;
                if let Err(error) = grant.apply() {
                    if let Err(rollback_error) = self.store.persist_locked(&original) {
                        *indeterminate_error = Some(format!(
                            "Recent file commit became indeterminate after authorization failed ({error}) and rollback failed: {rollback_error}"
                        ));
                    }
                    return Err(error);
                }
                runtime.apply_terminal_outcome(
                    prepared_outcome
                        .take()
                        .expect("terminal outcome is applied exactly once"),
                    TerminalOpenOutcome::Committed {
                        recent_files: retained_snapshot,
                    },
                );
                Ok((snapshot, post_commit_target))
            },
        )
    }

    pub(crate) fn status(
        &self,
        owner_window: &str,
        commit_operation_id: &str,
    ) -> Result<OpenCommitStatus, String> {
        if !is_valid_opaque_id(commit_operation_id) {
            return Err("Commit operation identifier is invalid".to_string());
        }
        let mut runtime = self.lock_runtime()?;
        Ok(
            match runtime.status(owner_window, commit_operation_id, self.clock.now()) {
                RuntimeOpenStatus::Pending => OpenCommitStatus::Pending,
                RuntimeOpenStatus::Committed { recent_files } => {
                    OpenCommitStatus::Committed { recent_files }
                }
                RuntimeOpenStatus::NotCommitted { message } => {
                    OpenCommitStatus::NotCommitted { message }
                }
                RuntimeOpenStatus::Unknown => OpenCommitStatus::Unknown,
            },
        )
    }

    pub(crate) fn discard(&self, owner_window: &str, open_receipt: &str) -> Result<bool, String> {
        if !is_valid_opaque_id(open_receipt) {
            return Err("Open receipt is invalid".to_string());
        }
        let mut runtime = self.lock_runtime()?;
        Ok(runtime.discard_receipt(open_receipt, owner_window, self.clock.now()))
    }

    #[cfg(test)]
    pub(crate) fn remove(&self, entry_id: &str) -> Result<RecentFilesSnapshot, String> {
        let _runtime = self.lock_runtime()?;
        self.store.remove(entry_id)
    }

    pub(crate) fn clear(&self) -> Result<RecentFilesSnapshot, String> {
        let _runtime = self.lock_runtime()?;
        self.store.clear()
    }

    pub(crate) fn remove_owner(&self, owner_window: &str) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        runtime.remove_owner(owner_window, self.clock.now());
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        runtime.shutdown(self.clock.now());
        Ok(())
    }

    pub(super) fn lock_runtime(&self) -> Result<RecentRuntimeGuard<'_>, String> {
        let inner = self
            .runtime
            .lock()
            .map_err(|_| "Recent files state is poisoned".to_string())?;
        #[cfg(test)]
        {
            Ok(RecentRuntimeGuard::new(inner))
        }
        #[cfg(not(test))]
        {
            Ok(inner)
        }
    }

    pub(super) fn next_receipt_identifiers(&self) -> Result<OpenReceiptIdentifiers, String> {
        let open_receipt = self.id_source.next_id()?;
        let commit_operation_id = self.id_source.next_id()?;
        if !is_valid_opaque_id(&open_receipt)
            || !is_valid_opaque_id(&commit_operation_id)
            || open_receipt == commit_operation_id
        {
            return Err("Generated open receipt identifiers are invalid".to_string());
        }
        Ok(OpenReceiptIdentifiers {
            open_receipt,
            commit_operation_id,
        })
    }
}
