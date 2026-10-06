use std::path::Path;

use tauri::State;

use crate::excalidraw_scene::validate_excalidraw_scene;
use crate::models::OpenFileResponse;
use crate::path_auth::open_authorized_existing_file_with_before_open_inner;
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

use super::super::open_authorized_file_response_from_handle;

pub(crate) fn read_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<OpenFileResponse, String> {
    read_file_with_before_open_inner(state, path, || {})
}

pub(crate) fn read_file_with_before_open_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    before_open: impl FnOnce(),
) -> Result<OpenFileResponse, String> {
    let opened = open_authorized_existing_file_with_before_open_inner(state, path, before_open)?;
    let path = opened.path().to_path_buf();
    let kind = WorkspaceFileKind::classify(&path)
        .filter(|kind| kind.is_editable())
        .ok_or_else(|| {
            "Only Markdown, HTML, and Excalidraw files can be read as text".to_string()
        })?;
    if !kind.is_editable() {
        return Err("Only Markdown, HTML, and Excalidraw files can be read as text".into());
    }
    let (path, handle) = opened.into_parts();
    open_authorized_file_response_from_handle(path, handle)
}

pub(crate) fn validate_editable_content(path: &Path, content: &str, action: &str) -> Result<(), String> {
    let kind = WorkspaceFileKind::classify(path)
        .ok_or_else(|| "Workspace file is not a supported editable document".to_string())?;
    if !kind.is_editable() {
        return Err(format!(
            "Only Markdown, HTML, and Excalidraw files can be {action}"
        ));
    }
    if kind == WorkspaceFileKind::Excalidraw {
        validate_excalidraw_scene(content)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn read_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, String> {
    read_file_inner(&state, path)
}

