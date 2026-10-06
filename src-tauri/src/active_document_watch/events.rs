//! Native hints, snapshot settlement and app-write reconciliation.
use super::*;


impl ActiveDocumentWatchState {
    pub(super) fn note_native_hint(
        &self,
        watch_id: &str,
        event_paths: &[PathBuf],
        rename_candidates: Vec<(PathBuf, PathBuf)>,
        force_reconcile: bool,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let Some(entry) = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
        else {
            return Ok(false);
        };
        let relevant = force_reconcile
            || event_paths.iter().any(|path| path == &entry.path)
            || rename_candidates
                .iter()
                .any(|(old, new)| old == &entry.path || new == &entry.path);
        if !relevant {
            return Ok(false);
        }
        for candidate in rename_candidates {
            if !entry.rename_candidates.contains(&candidate) {
                entry.rename_candidates.push(candidate);
            }
        }
        if entry.degraded {
            entry.degraded = false;
            entry.health_epoch = increment_safe(entry.health_epoch, "Watch health epoch")?;
        }
        if entry.phase == WatchPhase::PendingActivation {
            entry.activation_reconcile_required = true;
            return Ok(false);
        }
        if let AppWriteExpectation::Writing {
            reconcile_again, ..
        } = &mut entry.write_expectation
        {
            *reconcile_again = true;
            return Ok(false);
        }
        if entry.reconcile_scheduled {
            entry.reconcile_again = true;
            return Ok(false);
        }
        entry.reconcile_scheduled = true;
        Ok(true)
    }

    pub(super) fn note_native_error(&self, app: &AppHandle, watch_id: &str) -> Result<(), String> {
        let mut schedule_reconcile = false;
        let mut schedule_fallback = None;
        {
            let mut state = self.lock()?;
            let Some(entry) = state
                .current
                .as_mut()
                .filter(|entry| entry.watch_id == watch_id)
            else {
                return Ok(());
            };
            if entry.phase == WatchPhase::PendingActivation {
                entry.pending_health_degraded = true;
                entry.activation_reconcile_required = true;
                return Ok(());
            }
            if !entry.degraded {
                entry.degraded = true;
                entry.health_epoch = increment_safe(entry.health_epoch, "Watch health epoch")?;
                entry.sequence = increment_safe(entry.sequence, "Watch sequence")?;
                let event = ActiveDocumentWatchEvent {
                    protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
                    watch_id: entry.watch_id.clone(),
                    document_id: entry.document_id.clone(),
                    document_generation: entry.document_generation,
                    sequence: entry.sequence,
                    event: ActiveDocumentWatchEventPayload::Health {
                        status: ActiveDocumentWatchHealthStatus::Degraded,
                        message: "Monitoring is temporarily retrying.".to_string(),
                    },
                };
                let _ = app.emit_to("main", ACTIVE_DOCUMENT_WATCH_EVENT, event);
                schedule_fallback = Some(entry.health_epoch);
            }
            if !entry.reconcile_scheduled {
                entry.reconcile_scheduled = true;
                schedule_reconcile = true;
            } else {
                entry.reconcile_again = true;
            }
        }
        self.schedule_watch_followups(&app, watch_id, schedule_reconcile, schedule_fallback);
        Ok(())
    }

    pub(super) fn capture_scheduled_context(
        &self,
        watch_id: &str,
        mode: ScheduledReconcileMode,
    ) -> Result<Option<ReconcileContext>, String> {
        let mut state = self.lock()?;
        let Some(entry) = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
        else {
            return Ok(None);
        };
        if let ScheduledReconcileMode::MissingConfirmation { token } = mode {
            if !entry.missing_pending || entry.missing_token != token {
                entry.reconcile_scheduled = false;
                return Ok(None);
            }
        }
        if entry.phase == WatchPhase::PendingActivation {
            entry.activation_reconcile_required = true;
            entry.reconcile_scheduled = false;
            return Ok(None);
        }
        if let AppWriteExpectation::Writing {
            reconcile_again, ..
        } = &mut entry.write_expectation
        {
            *reconcile_again = true;
            entry.reconcile_scheduled = false;
            return Ok(None);
        }
        Ok(Some(ReconcileContext {
            watch_id: entry.watch_id.clone(),
            document_id: entry.document_id.clone(),
            document_generation: entry.document_generation,
            path: entry.path.clone(),
            parent: entry.parent.clone(),
            file_kind: entry.file_kind,
            write_epoch: entry.write_epoch,
            rename_candidates: std::mem::take(&mut entry.rename_candidates),
        }))
    }

    pub(super) fn capture_command_context(
        &self,
        watch_id: &str,
        document_id: &str,
        document_generation: u64,
    ) -> Result<ReconcileContext, String> {
        let state = self.lock()?;
        let entry = state
            .current
            .as_ref()
            .filter(|entry| {
                entry.watch_id == watch_id
                    && entry.document_id == document_id
                    && entry.document_generation == document_generation
                    && entry.phase == WatchPhase::Active
            })
            .ok_or_else(|| "Active document monitoring identity is stale".to_string())?;
        if matches!(entry.write_expectation, AppWriteExpectation::Writing { .. }) {
            return Err("The active file is still being saved".to_string());
        }
        Ok(ReconcileContext {
            watch_id: entry.watch_id.clone(),
            document_id: entry.document_id.clone(),
            document_generation: entry.document_generation,
            path: entry.path.clone(),
            parent: entry.parent.clone(),
            file_kind: entry.file_kind,
            write_epoch: entry.write_epoch,
            rename_candidates: entry.rename_candidates.clone(),
        })
    }

    pub(super) fn mark_scheduled_stale(entry: &mut WatchEntry) -> bool {
        if let AppWriteExpectation::Writing {
            reconcile_again, ..
        } = &mut entry.write_expectation
        {
            *reconcile_again = true;
            entry.reconcile_scheduled = false;
            return false;
        }
        entry.reconcile_again = true;
        Self::finish_scheduled(entry)
    }

    pub(super) fn finish_scheduled(entry: &mut WatchEntry) -> bool {
        entry.reconcile_scheduled = false;
        if entry.reconcile_again
            && entry.phase == WatchPhase::Active
            && !matches!(entry.write_expectation, AppWriteExpectation::Writing { .. })
        {
            entry.reconcile_again = false;
            entry.reconcile_scheduled = true;
            true
        } else {
            false
        }
    }

    pub(super) fn begin_missing_grace(entry: &mut WatchEntry) -> Result<u64, String> {
        if !entry.missing_pending {
            entry.missing_token =
                increment_safe(entry.missing_token, "Missing confirmation token")?;
            entry.missing_pending = true;
        }
        Ok(entry.missing_token)
    }

    pub(super) fn cancel_missing_grace(entry: &mut WatchEntry) -> Result<(), String> {
        if entry.missing_pending {
            entry.missing_token =
                increment_safe(entry.missing_token, "Missing confirmation token")?;
            entry.missing_pending = false;
        }
        Ok(())
    }

}
