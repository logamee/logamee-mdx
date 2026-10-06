//! Watch registration, activation and teardown on the state.
use super::native::{ spawn_scheduled_reconcile };
use super::fallback::{spawn_fallback_polling};
use super::*;


impl ActiveDocumentWatchState {

    pub(super) fn schedule_watch_followups(
        &self,
        app: &AppHandle,
        watch_id: &str,
        schedule_reconcile: bool,
        schedule_fallback: Option<u64>,
    ) {
        if schedule_reconcile {
            spawn_scheduled_reconcile(
                app.clone(),
                watch_id.to_string(),
                ScheduledReconcileMode::Event,
            );
        }
        if let Some(health_epoch) = schedule_fallback {
            spawn_fallback_polling(app.clone(), watch_id.to_string(), health_epoch);
        }
    }
    pub(super) fn lock(&self) -> Result<MutexGuard<'_, WatchState>, String> {
        self.inner
            .lock()
            .map_err(|_| "Active document monitoring state is unavailable".to_string())
    }

    pub(super) fn lock_lane(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.reconcile_lane
            .lock()
            .map_err(|_| "Active document monitoring control lane is unavailable".to_string())
    }

    pub(super) fn next_watch_id(state: &mut WatchState) -> Result<String, String> {
        let id = state.next_watch_id;
        state.next_watch_id = increment_safe(id, "Watch identifier")?;
        Ok(format!("watch-{id}"))
    }

    pub(super) fn replace_pending(
        &self,
        document_id: String,
        document_generation: u64,
        path: PathBuf,
        parent: PathBuf,
        file_kind: WorkspaceFileKind,
    ) -> Result<(String, Option<WatchEntry>), String> {
        let mut state = self.lock()?;
        let watch_id = Self::next_watch_id(&mut state)?;
        let previous = state.current.take();
        state.current = Some(WatchEntry {
            watch_id: watch_id.clone(),
            document_id,
            document_generation,
            registration_sequence: 0,
            sequence: 0,
            path,
            parent,
            file_identity: None,
            file_binding: None,
            file_kind,
            phase: WatchPhase::PendingActivation,
            activation_reconcile_required: false,
            pending_health_degraded: false,
            reconcile_scheduled: false,
            reconcile_again: false,
            rename_candidates: Vec::new(),
            missing_pending: false,
            missing_token: 0,
            preview_revision: 0,
            last_snapshot: None,
            write_epoch: 0,
            write_expectation: AppWriteExpectation::None,
            degraded: false,
            health_epoch: 0,
            handle: None,
        });
        Ok((watch_id, previous))
    }

    pub(super) fn remove_if_current(&self, watch_id: &str) -> Option<WatchEntry> {
        let mut state = self.inner.lock().ok()?;
        if state
            .current
            .as_ref()
            .is_some_and(|entry| entry.watch_id == watch_id)
        {
            state.current.take()
        } else {
            None
        }
    }

    pub(super) fn attach_handle(
        &self,
        watch_id: &str,
        handle: Box<dyn WatchHandlePort>,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let entry = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
            .ok_or_else(|| "Active document monitoring was replaced during startup".to_string())?;
        entry.handle = Some(handle);
        Ok(())
    }

    pub(super) fn finalize_registration(
        &self,
        watch_id: &str,
        snapshot: ActiveDocumentDiskSnapshot,
        file_identity: Option<String>,
        file_binding: Option<Arc<fs::File>>,
    ) -> Result<ActiveDocumentWatchRegistration, String> {
        let mut state = self.lock()?;
        let entry = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
            .ok_or_else(|| "Active document monitoring was replaced during startup".to_string())?;
        entry.sequence = 1;
        entry.registration_sequence = 1;
        if let ActiveDocumentDiskSnapshot::Present {
            preview_revision, ..
        } = &snapshot
        {
            entry.preview_revision = *preview_revision;
        }
        entry.last_snapshot = Some(snapshot.clone());
        entry.file_identity = file_identity;
        entry.file_binding = file_binding;
        Ok(ActiveDocumentWatchRegistration {
            protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
            watch_id: entry.watch_id.clone(),
            document_id: entry.document_id.clone(),
            document_generation: entry.document_generation,
            sequence: entry.sequence,
            snapshot,
        })
    }

    pub(super) fn activate(
        &self,
        app: &AppHandle,
        watch_id: &str,
        document_id: &str,
        document_generation: u64,
        registration_sequence: u64,
    ) -> Result<bool, String> {
        let mut schedule_reconcile = false;
        let mut schedule_fallback = None;
        {
            let mut state = self.lock()?;
            let Some(entry) = state.current.as_mut() else {
                return Ok(false);
            };
            if entry.watch_id != watch_id
                || entry.document_id != document_id
                || entry.document_generation != document_generation
                || entry.registration_sequence != registration_sequence
                || entry.phase != WatchPhase::PendingActivation
            {
                return Ok(false);
            }
            entry.phase = WatchPhase::Active;
            if entry.activation_reconcile_required {
                entry.activation_reconcile_required = false;
                entry.reconcile_scheduled = true;
                schedule_reconcile = true;
            }
            if entry.pending_health_degraded {
                entry.pending_health_degraded = false;
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
        }
        self.schedule_watch_followups(&app, watch_id, schedule_reconcile, schedule_fallback);
        Ok(true)
    }

    pub(super) fn stop(&self, watch_id: &str) -> Result<bool, String> {
        let _lane = self.lock_lane()?;
        let entry = self.remove_if_current(watch_id);
        if let Some(entry) = entry {
            stop_entry(entry);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn stop_all(&self) {
        let Ok(_lane) = self.reconcile_lane.lock() else {
            return;
        };
        let entry = self
            .inner
            .lock()
            .ok()
            .and_then(|mut state| state.current.take());
        if let Some(entry) = entry {
            stop_entry(entry);
        }
    }
}
