use std::path::Path;

use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::excalidraw_scene::validate_excalidraw_scene;
use crate::image_resolver::{
    resolve_relative_excalidraw_path_inner, resolve_relative_image_path_inner,
    resolve_relative_media_path_inner,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::path_auth::{
    ensure_authorized_existing_file_inner, open_authorized_existing_file_inner,
};
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

use super::super::{EXCALIDRAW_EMBED_SOURCE_LIMIT_BYTES, IMAGE_SOURCE_LIMIT_BYTES};
use super::open::{read_binary_file_bounded, read_open_binary_file_bounded};

fn allow_asset_preview_file(app: &AppHandle, file: &Path) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(file)
        .map_err(|err| format!("Failed to authorize preview assets: {err}"))
}

pub(crate) fn retry_asset_scope_sync(mut sync: impl FnMut() -> Result<(), String>) -> Result<(), String> {
    match sync() {
        Ok(()) => Ok(()),
        Err(_) => sync(),
    }
}

pub(crate) fn allow_asset_preview_file_with_retry(app: &AppHandle, file: &Path) -> Result<(), String> {
    retry_asset_scope_sync(|| allow_asset_preview_file(app, file))
}

pub(crate) fn allow_asset_preview_directory(
    app: &AppHandle,
    directory: &Path,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|err| format!("Failed to authorize preview assets: {err}"))
}

pub(crate) fn read_workspace_image_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<String, String> {
    let opened = open_authorized_existing_file_inner(state, path)?;
    let path = opened.path().to_path_buf();
    if WorkspaceFileKind::classify(&path) != Some(WorkspaceFileKind::Image) {
        return Err("Workspace file is not a supported image".into());
    }
    let mime_type = WorkspaceFileKind::Image
        .mime_type(&path)
        .ok_or_else(|| "Workspace image has no supported MIME type".to_string())?;
    let (_, handle) = opened.into_parts();
    let bytes = read_open_binary_file_bounded(
        handle,
        &path,
        IMAGE_SOURCE_LIMIT_BYTES,
        "Image source exceeds the 64 MiB limit",
    )?;
    Ok(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub(crate) fn read_workspace_image(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    read_workspace_image_inner(&state, path)
}

pub(crate) fn resolve_workspace_media_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<String, String> {
    let path = ensure_authorized_existing_file_inner(state, path)?;
    if !matches!(
        WorkspaceFileKind::classify(&path),
        Some(WorkspaceFileKind::Video | WorkspaceFileKind::Audio)
    ) {
        return Err("Workspace file is not supported audio or video".into());
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn resolve_workspace_media(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = resolve_workspace_media_inner(&state, path)?;
    allow_asset_preview_file_with_retry(&app, Path::new(&path))?;
    Ok(path)
}

#[tauri::command]
pub(crate) fn prepare_workspace_media_preview(
    path: String,
    webview_window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<crate::html_preview_server::MediaPreviewHandle, String> {
    crate::html_preview_server::prepare_media_preview_inner(&state, path, webview_window.label())
}

#[tauri::command]
pub(crate) fn prepare_markdown_media_preview(
    current_file_path: String,
    workspace_root: Option<String>,
    media_src: String,
    webview_window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<crate::html_preview_server::MediaPreviewHandle, String> {
    let workspace_root = workspace_root.filter(|root| !root.trim().is_empty());
    let path = resolve_relative_media_path_inner(
        &state,
        &current_file_path,
        workspace_root.as_deref(),
        &media_src,
    )?;
    if WorkspaceFileKind::classify(&path) != Some(WorkspaceFileKind::Video) {
        return Err("Markdown media source is not a supported video".into());
    }
    let scope = crate::path_auth::preview_scope_for_anchored_file_with_root_inner(
        &state,
        &current_file_path,
        &path,
        workspace_root.as_deref().map(Path::new),
    )?;
    crate::html_preview_server::prepare_media_preview_with_scope_inner(
        &state,
        scope,
        webview_window.label(),
    )
}

#[tauri::command]
pub(crate) fn release_media_preview(
    owner_id: u64,
    webview_window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::html_preview_server::release_media_preview_inner(
        &state,
        owner_id,
        webview_window.label(),
    )
}

#[tauri::command]
pub(crate) fn resolve_markdown_image(
    current_file_path: String,
    workspace_root: Option<String>,
    image_src: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = resolve_relative_image_path_inner(
        &state,
        &current_file_path,
        workspace_root.as_deref(),
        &image_src,
    )?;
    allow_asset_preview_file_with_retry(&app, &path)?;
    Ok(path.to_string_lossy().to_string())
}

pub(crate) fn resolve_markdown_media_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    media_src: &str,
) -> Result<std::path::PathBuf, String> {
    let path =
        resolve_relative_media_path_inner(state, current_file_path, workspace_root, media_src)?;
    if crate::workspace_file_kind::WorkspaceFileKind::classify(&path)
        != Some(crate::workspace_file_kind::WorkspaceFileKind::Video)
    {
        return Err("Markdown media source is not a supported video".into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) fn resolve_markdown_media(
    current_file_path: String,
    workspace_root: Option<String>,
    media_src: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = resolve_markdown_media_inner(
        &state,
        &current_file_path,
        workspace_root.as_deref(),
        &media_src,
    )?;
    allow_asset_preview_file_with_retry(&app, &path)?;
    Ok(path.to_string_lossy().to_string())
}

pub(crate) fn read_markdown_excalidraw_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    excalidraw_src: &str,
) -> Result<String, String> {
    let path = resolve_relative_excalidraw_path_inner(
        state,
        current_file_path,
        workspace_root,
        excalidraw_src,
    )?;
    let bytes = read_binary_file_bounded(
        &path,
        EXCALIDRAW_EMBED_SOURCE_LIMIT_BYTES,
        "Excalidraw embed exceeds the 16 MiB limit",
    )
    .map_err(|error| format!("Failed to read Excalidraw embed: {error}"))?;
    let content =
        String::from_utf8(bytes).map_err(|_| "Excalidraw embed is not valid UTF-8".to_string())?;
    validate_excalidraw_scene(&content)?;
    Ok(content)
}

#[tauri::command]
pub(crate) fn read_markdown_excalidraw(
    current_file_path: String,
    workspace_root: Option<String>,
    excalidraw_src: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    read_markdown_excalidraw_inner(
        &state,
        &current_file_path,
        workspace_root.as_deref(),
        &excalidraw_src,
    )
}
