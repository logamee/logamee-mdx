//! Test-only helpers on the watch state.
use super::*;

impl ActiveDocumentWatchState {




    pub(super) fn install_for_test(
        &self,
        watch_id: &str,
        document_id: &str,
        document_generation: u64,
        path: PathBuf,
    ) {
        let file_kind = WorkspaceFileKind::Markdown;
        let parent = path.parent().unwrap().to_path_buf();
        let file_identity = fs::File::open(&path)
            .ok()
            .and_then(|file| opened_file_platform_identity(&file).ok());
        let file_binding = fs::File::open(&path).ok().map(Arc::new);
        self.inner.lock().unwrap().current = Some(WatchEntry {
            watch_id: watch_id.to_string(),
            document_id: document_id.to_string(),
            document_generation,
            registration_sequence: 1,
            sequence: 1,
            path,
            parent,
            file_identity,
            file_binding,
            file_kind,
            phase: WatchPhase::PendingActivation,
            activation_reconcile_required: false,
            pending_health_degraded: false,
            reconcile_scheduled: false,
            reconcile_again: false,
            rename_candidates: Vec::new(),
            missing_pending: false,
            missing_token: 0,
            preview_revision: 1,
            last_snapshot: None,
            write_epoch: 0,
            write_expectation: AppWriteExpectation::None,
            degraded: false,
            health_epoch: 0,
            handle: None,
        });
    }

    pub(super) fn note_hint_for_test(&self, watch_id: &str) {
        let mut state = self.inner.lock().unwrap();
        let Some(entry) = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
        else {
            return;
        };
        if entry.phase == WatchPhase::PendingActivation {
            entry.activation_reconcile_required = true;
            return;
        }
        if let AppWriteExpectation::Writing {
            reconcile_again, ..
        } = &mut entry.write_expectation
        {
            *reconcile_again = true;
            return;
        }
        if entry.reconcile_scheduled {
            entry.reconcile_again = true;
        } else {
            entry.reconcile_scheduled = true;
        }
    }

    pub(super) fn activate_for_test(
        &self,
        watch_id: &str,
        document_id: &str,
        document_generation: u64,
        registration_sequence: u64,
    ) -> bool {
        let mut state = self.inner.lock().unwrap();
        let Some(entry) = state.current.as_mut() else {
            return false;
        };
        if entry.watch_id != watch_id
            || entry.document_id != document_id
            || entry.document_generation != document_generation
            || entry.registration_sequence != registration_sequence
            || entry.phase != WatchPhase::PendingActivation
        {
            return false;
        }
        entry.phase = WatchPhase::Active;
        if entry.activation_reconcile_required {
            entry.activation_reconcile_required = false;
            entry.reconcile_scheduled = true;
        }
        true
    }

    pub(super) fn take_reconcile_request_for_test(&self, watch_id: &str) -> bool {
        let mut state = self.inner.lock().unwrap();
        let Some(entry) = state
            .current
            .as_mut()
            .filter(|entry| entry.watch_id == watch_id)
        else {
            return false;
        };
        std::mem::take(&mut entry.reconcile_scheduled)
    }

    pub(super) fn stop_for_test(&self, watch_id: &str) -> bool {
        self.remove_if_current(watch_id).is_some()
    }

    pub(super) fn begin_write_for_test(&self, path: &Path, expected_bytes: Vec<u8>) -> Option<u64> {
        self.begin_app_write(path, expected_bytes)
            .map(|token| token.write_epoch)
    }

    pub(super) fn captured_write_epoch_for_test(&self, watch_id: &str) -> Option<u64> {
        self.inner
            .lock()
            .unwrap()
            .current
            .as_ref()
            .filter(|entry| entry.watch_id == watch_id)
            .map(|entry| entry.write_epoch)
    }

    pub(super) fn settle_write_for_test(&self, committed: bool) -> bool {
        let token = {
            let state = self.inner.lock().unwrap();
            let entry = state.current.as_ref().unwrap();
            AppWriteToken {
                watch_id: entry.watch_id.clone(),
                write_epoch: entry.write_epoch,
            }
        };
        self.settle_app_write(token, committed).is_some()
    }
}
