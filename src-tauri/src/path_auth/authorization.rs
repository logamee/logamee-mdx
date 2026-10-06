use std::path::{Path, PathBuf};

use super::fs_paths::{normalize_existing_path, path_is_under};
#[cfg(test)]
use super::AuthorizedFile;
use super::{AuthorizedPreviewScope, AuthorizedReadFile, AuthorizedWorkspace, PreviewLeaseId};
use crate::state::AppState;

#[cfg(test)]
pub(crate) fn authorize_directory_root_inner(
    state: &AppState,
    root: PathBuf,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_directory_root(root)
        .map(AuthorizedWorkspace::into_root)
}

#[cfg(test)]
pub(crate) fn authorize_file_inner(state: &AppState, file: PathBuf) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_file(file)
        .map(AuthorizedFile::into_path)
}

#[cfg(test)]
pub(crate) fn authorize_saved_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_save_destination(path)
        .map(AuthorizedFile::into_path)
}

#[cfg(test)]
pub(crate) fn authorize_workspace_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .open_workspace_file(path)
        .map(AuthorizedFile::into_path)
}

pub(crate) fn ensure_authorized_existing_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_read(path)
}

pub(crate) fn open_authorized_existing_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<AuthorizedReadFile, String> {
    state.file_authorization().open_file_for_read(path)
}

pub(crate) fn open_exact_workspace_file_for_read_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<AuthorizedReadFile, String> {
    state
        .file_authorization()
        .open_exact_workspace_file_for_read(workspace_token, workspace_root, path)
}

pub(crate) fn open_authorized_existing_file_with_before_open_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    before_open: impl FnOnce(),
) -> Result<AuthorizedReadFile, String> {
    state
        .file_authorization()
        .open_file_for_read_with_before_open(path, before_open)
}

pub(crate) fn ensure_authorized_watch_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_watch(path)
}

#[cfg(test)]
pub(crate) fn ensure_authorized_write_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_write(path)
}

pub(crate) fn ensure_authorized_directory_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().directory_for_read(path)
}

pub(crate) fn resolve_authorized_workspace_directory_for_token_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
) -> Result<(PathBuf, AuthorizedWorkspace), String> {
    state
        .file_authorization()
        .authorized_workspace_directory_for_token(workspace_token, path)
}

pub(crate) fn resolve_authorized_workspace_root_for_token_inner(
    state: &AppState,
    workspace_token: &str,
    root: impl AsRef<Path>,
) -> Result<AuthorizedWorkspace, String> {
    state
        .file_authorization()
        .authorized_workspace_root_for_token(workspace_token, root)
}

pub(crate) fn authorize_resource_directory_inner(
    state: &AppState,
    root: impl AsRef<Path>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWorkspace, String> {
    state
        .file_authorization()
        .open_resource_directory(root, transport)
}

/// Resolves an index result relative to one exact authorized workspace. Cached
/// result paths are hints only, so every path component is re-observed and
/// symbolic links are rejected before the existing authorization is reused.
pub(crate) fn resolve_authorized_workspace_result_file_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: impl AsRef<Path>,
    relative_path: &str,
) -> Result<(AuthorizedWorkspace, PathBuf), String> {
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(state, workspace_token, workspace_root)?;
    let relative = Path::new(relative_path);
    if relative_path.is_empty() || relative.is_absolute() {
        return Err("Workspace search result path must be relative".to_string());
    }

    let mut candidate = workspace.root.clone();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err("Workspace search result path is invalid".to_string());
        };
        candidate.push(part);
        let metadata = std::fs::symlink_metadata(&candidate)
            .map_err(|error| format!("Workspace search result is no longer available: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Workspace search result cannot traverse a symbolic link".to_string());
        }
    }

    let canonical = normalize_existing_path(&candidate)?;
    if !canonical.is_file() || !path_is_under(&canonical, &workspace.root) {
        return Err("Workspace search result is outside the selected workspace".to_string());
    }
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    Ok((workspace, canonical))
}

#[cfg(test)]
pub(crate) fn is_authorized_image_path(state: &AppState, canonical: &Path) -> Result<bool, String> {
    is_authorized_preview_asset_path(state, canonical)
}

pub(crate) fn is_authorized_preview_asset_path(
    state: &AppState,
    canonical: &Path,
) -> Result<bool, String> {
    state
        .file_authorization()
        .is_authorized_preview_asset(canonical)
}

pub(crate) fn preview_scope_for_file_inner(
    state: &AppState,
    file: impl AsRef<Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state.file_authorization().preview_scope_for(file)
}

#[cfg(test)]
pub(crate) fn preview_scope_for_anchored_file_inner(
    state: &AppState,
    anchor: impl AsRef<Path>,
    file: impl AsRef<Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state
        .file_authorization()
        .preview_scope_for_anchored_file(anchor, file)
}

pub(crate) fn preview_scope_for_anchored_file_with_root_inner(
    state: &AppState,
    anchor: impl AsRef<Path>,
    file: impl AsRef<Path>,
    workspace_root: Option<&Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state
        .file_authorization()
        .preview_scope_for_anchored_file_with_root(anchor, file, workspace_root)
}

pub(crate) fn preview_lease_support_statuses_inner(
    state: &AppState,
    leases: &[&PreviewLeaseId],
) -> Result<Vec<bool>, String> {
    state
        .file_authorization()
        .preview_lease_support_statuses(leases)
}

