//! Native hints, snapshot settlement and app-write reconciliation.
use super::native::{ spawn_scheduled_reconcile };
use super::disk::{finalize_authorization_transition, resolve_disk_state};
use super::*;


impl ActiveDocumentWatchState {
    pub(super) fn settle_snapshot(
        entry: &mut WatchEntry,
        resolved: &ResolvedDisk,
    ) -> Result<
        (
            ActiveDocumentDiskSnapshot,
            ActiveDocumentWatchReason,
            Option<String>,
        ),
        String,
    > {
        match resolved {
            ResolvedDisk::Present {
                file,
                reason,
                previous_path,
                ..
            } => {
                let preview_revision = increment_safe(entry.preview_revision, "Preview revision")?;
                Ok((
                    ActiveDocumentDiskSnapshot::Present {
                        file: file.clone(),
                        preview_revision,
                    },
                    *reason,
                    previous_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                ))
            }
            ResolvedDisk::Missing => Ok((
                ActiveDocumentDiskSnapshot::Missing {
                    path: entry.path.to_string_lossy().to_string(),
                },
                ActiveDocumentWatchReason::Missing,
                None,
            )),
        }
    }

    pub(super) fn snapshot_content_matches(
        left: &ActiveDocumentDiskSnapshot,
        right: &ActiveDocumentDiskSnapshot,
    ) -> bool {
        match (left, right) {
            (
                ActiveDocumentDiskSnapshot::Present { file: left, .. },
                ActiveDocumentDiskSnapshot::Present { file: right, .. },
            ) => left == right,
            (
                ActiveDocumentDiskSnapshot::Missing { path: left },
                ActiveDocumentDiskSnapshot::Missing { path: right },
            ) => left == right,
            _ => false,
        }
    }

    pub(super) fn committed_write_matches(entry: &WatchEntry, resolved: &ResolvedDisk) -> bool {
        let AppWriteExpectation::Committed {
            expected_bytes,
            expires_at,
        } = &entry.write_expectation
        else {
            return false;
        };
        if Instant::now() > *expires_at {
            return false;
        }
        matches!(
            resolved,
            ResolvedDisk::Present { file, .. }
                if file.path == entry.path.to_string_lossy()
                    && file.content.as_deref().is_some_and(|content| content.as_bytes() == expected_bytes)
        )
    }

    pub(super) fn clear_committed_expectation(entry: &mut WatchEntry) -> Result<(), String> {
        if matches!(
            entry.write_expectation,
            AppWriteExpectation::Committed { .. }
        ) {
            entry.write_expectation = AppWriteExpectation::None;
            entry.write_epoch = increment_safe(entry.write_epoch, "Write epoch")?;
        }
        Ok(())
    }

    pub(super) fn reconcile_command(
        &self,
        state: &AppState,
        watch_id: &str,
        document_id: &str,
        document_generation: u64,
    ) -> Result<ActiveDocumentWatchSnapshotEnvelope, String> {
        let _lane = self.lock_lane()?;
        let context = self.capture_command_context(watch_id, document_id, document_generation)?;
        let mut resolved = resolve_disk_state(state, &context)?;
        let mut watch_state = self.lock()?;
        let entry = watch_state
            .current
            .as_mut()
            .filter(|entry| {
                entry.watch_id == context.watch_id
                    && entry.document_id == context.document_id
                    && entry.document_generation == context.document_generation
            })
            .ok_or_else(|| "Active document monitoring identity is stale".to_string())?;
        if entry.write_epoch != context.write_epoch
            || matches!(entry.write_expectation, AppWriteExpectation::Writing { .. })
        {
            return Err("The active file changed while monitoring reconciled it".to_string());
        }
        finalize_authorization_transition(state, entry, &mut resolved)?;
        Self::cancel_missing_grace(entry)?;
        Self::clear_committed_expectation(entry)?;
        let (snapshot, mut reason, previous_path) = Self::settle_snapshot(entry, &resolved)?;
        if matches!(reason, ActiveDocumentWatchReason::Changed) {
            reason = ActiveDocumentWatchReason::Resync;
        }
        entry.sequence = increment_safe(entry.sequence, "Watch sequence")?;
        if let ActiveDocumentDiskSnapshot::Present {
            preview_revision, ..
        } = &snapshot
        {
            entry.preview_revision = *preview_revision;
        }
        entry.last_snapshot = Some(snapshot.clone());
        Ok(ActiveDocumentWatchSnapshotEnvelope {
            protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
            watch_id: entry.watch_id.clone(),
            document_id: entry.document_id.clone(),
            document_generation: entry.document_generation,
            sequence: entry.sequence,
            reason,
            previous_path,
            snapshot,
        })
    }

    pub(crate) fn begin_app_write(
        &self,
        path: &Path,
        expected_bytes: Vec<u8>,
    ) -> Option<AppWriteToken> {
        let mut state = self.inner.lock().ok()?;
        let entry = state
            .current
            .as_mut()
            .filter(|entry| entry.phase == WatchPhase::Active && entry.path == path)?;
        entry.write_epoch = increment_safe(entry.write_epoch, "Write epoch").ok()?;
        entry.write_expectation = AppWriteExpectation::Writing {
            expected_bytes,
            reconcile_again: false,
        };
        Some(AppWriteToken {
            watch_id: entry.watch_id.clone(),
            write_epoch: entry.write_epoch,
        })
    }

    pub(crate) fn settle_app_write(&self, token: AppWriteToken, committed: bool) -> Option<String> {
        let mut state = self.inner.lock().ok()?;
        let entry = state.current.as_mut().filter(|entry| {
            entry.watch_id == token.watch_id && entry.write_epoch == token.write_epoch
        })?;
        let AppWriteExpectation::Writing {
            expected_bytes,
            reconcile_again,
        } = std::mem::replace(&mut entry.write_expectation, AppWriteExpectation::None)
        else {
            return None;
        };
        entry.write_epoch = increment_safe(entry.write_epoch, "Write epoch").ok()?;
        if committed {
            entry.write_expectation = AppWriteExpectation::Committed {
                expected_bytes,
                expires_at: Instant::now() + SELF_WRITE_EXPECTATION_TTL,
            };
        }
        let rerun = reconcile_again || entry.reconcile_again;
        entry.reconcile_again = false;
        if rerun && entry.phase == WatchPhase::Active && !entry.reconcile_scheduled {
            entry.reconcile_scheduled = true;
            Some(entry.watch_id.clone())
        } else {
            None
        }
    }

    pub(crate) fn settle_app_write_and_schedule(
        &self,
        app: &AppHandle,
        token: AppWriteToken,
        committed_version: Option<&FileVersion>,
    ) {
        if let Some(version) = committed_version {
            self.apply_committed_version(&token, version);
        }
        if let Some(watch_id) = self.settle_app_write(token, committed_version.is_some()) {
            spawn_scheduled_reconcile(app.clone(), watch_id, ScheduledReconcileMode::Event);
        }
    }

    pub(super) fn apply_committed_version(&self, token: &AppWriteToken, version: &FileVersion) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(entry) = state.current.as_mut().filter(|entry| {
                entry.watch_id == token.watch_id && entry.write_epoch == token.write_epoch
            }) {
                entry.file_identity = Some(version.platform_identity().to_string());
                entry.file_binding = version.retained_file_binding();
            }
        }
    }
}
