//! Media pick dialog internals.
use super::validate::open_bound_markdown_document;
use super::*;

fn collect_picked_media_resources(
    state: &AppState,
    workspace_root: &Path,
    document_path: &Path,
    resource_workspace: &AuthorizedWorkspace,
    resource_subdirectory: &Path,
    media_kind: WorkspaceFileKind,
    max_bytes: u64,
    selected_paths: Vec<tauri_plugin_dialog::FilePath>,
) -> Result<Vec<PickedMediaResource>, String> {
    let mut resources = Vec::with_capacity(selected_paths.len());
    for selected in selected_paths {
        let path = selected
            .into_path()
            .map_err(|error| format!("Invalid selected file path: {error}"))?;
        match plan_picked_media_resource(workspace_root, document_path, &path, media_kind)? {
            MediaPickPlan::Reference {
                markdown_path,
                name,
            } => {
                resources.push(PickedMediaResource {
                    name,
                    markdown_path,
                });
            }
            MediaPickPlan::Import { source, name } => {
                let markdown_path = import_picked_media_file(
                    state,
                    resource_workspace,
                    resource_subdirectory,
                    document_path,
                    media_kind,
                    &source,
                    max_bytes,
                )?;
                resources.push(PickedMediaResource {
                    name,
                    markdown_path,
                });
            }
        }
    }
    Ok(resources)
}

pub(crate) fn pick_media_resources_inner(
    state: &AppState,
    app: &AppHandle,
    input: PickMediaResourcesInput,
) -> Result<PickMediaResourcesResponse, String> {
    let media_kind = parse_picked_media_kind(&input.media_kind)?;
    let resource_directory = validate_resource_directory(&input.resource_directory)?;
    let (document, workspace) = open_bound_markdown_document(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &input.document_path,
        "Media picking",
    )?;
    let (resource_workspace, resource_subdirectory) = resolve_resource_target(
        state,
        &workspace,
        resource_directory,
        input.resource_directory_token.as_deref(),
    )?;

    let max_bytes = match media_kind {
        WorkspaceFileKind::Video | WorkspaceFileKind::Audio => MAX_PICKED_AUDIO_VIDEO_BYTES,
        _ => MAX_RESOURCE_BYTES as u64,
    };
    let mut builder = app.dialog().file().add_filter(
        picked_media_filter_label(media_kind),
        media_kind.extensions(),
    );
    if let Some(default_directory) = resolve_picked_default_directory(&input.default_directory) {
        builder = builder.set_directory(default_directory);
    }
    let selected_paths = builder.blocking_pick_files().unwrap_or_default();

    let resources = collect_picked_media_resources(
        state,
        workspace.root(),
        document.path(),
        &resource_workspace,
        &resource_subdirectory,
        media_kind,
        max_bytes,
        selected_paths,
    )?;
    Ok(PickMediaResourcesResponse { resources })
}
