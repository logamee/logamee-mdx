use std::{fs, path::Path, sync::Arc};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::{
    commands::allow_asset_preview_directory,
    models::{PreparedOpenFileResponse, WorkspaceSessionRestore, WorkspaceSnapshot},
    open_intent::{OpenIntentCoordinator, OpenIntentSource},
    path_auth::PreparedWorkspaceSettlement,
    state::AppState,
};

#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::packaged_open_e2e::{
    authorization_state_locked, observe_backend_prepared, observe_backend_rejected,
    observe_focus_requested, observe_intent_discarded, observe_receipt_settlement,
};

pub(crate) const OPEN_INTENT_PENDING_EVENT: &str = "mmd:open-intent-pending";
pub(crate) const OPEN_INTENT_FOCUS_EVENT: &str = "mmd:open-intent-focus";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenIntentPreviewResponse {
    id: String,
    source: &'static str,
    display_path: String,
    target_kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ResolvedOpenIntentResponse {
    File {
        prepared: PreparedOpenFileResponse,
    },
    Directory {
        workspace: WorkspaceSnapshot,
        workspace_open_receipt: String,
    },
    SessionRestore {
        restore: Option<WorkspaceSessionRestore>,
        workspace_open_receipt: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceOpenSettlementResponse {
    Applied,
    Discarded,
    Expired,
    Unknown,
}

#[cfg(feature = "packaged-lifecycle-e2e")]
struct PreparedResolutionEvidence<'a> {
    target: &'a str,
    target_kind: &'static str,
    receipts: Vec<(&'static str, &'a str, &'a str)>,
}


mod resolution;
mod resolve_core;

#[cfg(feature = "packaged-lifecycle-e2e")]
use resolution::prepared_resolution_evidence;
#[cfg(test)]
pub(crate) use resolution::prepare_session_restore_inner;
pub(crate) use resolution::{ResolvedOpenIntentInner, peek_open_intent_inner, resolve_open_intent_with_ports_inner, discard_open_intent_inner, prepare_directory_open_inner, resolve_session_restore_response};

pub(crate) fn source_wire_value(source: OpenIntentSource) -> &'static str {
    match source {
        OpenIntentSource::StartupArguments => "startup_args",
        OpenIntentSource::SecondaryInstance => "secondary_instance",
        OpenIntentSource::OpenedEvent => "opened_event",
        OpenIntentSource::DragDrop => "drag_drop",
        OpenIntentSource::SessionRestore => "session_restore",
    }
}

pub(crate) fn validate_main_owner(owner: &str) -> Result<(), String> {
    if owner == "main" {
        Ok(())
    } else {
        Err("Only the main window can process application open requests".to_string())
    }
}

fn request_session_restore_inner(
    coordinator: &OpenIntentCoordinator,
    owner: &str,
) -> Result<bool, String> {
    validate_main_owner(owner)?;
    if should_skip_session_restore(
        coordinator.has_explicit_open_request(),
        packaged_open_e2e_challenge_active(),
    ) {
        return Ok(false);
    }
    let result = coordinator.enqueue_session_restore();
    #[cfg(feature = "packaged-lifecycle-e2e")]
    crate::packaged_open_e2e::observe_enqueue(coordinator, &result);
    result.map(|_| true).map_err(|_| {
        "Too many files are waiting to be opened. Finish the current request and try again."
            .to_string()
    })
}

pub(crate) fn packaged_open_e2e_challenge_active() -> bool {
    cfg!(feature = "packaged-lifecycle-e2e")
        && std::env::var_os("MMD_PACKAGED_OPEN_E2E_CHALLENGE").is_some()
}

pub(crate) fn should_skip_session_restore(has_explicit_open_request: bool, packaged_open_e2e: bool) -> bool {
    has_explicit_open_request && !packaged_open_e2e
}

#[tauri::command]
pub(crate) fn request_session_restore(
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<bool, String> {
    request_session_restore_inner(&coordinator, window.label())
}

#[tauri::command]
pub(crate) fn focus_main_window(
    intent_id: Option<String>,
    coalesced: Option<bool>,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<(), String> {
    validate_main_owner(window.label())?;
    window
        .show()
        .map_err(|error| format!("Cannot show the main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Cannot focus the main window: {error}"))?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if let Some(intent_id) =
        intent_id.or_else(|| coordinator.peek_head().map(|head| head.id().to_wire()))
    {
        observe_focus_requested(&intent_id, coalesced.unwrap_or(false));
    }
    #[cfg(not(feature = "packaged-lifecycle-e2e"))]
    let _ = (intent_id, coalesced, coordinator);
    Ok(())
}

pub(crate) fn preview_target_kind(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => "unknown",
        Ok(metadata) if metadata.is_file() => "file",
        Ok(metadata) if metadata.is_dir() => "directory",
        _ => "unknown",
    }
}


#[tauri::command]
pub(crate) fn peek_open_intent(
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<Option<OpenIntentPreviewResponse>, String> {
    validate_main_owner(window.label())?;
    Ok(peek_open_intent_inner(&coordinator))
}

#[tauri::command]
pub(crate) fn resolve_open_intent(
    intent_id: String,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
    state: State<'_, AppState>,
) -> Result<ResolvedOpenIntentResponse, String> {
    let owner = window.label().to_string();
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let _evidence_guard = state.packaged_evidence_lock()?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state_locked(&state)?;
    let result =
        resolve_core::resolve_open_intent_prepared(&coordinator, &state, &owner, &intent_id);
    #[cfg(feature = "packaged-lifecycle-e2e")]
    {
        let evidence_after = authorization_state_locked(&state)?;
        match &result {
            Ok(response) => {
                let evidence = prepared_resolution_evidence(response);
                observe_backend_prepared(
                    &intent_id,
                    evidence.target,
                    evidence.target_kind,
                    &evidence.receipts,
                    &evidence_before,
                    &evidence_after,
                );
            }
            Err(error) => {
                observe_backend_rejected(&intent_id, error, &evidence_before, &evidence_after)
            }
        }
    }
    result
}

#[tauri::command]
pub(crate) fn settle_open_intent_workspace(
    workspace_open_receipt: String,
    applied: bool,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<WorkspaceOpenSettlementResponse, String> {
    validate_main_owner(window.label())?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let _evidence_guard = state.packaged_evidence_lock()?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state_locked(&state)?;
    let settlement = state.file_authorization().settle_workspace_authorization(
        window.label(),
        &workspace_open_receipt,
        applied,
        |root| allow_asset_preview_directory(&app, root),
    );
    #[cfg(feature = "packaged-lifecycle-e2e")]
    {
        let evidence_after = authorization_state_locked(&state)?;
        observe_receipt_settlement(
            &workspace_open_receipt,
            match &settlement {
                Ok(PreparedWorkspaceSettlement::Applied) => "applied",
                Ok(PreparedWorkspaceSettlement::Discarded) => "discarded",
                Ok(PreparedWorkspaceSettlement::Expired) => "expired",
                Ok(PreparedWorkspaceSettlement::Unknown) => "unknown",
                Err(_) => "failed",
            },
            &evidence_before,
            &evidence_after,
        );
    }
    let settlement = settlement?;
    if settlement == PreparedWorkspaceSettlement::Applied {
        state.workspace_index().discard_all();
    }
    Ok(match settlement {
        PreparedWorkspaceSettlement::Applied => WorkspaceOpenSettlementResponse::Applied,
        PreparedWorkspaceSettlement::Discarded => WorkspaceOpenSettlementResponse::Discarded,
        PreparedWorkspaceSettlement::Expired => WorkspaceOpenSettlementResponse::Expired,
        PreparedWorkspaceSettlement::Unknown => WorkspaceOpenSettlementResponse::Unknown,
    })
}

#[tauri::command]
pub(crate) fn discard_open_intent(
    intent_id: String,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<bool, String> {
    let discarded = discard_open_intent_inner(&coordinator, window.label(), &intent_id)?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if discarded {
        observe_intent_discarded(&intent_id);
    }
    Ok(discarded)
}


#[cfg(test)]
mod resolve_tests;
#[cfg(test)]
mod tests;
