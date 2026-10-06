use std::path::Path;

use tauri::{State, WebviewWindow};

use crate::path_auth::{
    ensure_authorized_existing_file_inner, normalize_existing_path, path_is_under,
    resolve_authorized_workspace_root_for_token_inner,
};
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;
use crate::workspace_session::WorkspaceSessionRecord;
#[cfg(test)]
use crate::models::{PreparedOpenFileResponse, WorkspaceSessionRestore, WorkspaceSnapshot};
#[cfg(test)]
use crate::workspace_snapshot::capture_workspace_snapshot;
#[cfg(test)]
use super::{open_persisted_directory_with_ports_inner, prepare_workspace_file_inner};

fn canonical_persisted_workspace_root(path: &str) -> Result<std::path::PathBuf, String> {
    let raw = Path::new(path);
    let canonical = normalize_existing_path(raw)?;
    if raw != canonical || !canonical.is_dir() {
        return Err("Saved workspace root is no longer a canonical directory".to_string());
    }
    Ok(canonical)
}

fn canonical_persisted_active_file(
    state: &AppState,
    workspace_root: &Path,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let raw = Path::new(path);
    let canonical = normalize_existing_path(raw)?;
    if raw != canonical || !canonical.is_file() {
        return Err("Saved active file is no longer a canonical file".to_string());
    }
    if !path_is_under(&canonical, workspace_root) {
        return Err("Saved active file is outside the restored workspace".to_string());
    }
    if WorkspaceFileKind::classify(&canonical).is_none() {
        return Err("Saved active file is no longer supported".to_string());
    }
    let authorized = ensure_authorized_existing_file_inner(state, &canonical)?;
    if authorized != canonical {
        return Err("Saved active file changed while being restored".to_string());
    }
    Ok(canonical)
}

fn utf8_canonical_path(path: &Path, description: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{description} is not valid UTF-8"))
}

#[cfg(test)]
fn clear_invalid_workspace_session(state: &AppState) -> Result<(), String> {
    state.workspace_session()?.clear()
}

#[cfg(test)]
fn clear_invalid_workspace_active_path(state: &AppState, record: &WorkspaceSessionRecord) {
    let _ = state
        .workspace_session()
        .and_then(|session| session.save(&record.without_active_path()));
}

pub(crate) fn validate_workspace_session_owner(owner: &str) -> Result<(), String> {
    if owner == "main" {
        Ok(())
    } else {
        Err("Only the main window can manage workspace session restoration".to_string())
    }
}

#[cfg(test)]
pub(crate) fn restore_workspace_session_with_ports_inner(
    state: &AppState,
    owner_window: &str,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Option<WorkspaceSessionRestore>, String> {
    let Some(record) = state.workspace_session()?.load()? else {
        return Ok(None);
    };
    let workspace_root = match canonical_persisted_workspace_root(record.workspace_root()) {
        Ok(workspace_root) => workspace_root,
        Err(_) => {
            clear_invalid_workspace_session(state)?;
            return Ok(None);
        }
    };
    let workspace = match open_persisted_directory_with_ports_inner(
        state,
        &workspace_root,
        &workspace_root,
        capture_workspace_snapshot,
        transport,
    ) {
        Ok(workspace) => workspace,
        Err(_error) if canonical_persisted_workspace_root(record.workspace_root()).is_err() => {
            clear_invalid_workspace_session(state)?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };

    let active_file = restore_session_active_file(
        state,
        owner_window,
        &record,
        &workspace_root,
        &workspace,
    );
    Ok(Some(WorkspaceSessionRestore {
        workspace,
        active_file,
    }))
}

#[cfg(test)]
fn restore_session_active_file(
    state: &AppState,
    owner_window: &str,
    record: &WorkspaceSessionRecord,
    workspace_root: &Path,
    workspace: &WorkspaceSnapshot,
) -> Option<PreparedOpenFileResponse> {
    match record.active_path() {
        None => None,
        Some(active_path) => {
            match canonical_persisted_active_file(state, workspace_root, active_path).and_then(
                |active_path| {
                    let active_path_wire = active_path.to_string_lossy();
                    if workspace
                        .files
                        .iter()
                        .any(|file| file.path == active_path_wire.as_ref())
                    {
                        prepare_workspace_file_inner(state, owner_window, active_path)
                    } else {
                        Err(
                            "Saved active file is absent from the restored workspace snapshot"
                                .to_string(),
                        )
                    }
                },
            ) {
                Ok(prepared) => Some(prepared),
                Err(_) => {
                    clear_invalid_workspace_active_path(state, record);
                    None
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn restore_workspace_session_inner(
    state: &AppState,
) -> Result<Option<WorkspaceSessionRestore>, String> {
    restore_workspace_session_with_ports_inner(state, "main", |_| Ok(()))
}

pub(crate) fn persist_workspace_session_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    active_path: Option<&str>,
) -> Result<(), String> {
    let workspace_root = canonical_persisted_workspace_root(workspace_root)?;
    resolve_authorized_workspace_root_for_token_inner(state, workspace_token, &workspace_root)?;
    let active_path = active_path
        .map(|path| canonical_persisted_active_file(state, &workspace_root, path))
        .transpose()?;
    let record = WorkspaceSessionRecord::new(
        utf8_canonical_path(&workspace_root, "Workspace root")?,
        active_path
            .as_deref()
            .map(|path| utf8_canonical_path(path, "Active file"))
            .transpose()?,
    );
    state.workspace_session()?.save(&record)
}

#[tauri::command]
pub(crate) fn persist_workspace_session(
    workspace_token: String,
    workspace_root: String,
    active_path: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_workspace_session_owner(window.label())?;
    persist_workspace_session_inner(
        &state,
        &workspace_token,
        &workspace_root,
        active_path.as_deref(),
    )
}

