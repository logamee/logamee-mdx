pub(crate) use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

pub(crate) use notify::{
    event::{ModifyKind, RenameMode},
    EventKind, RecursiveMode,
};
pub(crate) use notify_debouncer_full::{
    new_debouncer, DebounceEventHandler, DebounceEventResult, Debouncer, RecommendedCache,
};
pub(crate) use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub(crate) use crate::{
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


mod commands;
mod disk;
mod events;
mod fallback;
mod native;
mod registration;
mod settle;

pub(crate) use commands::*;

#[cfg(test)]
mod test_prelude;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod start_tests;
#[cfg(test)]
mod snapshot_tests;
#[cfg(test)]
mod reconcile_tests;
