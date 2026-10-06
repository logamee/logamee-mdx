//! Excalidraw asset pair writes and directory authorization.
use super::excalidraw_publish::{
    plan_excalidraw_asset_paths, publish_excalidraw_asset_pair, stage_excalidraw_ownership,
};
use crate::private_fs::lowercase_hex;
use super::validate::open_bound_markdown_document;
use super::*;

fn decode_excalidraw_asset_payload(
    input: &WriteExcalidrawAssetPairRequest,
) -> Result<(ResourceDirectoryTarget, PathBuf, Vec<u8>, Vec<u8>), String> {
    let resource_directory = validate_resource_directory(&input.resource_directory)?;
    let source_relative_path = validate_source_relative_path(&input.source_relative_path)?;
    if input.source_content.len() > MAX_RESOURCE_BYTES {
        return Err("Excalidraw source exceeds the 16 MiB asset-sync limit".to_string());
    }
    validate_excalidraw_scene(&input.source_content)?;
    let svg = decode_resource_bytes(&input.svg_base64)?;
    let png = decode_resource_bytes(&input.png_base64)?;
    ResourceImageKind::Svg.validate(&svg, true)?;
    ResourceImageKind::Png.validate(&png, true)?;
    Ok((resource_directory, source_relative_path, svg, png))
}

fn open_document_and_verify_excalidraw_source(
    state: &AppState,
    input: &WriteExcalidrawAssetPairRequest,
    source_relative_path: &Path,
) -> Result<
    (
        crate::path_auth::AuthorizedReadFile,
        crate::path_auth::AuthorizedWorkspace,
        crate::path_auth::AuthorizedWorkspace,
    ),
    String,
> {
    let (document, workspace) = open_bound_markdown_document(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &input.document_path,
        "Excalidraw asset sync",
    )?;
    let (source_workspace, source_path) = resolve_authorized_workspace_result_file_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &forward_slash_path(source_relative_path)?,
    )?;
    if WorkspaceFileKind::classify(&source_path) != Some(WorkspaceFileKind::Excalidraw) {
        return Err("Excalidraw asset source is not an .excalidraw file".to_string());
    }
    let mut source_file = source_workspace
        .open_regular_file(&source_path)
        .map_err(|error| format!("Cannot securely read Excalidraw asset source: {error}"))?;
    let mut source_bytes = Vec::new();
    Read::by_ref(&mut source_file)
        .take((MAX_RESOURCE_BYTES as u64).saturating_add(1))
        .read_to_end(&mut source_bytes)
        .map_err(|error| format!("Cannot read Excalidraw asset source: {error}"))?;
    if source_bytes.len() > MAX_RESOURCE_BYTES {
        return Err("Excalidraw source exceeds the 16 MiB asset-sync limit".to_string());
    }
    if source_bytes != input.source_content.as_bytes() {
        return Err("Excalidraw source changed before generated assets were written".to_string());
    }
    Ok((document, workspace, source_workspace))
}

fn ensure_excalidraw_workspaces_current(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    source_workspace: &AuthorizedWorkspace,
    resource_workspace: &AuthorizedWorkspace,
) -> Result<(), String> {
    state
        .file_authorization()
        .ensure_workspace_is_current(workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(source_workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(resource_workspace)?;
    Ok(())
}

pub(crate) fn write_excalidraw_asset_pair_inner(
    state: &AppState,
    input: WriteExcalidrawAssetPairRequest,
) -> Result<WriteExcalidrawAssetPairResponse, String> {
    let (resource_directory, source_relative_path, svg, png) =
        decode_excalidraw_asset_payload(&input)?;
    let (document, workspace, source_workspace) =
        open_document_and_verify_excalidraw_source(state, &input, &source_relative_path)?;
    let plan = plan_excalidraw_asset_paths(
        state,
        &input,
        &workspace,
        &document,
        resource_directory,
        &source_relative_path,
    )?;

    let _write_guard = RESOURCE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_excalidraw_workspaces_current(
        state,
        &workspace,
        &source_workspace,
        &plan.resource_workspace,
    )?;
    let (ownership_created, asset_dir_handle, previous_svg) = stage_excalidraw_ownership(&plan)?;
    let (svg_updated, png_updated) = publish_excalidraw_asset_pair(
        &plan,
        &asset_dir_handle,
        ownership_created,
        previous_svg,
        &svg,
        &png,
    )?;

    ensure_excalidraw_workspaces_current(
        state,
        &workspace,
        &source_workspace,
        &plan.resource_workspace,
    )?;
    Ok(WriteExcalidrawAssetPairResponse {
        svg_markdown_path: plan.svg_markdown_path,
        png_markdown_path: plan.png_markdown_path,
        svg_file_name: plan.svg_file_name,
        png_file_name: plan.png_file_name,
        source_sha256: lowercase_hex(&Sha256::digest(input.source_content.as_bytes())),
        updated: svg_updated || png_updated,
    })
}

#[tauri::command]
pub(crate) fn write_excalidraw_asset_pair(
    input: WriteExcalidrawAssetPairRequest,
    state: State<'_, AppState>,
) -> Result<WriteExcalidrawAssetPairResponse, String> {
    write_excalidraw_asset_pair_inner(&state, input)
}

pub(crate) fn authorize_resource_directory_path_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<ResourceDirectoryAuthorizationResponse, String> {
    let authorization = authorize_resource_directory_inner(state, path, transport)?;
    Ok(ResourceDirectoryAuthorizationResponse {
        path: authorization.root().to_string_lossy().to_string(),
        token: authorization.wire_token(),
    })
}

#[tauri::command]
pub(crate) async fn authorize_resource_directory_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ResourceDirectoryAuthorizationResponse>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Invalid selected resource directory: {error}"))?;
    authorize_resource_directory_path_inner(&state, path, |root| {
        allow_asset_preview_directory(&app, root)
    })
    .map(Some)
}
