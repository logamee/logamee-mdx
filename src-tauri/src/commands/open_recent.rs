use std::path::Path;

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::models::{
    OpenCommitResult, OpenCommitStatus, OpenFileResponse, PreparedOpenFileResponse,
    RecentFilesSnapshot,
};
use crate::native_menu;
use crate::path_auth::{normalize_existing_path, open_authorized_existing_file_with_before_open_inner};
#[cfg(test)]
use crate::path_auth::{authorize_workspace_file_inner, open_authorized_existing_file_inner};
use crate::state::AppState;
#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::packaged_open_e2e::{authorization_state_locked, observe_receipt_settlement};
use crate::workspace_file_kind::WorkspaceFileKind;

use super::emit_app_feedback_error;
use super::{allow_asset_preview_file_with_retry, open_authorized_file_response, open_authorized_file_response_from_handle};

pub(crate) const RECENT_MENU_SYNC_ERROR: &str = "Recent files menu synchronization failed";

pub(crate) fn refresh_recent_menu_with_retry(
    snapshot: &RecentFilesSnapshot,
    reload: impl FnOnce() -> Result<RecentFilesSnapshot, String>,
    mut refresh: impl FnMut(&RecentFilesSnapshot) -> Result<(), String>,
) -> Result<(), String> {
    if refresh(snapshot).is_ok() {
        return Ok(());
    }
    let reloaded = reload().map_err(|_| RECENT_MENU_SYNC_ERROR.to_string())?;
    refresh(&reloaded).map_err(|_| RECENT_MENU_SYNC_ERROR.to_string())
}

fn converge_recent_menu(app: &AppHandle, state: &AppState, snapshot: &RecentFilesSnapshot) {
    state.set_native_recent_files(snapshot.clone());
    if let Err(error) = refresh_recent_menu_with_retry(
        snapshot,
        || state.recent_files()?.list(),
        |recent_files| {
            state.set_native_recent_files(recent_files.clone());
            native_menu::refresh_app_menu(app, &state.native_menu_state())
                .map_err(|error| error.to_string())
        },
    ) {
        emit_app_feedback_error(app, error);
    }
}


#[cfg(test)]
pub(crate) fn open_standalone_file_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    response: impl FnOnce(&Path) -> Result<OpenFileResponse, String>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<OpenFileResponse, String> {
    let (_, response) = state
        .file_authorization()
        .open_standalone_file(path, response, transport)?;
    Ok(response)
}

pub(crate) fn prepare_standalone_file_with_ports_inner(
    state: &AppState,
    owner_window: &str,
    path: impl AsRef<Path>,
    response: impl FnOnce(&Path) -> Result<OpenFileResponse, String>,
) -> Result<PreparedOpenFileResponse, String> {
    let file = normalize_existing_path(path)?;
    if !file.is_file() {
        return Err("Selected path is not a file".to_string());
    }
    let response = response(&file)?;
    let identifiers = state.recent_files()?.issue_open(owner_window, &file)?;
    Ok(PreparedOpenFileResponse {
        file: response,
        open_receipt: identifiers.open_receipt,
        commit_operation_id: identifiers.commit_operation_id,
    })
}

pub(crate) fn prepare_workspace_file_inner(
    state: &AppState,
    owner_window: &str,
    path: impl AsRef<Path>,
) -> Result<PreparedOpenFileResponse, String> {
    prepare_workspace_file_with_before_open_inner(state, owner_window, path, || {})
}

pub(crate) fn prepare_workspace_file_with_before_open_inner(
    state: &AppState,
    owner_window: &str,
    path: impl AsRef<Path>,
    before_open: impl FnOnce(),
) -> Result<PreparedOpenFileResponse, String> {
    let opened = open_authorized_existing_file_with_before_open_inner(state, path, before_open)?;
    let workspace_authorization = opened.workspace_authorization().cloned();
    let (file, handle) = opened.into_parts();
    let response = open_authorized_file_response_from_handle(file.clone(), handle)?;
    let recent_files = state.recent_files()?;
    let identifiers = if let Some(authorization) = &workspace_authorization {
        recent_files.issue_workspace_open(owner_window, authorization)?
    } else {
        recent_files.issue_open(owner_window, &file)?
    };
    Ok(PreparedOpenFileResponse {
        file: response,
        open_receipt: identifiers.open_receipt,
        commit_operation_id: identifiers.commit_operation_id,
    })
}

#[cfg(test)]
pub(crate) fn open_workspace_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<OpenFileResponse, String> {
    let opened = open_authorized_existing_file_inner(state, path)?;
    let file = opened.path().to_path_buf();
    if WorkspaceFileKind::classify(&file).is_none() {
        return Err("Workspace file is not a supported preview file".into());
    }
    let (file, handle) = opened.into_parts();
    let response = open_authorized_file_response_from_handle(file.clone(), handle)?;
    authorize_workspace_file_inner(state, &file)?;
    Ok(response)
}

#[tauri::command]
pub(crate) async fn open_file_dialog(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PreparedOpenFileResponse>, String> {
    let extensions = WorkspaceFileKind::all_extensions();
    let selected = app
        .dialog()
        .file()
        .add_filter("Documents and media", &extensions)
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|err| format!("Invalid selected file path: {err}"))?;
    prepare_standalone_file_with_ports_inner(&state, window.label(), path, |file| {
        open_authorized_file_response(file.to_path_buf())
    })
    .map(Some)
}

#[tauri::command]
pub(crate) fn open_workspace_file(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PreparedOpenFileResponse, String> {
    prepare_workspace_file_inner(&state, window.label(), path)
}

#[tauri::command]
pub(crate) fn open_recent_file(
    entry_id: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PreparedOpenFileResponse, String> {
    let prepared = state
        .recent_files()?
        .prepare_recent_open(window.label(), &entry_id, |path| {
            open_authorized_file_response(path.to_path_buf())
        });
    let (file, identifiers) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Ok(snapshot) = state.recent_files()?.list() {
                converge_recent_menu(&app, &state, &snapshot);
            } else {
                emit_app_feedback_error(&app, RECENT_MENU_SYNC_ERROR);
            }
            return Err(error);
        }
    };
    Ok(PreparedOpenFileResponse {
        file,
        open_receipt: identifiers.open_receipt,
        commit_operation_id: identifiers.commit_operation_id,
    })
}

#[tauri::command]
pub(crate) fn commit_recent_open(
    open_receipt: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<OpenCommitResult, String> {
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let _evidence_guard = state.packaged_evidence_lock()?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state_locked(&state)?;
    let mut asset_scope_error = None;
    let result = state.recent_files()?.commit_open_with_post_commit(
        &open_receipt,
        window.label(),
        state.file_authorization(),
        |file| {
            asset_scope_error = allow_asset_preview_file_with_retry(&app, file).err();
        },
    );
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if let Ok(outcome) = &result {
        let evidence_after = authorization_state_locked(&state)?;
        observe_receipt_settlement(
            &open_receipt,
            match outcome {
                OpenCommitResult::Committed { .. } => "committed",
                OpenCommitResult::NotCommitted { .. } => "not_committed",
            },
            &evidence_before,
            &evidence_after,
        );
    }
    let result = result?;
    if let Some(error) = asset_scope_error {
        emit_app_feedback_error(&app, error);
    }
    if let OpenCommitResult::Committed { recent_files } = &result {
        converge_recent_menu(&app, &state, recent_files);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn get_open_commit_status(
    commit_operation_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<OpenCommitStatus, String> {
    state
        .recent_files()?
        .status(window.label(), &commit_operation_id)
}

#[tauri::command]
pub(crate) fn discard_open_receipt(
    open_receipt: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let _evidence_guard = state.packaged_evidence_lock()?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state_locked(&state)?;
    let discarded = state
        .recent_files()?
        .discard(window.label(), &open_receipt)?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if discarded {
        let evidence_after = authorization_state_locked(&state)?;
        observe_receipt_settlement(
            &open_receipt,
            "discarded",
            &evidence_before,
            &evidence_after,
        );
    }
    Ok(discarded)
}

#[tauri::command]
pub(crate) fn clear_recent_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecentFilesSnapshot, String> {
    let snapshot = state.recent_files()?.clear()?;
    converge_recent_menu(&app, &state, &snapshot);
    Ok(snapshot)
}
