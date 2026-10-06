use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use crate::private_fs::lowercase_hex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{State, WebviewWindow};

use crate::{
    open_intent::{
        OpenIntentCoordinator, OpenIntentEnqueueOutcome, OpenIntentPreviewTarget, OpenIntentSource,
    },
    path_auth::{AuthorizationEvidenceGrant, AuthorizationEvidenceSnapshot},
    state::AppState,
};

const GATE: &str = "packaged-native-open-e2e";
const SCHEMA: u32 = 2;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

static OBSERVER: OnceLock<Option<PackagedOpenObserver>> = OnceLock::new();


#[cfg(test)]
mod observer_tests;
mod observer;
mod records;
mod settlement_records;
#[cfg(test)]
mod tests;
mod types;

use types::{
    AuthorizationDelta, ControlFile, ObserverState, PackagedOpenPaths, ReceiptBinding,
};
pub(crate) use types::{
    authorization_state_locked, EvidenceAuthorizationState, PackagedOpenAppEventRequest,
    PackagedOpenConfigResponse, PackagedOpenObserver,
};
#[cfg(test)]
pub(crate) use types::authorization_state;

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn required_env(name: &str) -> Result<String, String> {
    optional_env(name).ok_or_else(|| format!("Packaged open E2E requires {name}"))
}

fn source_wire(source: OpenIntentSource) -> &'static str {
    match source {
        OpenIntentSource::StartupArguments => "startup_args",
        OpenIntentSource::SecondaryInstance => "secondary_instance",
        OpenIntentSource::OpenedEvent => "opened_event",
        OpenIntentSource::DragDrop => "drag_drop",
        OpenIntentSource::SessionRestore => "session_restore",
    }
}

fn sha256(value: &str) -> String {
    lowercase_hex(&Sha256::digest(value.as_bytes()))
}

#[cfg(any(windows, test))]
const WINDOWS_VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];

#[cfg(any(windows, test))]
fn windows_verbatim_drive_root_matches(root: &[u16], canonical: &[u16]) -> bool {
    const BACKSLASH: u16 = b'\\' as u16;

    let absolute_drive = root.first().copied().is_some_and(|value| {
        (b'A' as u16..=b'Z' as u16).contains(&value) || (b'a' as u16..=b'z' as u16).contains(&value)
    }) && root.get(1) == Some(&(b':' as u16))
        && root.get(2) == Some(&BACKSLASH);
    absolute_drive
        && canonical
            .strip_prefix(&WINDOWS_VERBATIM_PREFIX)
            .is_some_and(|remainder| remainder == root)
}

fn canonical_challenge_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("Cannot canonicalize packaged open challenge: {error}"))?;
    if canonical == root {
        return Ok(root.to_path_buf());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        let root_wide = root.as_os_str().encode_wide().collect::<Vec<_>>();
        let canonical_wide = canonical.as_os_str().encode_wide().collect::<Vec<_>>();
        if windows_verbatim_drive_root_matches(&root_wide, &canonical_wide) {
            return Ok(root.to_path_buf());
        }
    }
    Err("Packaged open E2E challenge root is not canonical".to_string())
}

fn observer() -> Option<&'static PackagedOpenObserver> {
    OBSERVER
        .get_or_init(|| PackagedOpenObserver::from_environment().unwrap_or(None))
        .as_ref()
}

pub(crate) fn initialize() {
    let Some(observer) = observer() else {
        return;
    };
    let observer: &'static PackagedOpenObserver = observer;
    thread::spawn(move || loop {
        match observer.try_finalize() {
            Ok(true) => break,
            Ok(false) => thread::sleep(POLL_INTERVAL),
            Err(error) => {
                observer.write_failure(&error);
                break;
            }
        }
    });
}

pub(crate) fn observe_enqueue(
    coordinator: &OpenIntentCoordinator,
    result: &Result<OpenIntentEnqueueOutcome, crate::open_intent::OpenIntentEnqueueError>,
) {
    if let Some(observer) = observer() {
        observer.record_enqueue(coordinator, result);
    }
}

pub(crate) fn observe_backend_prepared(
    intent_id: &str,
    target: &str,
    target_kind: &str,
    receipts: &[(&str, &str, &str)],
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_backend_prepared(intent_id, target, target_kind, receipts, before, after);
    }
}

pub(crate) fn observe_backend_rejected(
    intent_id: &str,
    reason: &str,
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_backend_rejected(intent_id, reason, before, after);
    }
}

pub(crate) fn observe_receipt_settlement(
    receipt: &str,
    settlement: &str,
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_receipt_settlement(receipt, settlement, before, after);
    }
}

pub(crate) fn observe_workspace_published(
    intent_id: &str,
    target: &str,
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_workspace_published(intent_id, target, before, after);
    }
}

pub(crate) fn observe_focus_requested(intent_id: &str, coalesced: bool) {
    if let Some(observer) = observer() {
        observer.record_focus_requested(
            intent_id,
            if coalesced {
                "focus_reasserted"
            } else {
                "focus_requested"
            },
        );
    }
}

pub(crate) fn observe_intent_discarded(intent_id: &str) {
    if let Some(observer) = observer() {
        observer.record_intent_discarded(intent_id);
    }
}

#[tauri::command]
pub(crate) fn get_packaged_open_e2e_config(
    window: WebviewWindow,
) -> Result<Option<PackagedOpenConfigResponse>, String> {
    if window.label() != "main" {
        return Err("Only the main window can inspect packaged open evidence".to_string());
    }
    Ok(observer().map(PackagedOpenObserver::config))
}

#[tauri::command]
pub(crate) fn record_packaged_open_app_event(
    event: PackagedOpenAppEventRequest,
    window: WebviewWindow,
    coordinator: State<'_, std::sync::Arc<OpenIntentCoordinator>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can record packaged open evidence".to_string());
    }
    let Some(observer) = observer() else {
        return Ok(());
    };
    let _evidence_guard = state.packaged_evidence_lock()?;
    let authorization = authorization_state_locked(&state)?;
    observer.record_app_event(event, coordinator.peek_head().is_none(), &authorization)
}
