use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use notify::{
    event::{ModifyKind, RenameMode},
    EventKind, RecursiveMode,
};
use notify_debouncer_full::{
    new_debouncer, DebounceEventHandler, DebounceEventResult, Debouncer, RecommendedCache,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    commands::{open_authorized_file_response_from_handle, opened_file_platform_identity},
    durable_write::FileVersion,
    models::{
        ActiveDocumentDiskSnapshot, ActiveDocumentWatchEvent, ActiveDocumentWatchEventPayload,
        ActiveDocumentWatchHealthStatus, ActiveDocumentWatchReason,
        ActiveDocumentWatchRegistration, ActiveDocumentWatchSnapshotEnvelope, OpenFileResponse,
        ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
    },
    path_auth::{
        ensure_authorized_existing_file_inner, ensure_authorized_watch_file_inner,
        open_authorized_existing_file_inner,
        relocate_authorized_path_prefix_with_workspace_authorization_inner,
        revoke_authorized_path_prefix_inner, WorkspaceReadAuthorization,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
};

pub(crate) const ACTIVE_DOCUMENT_WATCH_EVENT: &str = "mmd-active-document-watch";
const DEBOUNCE_DURATION: Duration = Duration::from_millis(250);
const MISSING_GRACE: Duration = Duration::from_millis(750);
const SELF_WRITE_EXPECTATION_TTL: Duration = Duration::from_secs(5);
const DEGRADED_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DEGRADED_POLL_ATTEMPTS: u8 = 30;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WatchPhase {
    PendingActivation,
    Active,
}

#[derive(Clone, Debug)]
enum AppWriteExpectation {
    None,
    Writing {
        expected_bytes: Vec<u8>,
        reconcile_again: bool,
    },
    Committed {
        expected_bytes: Vec<u8>,
        expires_at: Instant,
    },
}

trait WatchHandlePort: Send {
    fn stop(&mut self);
}

struct NativeWatchHandle {
    debouncer: Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>,
}

impl WatchHandlePort for NativeWatchHandle {
    fn stop(&mut self) {
        if let Some(debouncer) = self.debouncer.take() {
            debouncer.stop_nonblocking();
        }
    }
}

impl Drop for NativeWatchHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

struct WatchEntry {
    watch_id: String,
    document_id: String,
    document_generation: u64,
    registration_sequence: u64,
    sequence: u64,
    path: PathBuf,
    parent: PathBuf,
    file_identity: Option<String>,
    file_binding: Option<Arc<fs::File>>,
    file_kind: WorkspaceFileKind,
    phase: WatchPhase,
    activation_reconcile_required: bool,
    pending_health_degraded: bool,
    reconcile_scheduled: bool,
    reconcile_again: bool,
    rename_candidates: Vec<(PathBuf, PathBuf)>,
    missing_pending: bool,
    missing_token: u64,
    preview_revision: u64,
    last_snapshot: Option<ActiveDocumentDiskSnapshot>,
    write_epoch: u64,
    write_expectation: AppWriteExpectation,
    degraded: bool,
    health_epoch: u64,
    handle: Option<Box<dyn WatchHandlePort>>,
}

struct WatchState {
    current: Option<WatchEntry>,
    next_watch_id: u64,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            current: None,
            next_watch_id: 1,
        }
    }
}

#[derive(Default)]
pub(crate) struct ActiveDocumentWatchState {
    inner: Mutex<WatchState>,
    reconcile_lane: Mutex<()>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppWriteToken {
    watch_id: String,
    write_epoch: u64,
}

#[derive(Clone)]
struct ReconcileContext {
    watch_id: String,
    document_id: String,
    document_generation: u64,
    path: PathBuf,
    parent: PathBuf,
    file_kind: WorkspaceFileKind,
    write_epoch: u64,
    rename_candidates: Vec<(PathBuf, PathBuf)>,
}

enum DiskRead {
    Present {
        file: OpenFileResponse,
        file_identity: String,
        file_binding: Arc<fs::File>,
        workspace_authorization: Option<WorkspaceReadAuthorization>,
    },
    Missing,
}

enum ResolvedDisk {
    Present {
        file: OpenFileResponse,
        file_identity: String,
        file_binding: Arc<fs::File>,
        workspace_authorization: Option<WorkspaceReadAuthorization>,
        reason: ActiveDocumentWatchReason,
        previous_path: Option<PathBuf>,
    },
    Missing,
}

#[derive(Clone, Copy)]
enum ScheduledReconcileMode {
    Event,
    MissingConfirmation { token: u64 },
}

fn protocol_id_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn validate_main_owner(owner: &str) -> Result<(), String> {
    if owner == "main" {
        Ok(())
    } else {
        Err("Only the main window can monitor the active document".to_string())
    }
}

fn validate_document_identity(document_id: &str, document_generation: u64) -> Result<(), String> {
    if !protocol_id_is_valid(document_id) || document_generation > MAX_SAFE_INTEGER {
        Err("Invalid active document monitoring identity".to_string())
    } else {
        Ok(())
    }
}

fn increment_safe(value: u64, label: &str) -> Result<u64, String> {
    let next = value
        .checked_add(1)
        .ok_or_else(|| format!("{label} space is exhausted"))?;
    if next > MAX_SAFE_INTEGER {
        return Err(format!("{label} space is exhausted"));
    }
    Ok(next)
}

fn stop_entry(mut entry: WatchEntry) {
    if let Some(mut handle) = entry.handle.take() {
        handle.stop();
    }
}

impl ActiveDocumentWatchState {
    fn lock(&self) -> Result<MutexGuard<'_, WatchState>, String> {
        self.inner
            .lock()
            .map_err(|_| "Active document monitoring state is unavailable".to_string())
    }

    fn lock_lane(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.reconcile_lane
            .lock()
            .map_err(|_| "Active document monitoring control lane is unavailable".to_string())
    }

    fn next_watch_id(state: &mut WatchState) -> Result<String, String> {
        let id = state.next_watch_id;
        state.next_watch_id = increment_safe(id, "Watch identifier")?;
        Ok(format!("watch-{id}"))
    }

    fn replace_pending(
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

    fn remove_if_current(&self, watch_id: &str) -> Option<WatchEntry> {
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

    fn attach_handle(
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

    fn finalize_registration(
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

    fn activate(
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
        Ok(true)
    }

    fn stop(&self, watch_id: &str) -> Result<bool, String> {
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

    fn note_native_hint(
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

    fn note_native_error(&self, app: &AppHandle, watch_id: &str) -> Result<(), String> {
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
        Ok(())
    }

    fn capture_scheduled_context(
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

    fn capture_command_context(
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

    fn mark_scheduled_stale(entry: &mut WatchEntry) -> bool {
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

    fn finish_scheduled(entry: &mut WatchEntry) -> bool {
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

    fn begin_missing_grace(entry: &mut WatchEntry) -> Result<u64, String> {
        if !entry.missing_pending {
            entry.missing_token =
                increment_safe(entry.missing_token, "Missing confirmation token")?;
            entry.missing_pending = true;
        }
        Ok(entry.missing_token)
    }

    fn cancel_missing_grace(entry: &mut WatchEntry) -> Result<(), String> {
        if entry.missing_pending {
            entry.missing_token =
                increment_safe(entry.missing_token, "Missing confirmation token")?;
            entry.missing_pending = false;
        }
        Ok(())
    }

    fn settle_snapshot(
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

    fn snapshot_content_matches(
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

    fn committed_write_matches(entry: &WatchEntry, resolved: &ResolvedDisk) -> bool {
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

    fn clear_committed_expectation(entry: &mut WatchEntry) -> Result<(), String> {
        if matches!(
            entry.write_expectation,
            AppWriteExpectation::Committed { .. }
        ) {
            entry.write_expectation = AppWriteExpectation::None;
            entry.write_epoch = increment_safe(entry.write_epoch, "Write epoch")?;
        }
        Ok(())
    }

    fn reconcile_command(
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

    fn apply_committed_version(&self, token: &AppWriteToken, version: &FileVersion) {
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

fn read_authorized_disk(state: &AppState, path: &Path) -> Result<DiskRead, String> {
    let normalized = ensure_authorized_watch_file_inner(state, path)?;
    match fs::metadata(&normalized) {
        Ok(metadata) if metadata.is_file() => {
            let opened = open_authorized_existing_file_inner(state, &normalized)?;
            let canonical = opened.path().to_path_buf();
            if canonical != normalized {
                return Err("Monitored file identity changed unexpectedly".to_string());
            }
            let workspace_authorization = opened.workspace_authorization().cloned();
            let (canonical, handle) = opened.into_parts();
            let file_identity = opened_file_platform_identity(&handle)
                .map_err(|_| "Monitored file identity could not be captured".to_string())?;
            let file_binding = Arc::new(
                handle
                    .try_clone()
                    .map_err(|_| "Monitored file binding could not be retained".to_string())?,
            );
            Ok(DiskRead::Present {
                file: open_authorized_file_response_from_handle(canonical, handle)?,
                file_identity,
                file_binding,
                workspace_authorization,
            })
        }
        Ok(_) => Err("Monitored path is no longer a regular file".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DiskRead::Missing),
        Err(_) => Err("Monitored file could not be inspected".to_string()),
    }
}

fn resolve_disk_state(
    state: &AppState,
    context: &ReconcileContext,
) -> Result<ResolvedDisk, String> {
    if let DiskRead::Present {
        file,
        file_identity,
        file_binding,
        workspace_authorization,
    } = read_authorized_disk(state, &context.path)?
    {
        return Ok(ResolvedDisk::Present {
            file,
            file_identity,
            file_binding,
            workspace_authorization,
            reason: ActiveDocumentWatchReason::Changed,
            previous_path: None,
        });
    }

    let mut authorized_candidates = Vec::<PathBuf>::new();
    for (old_path, candidate) in &context.rename_candidates {
        if old_path != &context.path {
            continue;
        }
        let Ok(canonical) = ensure_authorized_existing_file_inner(state, candidate) else {
            continue;
        };
        if canonical.parent() != Some(context.parent.as_path())
            || WorkspaceFileKind::classify(&canonical) != Some(context.file_kind)
        {
            continue;
        }
        if !authorized_candidates.contains(&canonical) {
            authorized_candidates.push(canonical);
        }
    }

    if authorized_candidates.len() == 1 {
        let new_path = authorized_candidates.pop().expect("one candidate exists");
        let (file, file_identity, file_binding, workspace_authorization) =
            match read_authorized_disk(state, &new_path)? {
                DiskRead::Present {
                    file,
                    file_identity,
                    file_binding,
                    workspace_authorization,
                } => (file, file_identity, file_binding, workspace_authorization),
                DiskRead::Missing => return Ok(ResolvedDisk::Missing),
            };
        return Ok(ResolvedDisk::Present {
            file,
            file_identity,
            file_binding,
            workspace_authorization,
            reason: ActiveDocumentWatchReason::Renamed,
            previous_path: Some(context.path.clone()),
        });
    }

    Ok(ResolvedDisk::Missing)
}

fn finalize_authorization_transition(
    state: &AppState,
    entry: &mut WatchEntry,
    resolved: &mut ResolvedDisk,
) -> Result<(), String> {
    match resolved {
        ResolvedDisk::Present {
            file,
            file_identity,
            file_binding,
            workspace_authorization,
            reason: ActiveDocumentWatchReason::Renamed,
            previous_path: Some(previous_path),
        } => {
            let new_path = PathBuf::from(&file.path);
            let expected_identity = entry
                .file_identity
                .as_deref()
                .ok_or_else(|| "Monitored file identity is unavailable".to_string())?;
            if !entry.file_binding.as_ref().is_some_and(|binding| {
                opened_file_platform_identity(binding)
                    .is_ok_and(|identity| identity == expected_identity)
            }) {
                return Err("Monitored file binding is unavailable".to_string());
            }
            if file_identity != expected_identity {
                return Err("Renamed document is not the monitored file".to_string());
            }
            let workspace_authorization = workspace_authorization.as_ref().ok_or_else(|| {
                "Renamed document is not bound to the authorized workspace".to_string()
            })?;
            relocate_authorized_path_prefix_with_workspace_authorization_inner(
                state,
                previous_path,
                &new_path,
                expected_identity,
                workspace_authorization,
            )?;
            entry.path = new_path;
            entry.file_binding = Some(file_binding.clone());
        }
        ResolvedDisk::Missing => {
            revoke_authorized_path_prefix_inner(state, &entry.path)?;
        }
        _ => {}
    }
    Ok(())
}

fn create_native_debouncer<F: DebounceEventHandler>(
    parent: &Path,
    event_handler: F,
) -> Result<NativeWatchHandle, String> {
    let mut debouncer = new_debouncer(DEBOUNCE_DURATION, None, event_handler)
        .map_err(|_| "Could not start monitoring this file".to_string())?;
    debouncer
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|_| "Could not start monitoring this file".to_string())?;
    Ok(NativeWatchHandle {
        debouncer: Some(debouncer),
    })
}

fn create_native_handle(
    app: AppHandle,
    watch_id: String,
    parent: &Path,
) -> Result<Box<dyn WatchHandlePort>, String> {
    let callback_watch_id = watch_id.clone();
    let handle = create_native_debouncer(parent, move |result: DebounceEventResult| {
        handle_native_watch_result(app.clone(), callback_watch_id.clone(), result);
    })?;
    Ok(Box::new(handle))
}

fn handle_native_watch_result(app: AppHandle, watch_id: String, result: DebounceEventResult) {
    let state = app.state::<AppState>();
    match result {
        Ok(events) => {
            let mut paths = Vec::new();
            let mut rename_candidates = Vec::new();
            let mut force_reconcile = false;
            for event in events {
                force_reconcile |= event.need_rescan();
                paths.extend(event.paths.iter().cloned());
                if matches!(
                    event.kind,
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both))
                ) && event.paths.len() >= 2
                {
                    rename_candidates.push((
                        event.paths[0].clone(),
                        event.paths[event.paths.len() - 1].clone(),
                    ));
                }
            }
            if state
                .active_document_watch()
                .note_native_hint(&watch_id, &paths, rename_candidates, force_reconcile)
                .unwrap_or(false)
            {
                spawn_scheduled_reconcile(app.clone(), watch_id, ScheduledReconcileMode::Event);
            }
        }
        Err(_) => {
            let _ = state
                .active_document_watch()
                .note_native_error(&app, &watch_id);
        }
    }
}

fn spawn_scheduled_reconcile(app: AppHandle, watch_id: String, mode: ScheduledReconcileMode) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-reconcile".to_string())
        .spawn(move || run_scheduled_reconcile(app, watch_id, mode));
}

fn schedule_missing_confirmation(app: AppHandle, watch_id: String, token: u64) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-missing-grace".to_string())
        .spawn(move || {
            thread::sleep(MISSING_GRACE);
            let state = app.state::<AppState>();
            let should_run = {
                let Ok(mut watch_state) = state.active_document_watch().lock() else {
                    return;
                };
                let Some(entry) = watch_state
                    .current
                    .as_mut()
                    .filter(|entry| entry.watch_id == watch_id)
                else {
                    return;
                };
                if !entry.missing_pending || entry.missing_token != token {
                    return;
                }
                if entry.reconcile_scheduled {
                    entry.reconcile_again = true;
                    false
                } else {
                    entry.reconcile_scheduled = true;
                    true
                }
            };
            if should_run {
                spawn_scheduled_reconcile(
                    app,
                    watch_id,
                    ScheduledReconcileMode::MissingConfirmation { token },
                );
            }
        });
}

fn run_scheduled_reconcile(app: AppHandle, watch_id: String, mode: ScheduledReconcileMode) {
    let state = app.state::<AppState>();
    let service = state.active_document_watch();
    let Ok(lane) = service.lock_lane() else {
        return;
    };
    let Ok(Some(context)) = service.capture_scheduled_context(&watch_id, mode) else {
        return;
    };
    let resolved = resolve_disk_state(&state, &context);
    let follow_up;
    let mut missing_timer = None;
    {
        let Ok(mut watch_state) = service.lock() else {
            return;
        };
        let Some(entry) = watch_state.current.as_mut().filter(|entry| {
            entry.watch_id == context.watch_id
                && entry.document_id == context.document_id
                && entry.document_generation == context.document_generation
        }) else {
            return;
        };
        if entry.write_epoch != context.write_epoch
            || matches!(entry.write_expectation, AppWriteExpectation::Writing { .. })
        {
            follow_up = ActiveDocumentWatchState::mark_scheduled_stale(entry);
        } else {
            match resolved {
                Err(_) => {
                    follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                }
                Ok(ResolvedDisk::Missing) if matches!(mode, ScheduledReconcileMode::Event) => {
                    if let Ok(token) = ActiveDocumentWatchState::begin_missing_grace(entry) {
                        missing_timer = Some(token);
                    }
                    follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                }
                Ok(mut resolved) => {
                    if matches!(resolved, ResolvedDisk::Present { .. }) {
                        let _ = ActiveDocumentWatchState::cancel_missing_grace(entry);
                    }
                    if finalize_authorization_transition(&state, entry, &mut resolved).is_err() {
                        follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                    } else {
                        let suppression_match =
                            ActiveDocumentWatchState::committed_write_matches(entry, &resolved);
                        let settled = ActiveDocumentWatchState::settle_snapshot(entry, &resolved);
                        if let Ok((snapshot, reason, previous_path)) = settled {
                            let duplicate = entry.last_snapshot.as_ref().is_some_and(|last| {
                                ActiveDocumentWatchState::snapshot_content_matches(last, &snapshot)
                            }) && !matches!(
                                entry.file_kind,
                                WorkspaceFileKind::Image
                                    | WorkspaceFileKind::Video
                                    | WorkspaceFileKind::Audio
                            );
                            let _ = ActiveDocumentWatchState::clear_committed_expectation(entry);
                            if suppression_match || duplicate {
                                if let ActiveDocumentDiskSnapshot::Present {
                                    preview_revision,
                                    ..
                                } = &snapshot
                                {
                                    entry.preview_revision = *preview_revision;
                                }
                                entry.last_snapshot = Some(snapshot);
                            } else {
                                if let ActiveDocumentDiskSnapshot::Present {
                                    preview_revision,
                                    ..
                                } = &snapshot
                                {
                                    entry.preview_revision = *preview_revision;
                                }
                                entry.sequence = increment_safe(entry.sequence, "Watch sequence")
                                    .unwrap_or(entry.sequence);
                                entry.last_snapshot = Some(snapshot.clone());
                                let event = ActiveDocumentWatchEvent {
                                    protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
                                    watch_id: entry.watch_id.clone(),
                                    document_id: entry.document_id.clone(),
                                    document_generation: entry.document_generation,
                                    sequence: entry.sequence,
                                    event: ActiveDocumentWatchEventPayload::State {
                                        reason,
                                        previous_path,
                                        snapshot,
                                    },
                                };
                                let _ = app.emit_to("main", ACTIVE_DOCUMENT_WATCH_EVENT, event);
                            }
                        }
                        follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                    }
                }
            }
        }
    }
    drop(lane);
    if let Some(token) = missing_timer {
        schedule_missing_confirmation(app.clone(), watch_id.clone(), token);
    }
    if follow_up {
        spawn_scheduled_reconcile(app, watch_id, ScheduledReconcileMode::Event);
    }
}

fn spawn_fallback_polling(app: AppHandle, watch_id: String, health_epoch: u64) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-watch-fallback".to_string())
        .spawn(move || {
            for _ in 0..DEGRADED_POLL_ATTEMPTS {
                thread::sleep(DEGRADED_POLL_INTERVAL);
                let state = app.state::<AppState>();
                let should_continue = {
                    let Ok(mut watch_state) = state.active_document_watch().lock() else {
                        return;
                    };
                    let Some(entry) = watch_state
                        .current
                        .as_mut()
                        .filter(|entry| entry.watch_id == watch_id)
                    else {
                        return;
                    };
                    if !entry.degraded || entry.health_epoch != health_epoch {
                        return;
                    }
                    if entry.reconcile_scheduled {
                        entry.reconcile_again = true;
                        false
                    } else {
                        entry.reconcile_scheduled = true;
                        true
                    }
                };
                if should_continue {
                    spawn_scheduled_reconcile(
                        app.clone(),
                        watch_id.clone(),
                        ScheduledReconcileMode::Event,
                    );
                }
            }

            let state = app.state::<AppState>();
            let stopped_handle = {
                let Ok(mut watch_state) = state.active_document_watch().lock() else {
                    return;
                };
                let Some(entry) = watch_state
                    .current
                    .as_mut()
                    .filter(|entry| entry.watch_id == watch_id)
                else {
                    return;
                };
                if !entry.degraded || entry.health_epoch != health_epoch {
                    return;
                }
                entry.sequence =
                    increment_safe(entry.sequence, "Watch sequence").unwrap_or(entry.sequence);
                let event = ActiveDocumentWatchEvent {
                    protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
                    watch_id: entry.watch_id.clone(),
                    document_id: entry.document_id.clone(),
                    document_generation: entry.document_generation,
                    sequence: entry.sequence,
                    event: ActiveDocumentWatchEventPayload::Health {
                        status: ActiveDocumentWatchHealthStatus::Failed,
                        message: "Monitoring stopped. Reopen the file to retry.".to_string(),
                    },
                };
                let _ = app.emit_to("main", ACTIVE_DOCUMENT_WATCH_EVENT, event);
                entry.handle.take()
            };
            if let Some(mut handle) = stopped_handle {
                handle.stop();
            }
        });
}

pub(crate) fn start_active_document_watch_inner(
    state: &AppState,
    app: &AppHandle,
    owner: &str,
    path: impl AsRef<Path>,
    document_id: String,
    document_generation: u64,
) -> Result<ActiveDocumentWatchRegistration, String> {
    validate_main_owner(owner)?;
    validate_document_identity(&document_id, document_generation)?;
    let canonical = ensure_authorized_existing_file_inner(state, path)?;
    let file_kind = WorkspaceFileKind::classify(&canonical)
        .ok_or_else(|| "The active file type cannot be monitored".to_string())?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "The active file has no parent directory".to_string())?
        .to_path_buf();
    let service = state.active_document_watch();
    let _lane = service.lock_lane()?;
    let (watch_id, previous) = service.replace_pending(
        document_id,
        document_generation,
        canonical.clone(),
        parent.clone(),
        file_kind,
    )?;
    if let Some(previous) = previous {
        stop_entry(previous);
    }
    let handle = match create_native_handle(app.clone(), watch_id.clone(), &parent) {
        Ok(handle) => handle,
        Err(error) => {
            if let Some(entry) = service.remove_if_current(&watch_id) {
                stop_entry(entry);
            }
            return Err(error);
        }
    };
    service.attach_handle(&watch_id, handle)?;
    let (snapshot, file_identity, file_binding) = match read_authorized_disk(state, &canonical) {
        Ok(DiskRead::Present {
            file,
            file_identity,
            file_binding,
            ..
        }) => (
            ActiveDocumentDiskSnapshot::Present {
                file,
                preview_revision: 1,
            },
            Some(file_identity),
            Some(file_binding),
        ),
        Ok(DiskRead::Missing) => (
            ActiveDocumentDiskSnapshot::Missing {
                path: canonical.to_string_lossy().to_string(),
            },
            None,
            None,
        ),
        Err(_) => {
            if let Some(entry) = service.remove_if_current(&watch_id) {
                stop_entry(entry);
            }
            return Err("Monitoring could not read the active file".to_string());
        }
    };
    service.finalize_registration(&watch_id, snapshot, file_identity, file_binding)
}

#[tauri::command]
pub(crate) fn start_active_document_watch(
    path: String,
    document_id: String,
    document_generation: u64,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ActiveDocumentWatchRegistration, String> {
    start_active_document_watch_inner(
        &state,
        &app,
        window.label(),
        path,
        document_id,
        document_generation,
    )
}

#[tauri::command]
pub(crate) fn activate_active_document_watch(
    watch_id: String,
    document_id: String,
    document_generation: u64,
    registration_sequence: u64,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    validate_main_owner(window.label())?;
    validate_document_identity(&document_id, document_generation)?;
    if registration_sequence > MAX_SAFE_INTEGER || !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().activate(
        &app,
        &watch_id,
        &document_id,
        document_generation,
        registration_sequence,
    )
}

#[tauri::command]
pub(crate) fn reconcile_active_document_watch(
    watch_id: String,
    document_id: String,
    document_generation: u64,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ActiveDocumentWatchSnapshotEnvelope, String> {
    validate_main_owner(window.label())?;
    validate_document_identity(&document_id, document_generation)?;
    if !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().reconcile_command(
        &state,
        &watch_id,
        &document_id,
        document_generation,
    )
}

#[tauri::command]
pub(crate) fn stop_active_document_watch(
    watch_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    validate_main_owner(window.label())?;
    if !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().stop(&watch_id)
}

#[cfg(test)]
impl ActiveDocumentWatchState {
    fn install_for_test(
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

    fn note_hint_for_test(&self, watch_id: &str) {
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

    fn activate_for_test(
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

    fn take_reconcile_request_for_test(&self, watch_id: &str) -> bool {
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

    fn stop_for_test(&self, watch_id: &str) -> bool {
        self.remove_if_current(watch_id).is_some()
    }

    fn begin_write_for_test(&self, path: &Path, expected_bytes: Vec<u8>) -> Option<u64> {
        self.begin_app_write(path, expected_bytes)
            .map(|token| token.write_epoch)
    }

    fn captured_write_epoch_for_test(&self, watch_id: &str) -> Option<u64> {
        self.inner
            .lock()
            .unwrap()
            .current
            .as_ref()
            .filter(|entry| entry.watch_id == watch_id)
            .map(|entry| entry.write_epoch)
    }

    fn settle_write_for_test(&self, committed: bool) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_save::{DocumentSaveCoordinator, DocumentSaveDisposition, MAIN_SAVE_OWNER},
        durable_write::capture_file_version,
        path_auth::{
            authorize_directory_root_inner, authorize_file_inner, authorize_workspace_file_inner,
            ensure_authorized_write_file_inner,
        },
        state::AppState,
        workspace_file_kind::{ContentMode, WorkspaceFileKind},
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
    };
    use tempfile::{tempdir, tempfile};

    struct CountingHandle(Arc<AtomicUsize>);

    impl WatchHandlePort for CountingHandle {
        fn stop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn installed_state() -> ActiveDocumentWatchState {
        let state = ActiveDocumentWatchState::default();
        state.install_for_test(
            "watch-1",
            "pane-document-1",
            7,
            PathBuf::from("/workspace/notes.md"),
        );
        state
    }

    fn reconcile_context(path: &Path, file_kind: WorkspaceFileKind) -> ReconcileContext {
        ReconcileContext {
            watch_id: "watch-1".to_string(),
            document_id: "pane-document-1".to_string(),
            document_generation: 7,
            path: path.to_path_buf(),
            parent: path.parent().unwrap().to_path_buf(),
            file_kind,
            write_epoch: 0,
            rename_candidates: Vec::new(),
        }
    }

    fn minimal_docx_zip() -> Vec<u8> {
        fn append_u16(bytes: &mut Vec<u8>, value: u16) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }

        fn append_u32(bytes: &mut Vec<u8>, value: u32) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }

        let name = b"[Content_Types].xml";
        let mut bytes = Vec::new();
        append_u32(&mut bytes, 0x0403_4b50);
        append_u16(&mut bytes, 20);
        for _ in 0..4 {
            append_u16(&mut bytes, 0);
        }
        for _ in 0..3 {
            append_u32(&mut bytes, 0);
        }
        append_u16(&mut bytes, name.len() as u16);
        append_u16(&mut bytes, 0);
        bytes.extend_from_slice(name);

        let central_offset = bytes.len() as u32;
        append_u32(&mut bytes, 0x0201_4b50);
        append_u16(&mut bytes, 20);
        append_u16(&mut bytes, 20);
        for _ in 0..4 {
            append_u16(&mut bytes, 0);
        }
        for _ in 0..3 {
            append_u32(&mut bytes, 0);
        }
        append_u16(&mut bytes, name.len() as u16);
        for _ in 0..4 {
            append_u16(&mut bytes, 0);
        }
        for _ in 0..2 {
            append_u32(&mut bytes, 0);
        }
        bytes.extend_from_slice(name);

        let central_size = bytes.len() as u32 - central_offset;
        append_u32(&mut bytes, 0x0605_4b50);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 1);
        append_u16(&mut bytes, 1);
        append_u32(&mut bytes, central_size);
        append_u32(&mut bytes, central_offset);
        append_u16(&mut bytes, 0);
        bytes
    }

    #[test]
    fn pending_registration_buffers_hint_and_activation_replays_it() {
        let state = installed_state();
        state.note_hint_for_test("watch-1");

        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
        assert!(state.take_reconcile_request_for_test("watch-1"));
        assert!(!state.take_reconcile_request_for_test("watch-1"));
    }

    #[test]
    fn activation_rejects_wrong_identity_and_registration_sequence() {
        let state = installed_state();

        assert!(!state.activate_for_test("watch-2", "pane-document-1", 7, 1));
        assert!(!state.activate_for_test("watch-1", "pane-document-2", 7, 1));
        assert!(!state.activate_for_test("watch-1", "pane-document-1", 8, 1));
        assert!(!state.activate_for_test("watch-1", "pane-document-1", 7, 2));
        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    }

    #[test]
    fn stale_stop_cannot_stop_the_current_watch() {
        let state = installed_state();

        assert!(!state.stop_for_test("watch-stale"));
        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    }

    #[test]
    fn write_epoch_invalidates_inflight_reconcile_and_requests_one_rerun() {
        let state = installed_state();
        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
        let captured_epoch = state.captured_write_epoch_for_test("watch-1").unwrap();

        let write_epoch = state
            .begin_write_for_test(
                PathBuf::from("/workspace/notes.md").as_path(),
                b"# Saved".to_vec(),
            )
            .unwrap();
        assert!(write_epoch > captured_epoch);
        state.note_hint_for_test("watch-1");

        assert!(state.settle_write_for_test(true));
        assert!(state.take_reconcile_request_for_test("watch-1"));
        assert!(!state.take_reconcile_request_for_test("watch-1"));
    }

    #[test]
    fn relevant_burst_coalesces_into_one_scheduled_reconcile_and_one_follow_up() {
        let state = installed_state();
        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
        let path = PathBuf::from("/workspace/notes.md");

        assert!(state
            .note_native_hint("watch-1", std::slice::from_ref(&path), Vec::new(), false)
            .unwrap());
        assert!(!state
            .note_native_hint("watch-1", std::slice::from_ref(&path), Vec::new(), false)
            .unwrap());
        assert!(!state
            .note_native_hint(
                "watch-1",
                &[PathBuf::from("/workspace/unrelated.md")],
                Vec::new(),
                false,
            )
            .unwrap());

        assert!(state
            .capture_scheduled_context("watch-1", ScheduledReconcileMode::Event)
            .unwrap()
            .is_some());
        let mut watch_state = state.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();
        assert!(ActiveDocumentWatchState::finish_scheduled(entry));
        assert!(entry.reconcile_scheduled);
        assert!(!entry.reconcile_again);
    }

    #[test]
    fn missing_grace_reuses_one_token_and_invalidates_it_when_presence_returns() {
        let state = installed_state();
        let mut watch_state = state.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();

        let first = ActiveDocumentWatchState::begin_missing_grace(entry).unwrap();
        let repeated = ActiveDocumentWatchState::begin_missing_grace(entry).unwrap();
        assert_eq!(repeated, first);
        assert!(entry.missing_pending);

        ActiveDocumentWatchState::cancel_missing_grace(entry).unwrap();
        assert!(!entry.missing_pending);
        assert!(entry.missing_token > first);
    }

    #[test]
    fn stop_all_stops_the_native_handle_once_and_is_idempotent() {
        let state = installed_state();
        let stop_count = Arc::new(AtomicUsize::new(0));
        state.lock().unwrap().current.as_mut().unwrap().handle =
            Some(Box::new(CountingHandle(stop_count.clone())));

        state.stop_all();
        state.stop_all();

        assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn tracked_present_path_outranks_rename_away_candidates() {
        let workspace = tempdir().unwrap();
        let active = workspace.path().join("notes.md");
        let backup = workspace.path().join("notes.backup.md");
        fs::write(&active, "final contents").unwrap();
        fs::write(&backup, "old contents").unwrap();
        let state = AppState::default();
        let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let active = fs::canonicalize(root.join("notes.md")).unwrap();
        let backup = fs::canonicalize(root.join("notes.backup.md")).unwrap();
        let mut context = reconcile_context(&active, WorkspaceFileKind::Markdown);
        context.rename_candidates.push((active.clone(), backup));

        match resolve_disk_state(&state, &context).unwrap() {
            ResolvedDisk::Present {
                file,
                reason,
                previous_path,
                ..
            } => {
                assert_eq!(file.path, active.to_string_lossy());
                assert_eq!(file.content.as_deref(), Some("final contents"));
                assert_eq!(reason, ActiveDocumentWatchReason::Changed);
                assert_eq!(previous_path, None);
            }
            ResolvedDisk::Missing => panic!("tracked path must win while present"),
        }
    }

    #[test]
    fn rename_follow_requires_one_authorized_candidate_with_the_exact_file_kind() {
        for (extension, file_kind) in [
            ("md", WorkspaceFileKind::Markdown),
            ("pdf", WorkspaceFileKind::Pdf),
            ("docx", WorkspaceFileKind::Docx),
        ] {
            let workspace = tempdir().unwrap();
            let state = AppState::default();
            let root =
                authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
            let old_path = root.join(format!("old.{extension}"));
            let new_path = root.join(format!("new.{extension}"));
            let bytes = if file_kind == WorkspaceFileKind::Docx {
                minimal_docx_zip()
            } else {
                b"replacement bytes".to_vec()
            };
            fs::write(&new_path, bytes).unwrap();
            let new_path = fs::canonicalize(new_path).unwrap();
            let mut context = reconcile_context(&old_path, file_kind);
            context
                .rename_candidates
                .push((old_path.clone(), new_path.clone()));
            context
                .rename_candidates
                .push((old_path.clone(), new_path.clone()));

            match resolve_disk_state(&state, &context).unwrap() {
                ResolvedDisk::Present {
                    file,
                    reason,
                    previous_path,
                    ..
                } => {
                    assert_eq!(file.path, new_path.to_string_lossy());
                    assert_eq!(reason, ActiveDocumentWatchReason::Renamed);
                    assert_eq!(previous_path, Some(old_path));
                }
                ResolvedDisk::Missing => panic!("one authorized same-kind rename must be followed"),
            }
        }
    }

    #[test]
    fn rename_follow_does_not_migrate_write_authority_to_a_replacement_target() {
        let workspace = tempdir().unwrap();
        let old_path = workspace.path().join("old.md");
        let new_path = workspace.path().join("new.md");
        let displaced = workspace.path().join("displaced.md");
        fs::write(&old_path, "authorized content").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        authorize_file_inner(&state, old_path.clone()).unwrap();
        let canonical_old = old_path.canonicalize().unwrap();
        let watch = ActiveDocumentWatchState::default();
        watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());
        fs::rename(&canonical_old, &new_path).unwrap();
        let canonical_new = new_path.canonicalize().unwrap();
        let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
        context
            .rename_candidates
            .push((canonical_old.clone(), canonical_new.clone()));
        let mut resolved = resolve_disk_state(&state, &context).unwrap();

        fs::rename(&canonical_new, &displaced).unwrap();
        fs::write(&canonical_new, "replacement content").unwrap();
        let mut watch_state = watch.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();

        assert!(finalize_authorization_transition(&state, entry, &mut resolved).is_err());
        assert_eq!(entry.path, canonical_old);
        assert!(ensure_authorized_write_file_inner(&state, &canonical_new).is_err());
    }

    #[test]
    fn rename_follow_rejects_a_candidate_replaced_before_it_is_read() {
        let workspace = tempdir().unwrap();
        let old_path = workspace.path().join("old.md");
        let new_path = workspace.path().join("new.md");
        let displaced = workspace.path().join("displaced.md");
        fs::write(&old_path, "authorized content").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        authorize_file_inner(&state, old_path.clone()).unwrap();
        let canonical_old = old_path.canonicalize().unwrap();
        let watch = ActiveDocumentWatchState::default();
        watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());

        fs::rename(&canonical_old, &new_path).unwrap();
        fs::rename(&new_path, &displaced).unwrap();
        fs::write(&new_path, "replacement content").unwrap();
        let canonical_new = new_path.canonicalize().unwrap();
        let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
        context
            .rename_candidates
            .push((canonical_old.clone(), canonical_new.clone()));
        let mut resolved = resolve_disk_state(&state, &context).unwrap();
        let mut watch_state = watch.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();

        assert!(finalize_authorization_transition(&state, entry, &mut resolved).is_err());
        assert_eq!(entry.path, canonical_old);
        assert!(ensure_authorized_write_file_inner(&state, &canonical_new).is_err());
    }

    #[test]
    fn rename_follow_migrates_write_authority_when_the_target_identity_is_unchanged() {
        let workspace = tempdir().unwrap();
        let old_path = workspace.path().join("old.md");
        let new_path = workspace.path().join("new.md");
        fs::write(&old_path, "authorized content").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        authorize_file_inner(&state, old_path.clone()).unwrap();
        let canonical_old = old_path.canonicalize().unwrap();
        let watch = ActiveDocumentWatchState::default();
        watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());
        fs::rename(&canonical_old, &new_path).unwrap();
        let canonical_new = new_path.canonicalize().unwrap();
        let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
        context
            .rename_candidates
            .push((canonical_old.clone(), canonical_new.clone()));
        let mut resolved = resolve_disk_state(&state, &context).unwrap();
        let mut watch_state = watch.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();

        finalize_authorization_transition(&state, entry, &mut resolved).unwrap();

        assert_eq!(entry.path, canonical_new);
        assert!(ensure_authorized_write_file_inner(&state, &entry.path).is_ok());
        assert!(ensure_authorized_write_file_inner(&state, &canonical_old).is_err());
    }

    #[test]
    fn committed_save_binding_survives_an_immediate_rename_before_watch_settlement() {
        let workspace = tempdir().unwrap();
        let old_path = workspace.path().join("old.md");
        let new_path = workspace.path().join("new.md");
        fs::write(&old_path, "old content").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        authorize_workspace_file_inner(&state, &old_path).unwrap();
        let canonical_old = old_path.canonicalize().unwrap();
        let watch = ActiveDocumentWatchState::default();
        watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());
        assert!(watch.activate_for_test("watch-1", "pane-document-1", 7, 1));
        let token = watch
            .begin_app_write(&canonical_old, b"saved content".to_vec())
            .unwrap();
        let expected = capture_file_version(&canonical_old).unwrap().unwrap();
        let outcome = DocumentSaveCoordinator::default()
            .save_expected(
                state.file_authorization(),
                &canonical_old,
                b"saved content",
                expected,
                "save-before-rename",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        let DocumentSaveDisposition::ConfirmedCommitted { version, .. } = outcome else {
            panic!("save must commit");
        };

        fs::rename(&canonical_old, &new_path).unwrap();
        let canonical_new = new_path.canonicalize().unwrap();
        watch.apply_committed_version(&token, &version);
        watch.settle_app_write(token, true);
        let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
        context
            .rename_candidates
            .push((canonical_old.clone(), canonical_new.clone()));
        let mut resolved = resolve_disk_state(&state, &context).unwrap();
        let mut watch_state = watch.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();

        finalize_authorization_transition(&state, entry, &mut resolved).unwrap();

        assert_eq!(entry.path, canonical_new);
        assert!(ensure_authorized_write_file_inner(&state, &entry.path).is_ok());
        assert!(ensure_authorized_write_file_inner(&state, &canonical_old).is_err());
    }

    #[test]
    fn ambiguous_or_incompatible_rename_candidates_become_missing() {
        let workspace = tempdir().unwrap();
        let state = AppState::default();
        let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let old_path = root.join("old.md");
        let first = root.join("first.md");
        let second = root.join("second.md");
        let html = root.join("new.html");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();
        fs::write(&html, "<p>html</p>").unwrap();
        let first = fs::canonicalize(first).unwrap();
        let second = fs::canonicalize(second).unwrap();
        let html = fs::canonicalize(html).unwrap();

        let mut ambiguous = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
        ambiguous.rename_candidates = vec![(old_path.clone(), first), (old_path.clone(), second)];
        assert!(matches!(
            resolve_disk_state(&state, &ambiguous).unwrap(),
            ResolvedDisk::Missing
        ));

        let mut incompatible = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
        incompatible.rename_candidates = vec![(old_path, html)];
        assert!(matches!(
            resolve_disk_state(&state, &incompatible).unwrap(),
            ResolvedDisk::Missing
        ));
    }

    #[test]
    fn unauthorized_rename_destination_is_not_followed() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let state = AppState::default();
        let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let old_path = root.join("old.md");
        let outside_path = outside.path().join("outside.md");
        fs::write(&outside_path, "outside").unwrap();
        let outside_path = fs::canonicalize(outside_path).unwrap();
        let mut context = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
        context.rename_candidates = vec![(old_path, outside_path)];

        assert!(matches!(
            resolve_disk_state(&state, &context).unwrap(),
            ResolvedDisk::Missing
        ));
    }

    #[test]
    fn committed_write_suppression_requires_exact_path_and_bytes_and_is_cleared() {
        let state = installed_state();
        assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
        let path = PathBuf::from("/workspace/notes.md");
        let token = state.begin_app_write(&path, b"# Saved".to_vec()).unwrap();
        assert!(state.settle_app_write(token, true).is_none());

        let matching = ResolvedDisk::Present {
            file: OpenFileResponse {
                kind: WorkspaceFileKind::Markdown,
                path: path.to_string_lossy().to_string(),
                content_mode: ContentMode::Text,
                file_version: None,
                content: Some("# Saved".to_string()),
                mime_type: None,
                bytes_base64: None,
            },
            file_identity: "matching-identity".to_string(),
            file_binding: Arc::new(tempfile().unwrap()),
            workspace_authorization: None,
            reason: ActiveDocumentWatchReason::Changed,
            previous_path: None,
        };
        let different_bytes = ResolvedDisk::Present {
            file: OpenFileResponse {
                kind: WorkspaceFileKind::Markdown,
                path: path.to_string_lossy().to_string(),
                content_mode: ContentMode::Text,
                file_version: None,
                content: Some("# External".to_string()),
                mime_type: None,
                bytes_base64: None,
            },
            file_identity: "different-identity".to_string(),
            file_binding: Arc::new(tempfile().unwrap()),
            workspace_authorization: None,
            reason: ActiveDocumentWatchReason::Changed,
            previous_path: None,
        };

        let mut watch_state = state.lock().unwrap();
        let entry = watch_state.current.as_mut().unwrap();
        assert!(ActiveDocumentWatchState::committed_write_matches(
            entry, &matching
        ));
        assert!(!ActiveDocumentWatchState::committed_write_matches(
            entry,
            &different_bytes,
        ));
        let prior_epoch = entry.write_epoch;
        ActiveDocumentWatchState::clear_committed_expectation(entry).unwrap();
        assert!(entry.write_epoch > prior_epoch);
        assert!(!ActiveDocumentWatchState::committed_write_matches(
            entry, &matching
        ));
    }

    #[test]
    #[ignore = "requires MMD_RUN_NATIVE_WATCH_TESTS=1 and a native filesystem watcher"]
    fn native_parent_watcher_reports_same_path_changes_and_stops() {
        assert_eq!(
            std::env::var("MMD_RUN_NATIVE_WATCH_TESTS").as_deref(),
            Ok("1"),
            "set MMD_RUN_NATIVE_WATCH_TESTS=1 before running ignored native watcher tests",
        );
        let workspace = tempdir().unwrap();
        let canonical_workspace = fs::canonicalize(workspace.path()).unwrap();
        let active = canonical_workspace.join("notes.md");
        fs::write(&active, "before").unwrap();
        let active = fs::canonicalize(active).unwrap();
        let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
        let mut handle = create_native_debouncer(&canonical_workspace, sender).unwrap();

        fs::write(&active, "after").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let observed = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "native watcher did not report the active path"
            );
            match receiver.recv_timeout(remaining) {
                Ok(Ok(events)) => {
                    if events
                        .iter()
                        .any(|event| event.paths.iter().any(|path| path == &active))
                    {
                        break true;
                    }
                }
                Ok(Err(errors)) => panic!("native watcher returned errors: {errors:?}"),
                Err(error) => panic!("native watcher timed out: {error}"),
            }
        };

        assert!(observed);
        handle.stop();
    }

    #[test]
    fn command_identity_limits_match_the_frontend_decoder() {
        assert!(protocol_id_is_valid("watch-1"));
        assert!(!protocol_id_is_valid(""));
        assert!(!protocol_id_is_valid(&"x".repeat(129)));
        assert!(!protocol_id_is_valid("watch id"));
        assert_eq!(MAX_SAFE_INTEGER, 9_007_199_254_740_991);
    }

    #[test]
    fn non_main_owner_is_rejected_before_watch_work() {
        assert!(validate_main_owner("main").is_ok());
        assert!(validate_main_owner("preview-popout").is_err());
    }
}
