use std::path::Path;

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::models::WorkspaceSnapshot;
use crate::path_auth::{ensure_authorized_existing_file_inner, WorkspaceSnapshotSource};
use crate::workspace_snapshot::{capture_workspace_snapshot, CapturedWorkspaceSnapshot};

use super::media::allow_asset_preview_directory;
#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::packaged_open_e2e::{authorization_state_locked, observe_workspace_published};
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

pub(crate) fn open_directory_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<WorkspaceSnapshot, String> {
    let (workspace, snapshot) = state
        .file_authorization()
        .open_workspace(path, snapshot, transport)?;
    let snapshot = snapshot.into_workspace_snapshot(&workspace)?;
    state.workspace_index().discard_all();
    Ok(snapshot)
}

pub(crate) fn open_file_parent_directory_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<WorkspaceSnapshot, String> {
    let file = ensure_authorized_existing_file_inner(state, path)?;
    if WorkspaceFileKind::classify(&file).is_none() {
        return Err("Selected file is not a supported preview file".to_string());
    }
    let parent = file
        .parent()
        .ok_or_else(|| "Selected file has no parent directory".to_string())?;
    open_directory_with_ports_inner(state, parent, capture_workspace_snapshot, transport)
}

#[cfg(test)]
pub(crate) fn open_file_parent_directory_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<WorkspaceSnapshot, String> {
    open_file_parent_directory_with_ports_inner(state, path, |_| Ok(()))
}

#[cfg(test)]
pub(crate) fn open_persisted_directory_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    expected_root: &Path,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<WorkspaceSnapshot, String> {
    let (workspace, snapshot) = state
        .file_authorization()
        .open_workspace_at_canonical_root(path, expected_root, snapshot, transport)?;
    let snapshot = snapshot.into_workspace_snapshot(&workspace)?;
    state.workspace_index().discard_all();
    Ok(snapshot)
}

#[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
pub(crate) fn open_directory_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<WorkspaceSnapshot, String> {
    open_directory_with_ports_inner(state, path, capture_workspace_snapshot, |_| Ok(()))
}

#[tauri::command]
pub(crate) async fn open_directory_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|err| format!("Invalid selected directory path: {err}"))?;
    let response =
        open_directory_with_ports_inner(&state, path, capture_workspace_snapshot, |root| {
            allow_asset_preview_directory(&app, root)
        })?;
    Ok(Some(response))
}

#[tauri::command]
pub(crate) fn open_file_parent_directory(
    path: String,
    intent_id: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    if window.label() != "main" {
        return Err("Only the main window can open a file parent workspace".to_string());
    }
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let _evidence_guard = state.packaged_evidence_lock()?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state_locked(&state)?;
    let snapshot = open_file_parent_directory_with_ports_inner(&state, path, |root| {
        allow_asset_preview_directory(&app, root)
    });
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if let Ok(snapshot) = &snapshot {
        let evidence_after = authorization_state_locked(&state)?;
        observe_workspace_published(
            &intent_id,
            &snapshot.root,
            &evidence_before,
            &evidence_after,
        );
    }
    #[cfg(not(feature = "packaged-lifecycle-e2e"))]
    let _ = &intent_id;
    snapshot
}

