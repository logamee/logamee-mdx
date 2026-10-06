//! Workspace resource write command internals.
use super::*;

fn decode_workspace_resource_payload(
    input: &WriteWorkspaceResourceRequest,
) -> Result<(ResourceDirectoryTarget, Vec<u8>, String, String), String> {
    let resource_directory = validate_resource_directory(&input.resource_directory)?;
    validate_suggested_name(input.suggested_name.as_deref())?;
    let kind = ResourceImageKind::from_mime(&input.mime_type)?;
    let bytes = decode_resource_bytes(&input.bytes_base64)?;
    kind.validate(&bytes, input.trusted_generated.unwrap_or(false))?;
    let digest_md5 = md5_hex(&bytes);
    let file_name = format!("{digest_md5}.{}", kind.extension());
    Ok((resource_directory, bytes, digest_md5, file_name))
}

fn open_document_for_resource_write(
    state: &AppState,
    input: &WriteWorkspaceResourceRequest,
) -> Result<(crate::path_auth::AuthorizedReadFile, AuthorizedWorkspace), String> {
    let document = open_exact_workspace_file_for_read_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &input.document_path,
    )?;
    if WorkspaceFileKind::classify(document.path()) != Some(WorkspaceFileKind::Markdown) {
        return Err("Resource writes require an authorized Markdown document".to_string());
    }
    let workspace_auth = document
        .workspace_authorization()
        .ok_or_else(|| "Document is not authorized through the selected workspace".to_string())?;
    if workspace_auth.wire_token() != input.workspace_token {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    let _document_binding = workspace_auth.retained_file_binding();
    let workspace = resolve_authorized_workspace_root_for_token_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
    )?;
    if workspace.root() != workspace_auth.root()
        || !path_is_under(document.path(), workspace.root())
    {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    Ok((document, workspace))
}

fn plan_workspace_resource_target(
    state: &AppState,
    input: &WriteWorkspaceResourceRequest,
    workspace: &AuthorizedWorkspace,
    resource_directory: ResourceDirectoryTarget,
    document: &crate::path_auth::AuthorizedReadFile,
    file_name: &str,
) -> Result<(AuthorizedWorkspace, PathBuf, String), String> {
    let (resource_workspace, resource_subdirectory) = resolve_resource_target(
        state,
        workspace,
        resource_directory,
        input.resource_directory_token.as_deref(),
    )?;
    let resource_path = resource_workspace
        .root()
        .join(&resource_subdirectory)
        .join(file_name);
    let document_directory = document
        .path()
        .parent()
        .ok_or_else(|| "Markdown document has no parent directory".to_string())?;
    let markdown_path = markdown_relative_path(document_directory, &resource_path)?;
    Ok((resource_workspace, resource_subdirectory, markdown_path))
}

fn publish_workspace_resource_bytes(
    _write_guard: &std::sync::MutexGuard<'static, ()>,
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    resource_workspace: &AuthorizedWorkspace,
    resource_subdirectory: &Path,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    state
        .file_authorization()
        .ensure_workspace_is_current(workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(resource_workspace)?;
    let created = publish_resource_no_replace(
        resource_workspace,
        resource_subdirectory,
        file_name,
        bytes,
        digest_md5,
    )?;
    state
        .file_authorization()
        .ensure_workspace_is_current(workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(resource_workspace)?;
    Ok(created)
}

pub(crate) fn write_workspace_resource_inner(
    state: &AppState,
    input: WriteWorkspaceResourceRequest,
) -> Result<WriteWorkspaceResourceResponse, String> {
    let (resource_directory, bytes, digest_md5, file_name) =
        decode_workspace_resource_payload(&input)?;

    let (document, workspace) = open_document_for_resource_write(state, &input)?;
    let (resource_workspace, resource_subdirectory, markdown_path) =
        plan_workspace_resource_target(
            state,
            &input,
            &workspace,
            resource_directory,
            &document,
            &file_name,
        )?;

    let _write_guard = RESOURCE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let created = publish_workspace_resource_bytes(
        &_write_guard,
        state,
        &workspace,
        &resource_workspace,
        &resource_subdirectory,
        &file_name,
        &bytes,
        &digest_md5,
    )?;

    let relative_path = if resource_workspace.root() == workspace.root() {
        forward_slash_path(&resource_subdirectory.join(&file_name))?
    } else {
        markdown_path.clone()
    };
    Ok(WriteWorkspaceResourceResponse {
        relative_path,
        markdown_path,
        file_name,
        digest_md5,
        created,
    })
}

#[tauri::command]
pub(crate) fn write_workspace_resource(
    input: WriteWorkspaceResourceRequest,
    state: State<'_, AppState>,
) -> Result<WriteWorkspaceResourceResponse, String> {
    write_workspace_resource_inner(&state, input)
}
