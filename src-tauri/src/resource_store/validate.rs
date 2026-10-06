//! Resource validation, decoding and target resolution.
use super::*;
use crate::private_fs::lowercase_hex;

pub(super) fn open_bound_markdown_document(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    document_path: &str,
    kind_label: &str,
) -> Result<(crate::path_auth::AuthorizedReadFile, crate::path_auth::AuthorizedWorkspace), String> {
    let document = open_exact_workspace_file_for_read_inner(
        state,
        workspace_token,
        workspace_root,
        document_path,
    )?;
    if WorkspaceFileKind::classify(document.path()) != Some(WorkspaceFileKind::Markdown) {
        return Err(format!("{kind_label} requires an authorized Markdown document"));
    }
    let workspace_auth = document
        .workspace_authorization()
        .ok_or_else(|| "Document is not authorized through the selected workspace".to_string())?;
    if workspace_auth.wire_token() != workspace_token {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    let _document_binding = workspace_auth.retained_file_binding();
    let workspace = resolve_authorized_workspace_root_for_token_inner(
        state,
        workspace_token,
        workspace_root,
    )?;
    if workspace.root() != workspace_auth.root()
        || !path_is_under(document.path(), workspace.root())
    {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    Ok((document, workspace))
}

pub(crate) fn validate_trusted_svg_resource(bytes: &[u8]) -> Result<(), String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "SVG resource must be valid UTF-8".to_string())?;
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if !(trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg")))
    {
        return Err("SVG resource does not contain an SVG document".to_string());
    }
    let lower = trimmed
        .to_ascii_lowercase()
        .replace("http://www.w3.org/2000/svg", "")
        .replace("https://www.w3.org/2000/svg", "");
    if lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("data:")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains(" xlink:href=")
        || lower.contains(" href=")
        || lower.contains(" onload=")
        || lower.contains(" onclick=")
        || lower.contains(" onerror=")
    {
        return Err("SVG resource contains unsupported active or external content".to_string());
    }
    Ok(())
}

pub(crate) fn decode_resource_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() {
        return Err("Resource payload is empty".to_string());
    }
    let max_base64_len = MAX_RESOURCE_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_base64_len + 4 {
        return Err("Resource payload exceeds the 16 MiB limit".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Resource payload is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("Resource payload is empty".to_string());
    }
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err("Resource payload exceeds the 16 MiB limit".to_string());
    }
    Ok(bytes)
}

pub(super) fn validate_resource_directory(path: &str) -> Result<ResourceDirectoryTarget, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("Resource directory is invalid".to_string());
    }
    let directory = Path::new(path);
    let mut normalized = PathBuf::new();
    for component in directory.components() {
        match component {
            Component::Prefix(prefix) if directory.is_absolute() => {
                normalized.push(prefix.as_os_str())
            }
            Component::RootDir if directory.is_absolute() => normalized.push(component.as_os_str()),
            Component::Normal(segment) => normalized.push(segment),
            _ => return Err("Resource directory must not contain parent traversal".to_string()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Resource directory is invalid".to_string());
    }
    if directory.is_absolute() {
        Ok(ResourceDirectoryTarget::Absolute(normalized))
    } else {
        Ok(ResourceDirectoryTarget::Relative(normalized))
    }
}

pub(crate) fn validate_source_relative_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("Excalidraw source path is invalid".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute() {
        return Err("Excalidraw source path must be workspace-relative".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            _ => return Err("Excalidraw source path must not contain traversal".to_string()),
        }
    }
    if WorkspaceFileKind::classify(&normalized) != Some(WorkspaceFileKind::Excalidraw) {
        return Err("Excalidraw asset source must be an .excalidraw file".to_string());
    }
    Ok(normalized)
}

pub(crate) fn stable_excalidraw_asset_names(
    source_relative_path: &Path,
) -> Result<(String, String, String), String> {
    let source_text = forward_slash_path(source_relative_path)?;
    let key = md5_hex(source_text.as_bytes());
    let stem = source_relative_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("drawing")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(48)
        .collect::<String>();
    let stem = if stem.is_empty() { "drawing" } else { &stem };
    let prefix = format!("{stem}-{}", &key[..12]);
    Ok((
        format!("{prefix}.source"),
        format!("{prefix}.svg"),
        format!("{prefix}.png"),
    ))
}

pub(super) fn resolve_resource_target(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    target: ResourceDirectoryTarget,
    resource_directory_token: Option<&str>,
) -> Result<(AuthorizedWorkspace, PathBuf), String> {
    match target {
        ResourceDirectoryTarget::Relative(relative) => Ok((workspace.clone(), relative)),
        ResourceDirectoryTarget::Absolute(absolute) => {
            let token = resource_directory_token.ok_or_else(|| {
                "Absolute resource directory must be explicitly authorized for this session"
                    .to_string()
            })?;
            resolve_authorized_workspace_root_for_token_inner(state, token, &absolute)
                .map(|authorization| (authorization, PathBuf::new()))
        }
    }
}

pub(crate) fn validate_suggested_name(suggested_name: Option<&str>) -> Result<(), String> {
    let Some(suggested_name) = suggested_name else {
        return Ok(());
    };
    if suggested_name.is_empty() || suggested_name.len() > 128 {
        return Err("Suggested resource name is invalid".to_string());
    }
    let mut components = Path::new(suggested_name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("Suggested resource name is invalid".to_string());
    }
    Ok(())
}

pub(crate) fn md5_hex(bytes: &[u8]) -> String {
    lowercase_hex(&Md5::digest(bytes))
}

pub(crate) fn forward_slash_path(path: &Path) -> Result<String, String> {
    path.components()
        .map(|component| match component {
            Component::Normal(segment) => segment
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Resource path is not valid UTF-8".to_string()),
            _ => Err("Resource path contains invalid components".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|segments| segments.join("/"))
}

pub(crate) fn markdown_relative_path(base: &Path, target: &Path) -> Result<String, String> {
    if !base.is_absolute() || !target.is_absolute() {
        return Err("Resource Markdown paths require absolute inputs".to_string());
    }
    let base_components = base.components().collect::<Vec<_>>();
    let target_components = target.components().collect::<Vec<_>>();
    let common = base_components
        .iter()
        .zip(&target_components)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0 {
        return Err(
            "Resource directory must share a filesystem root with the document".to_string(),
        );
    }
    let mut segments = Vec::new();
    for component in &base_components[common..] {
        match component {
            Component::Normal(_) => segments.push("..".to_string()),
            Component::CurDir => {}
            _ => {
                return Err(
                    "Resource directory must share a filesystem root with the document".to_string(),
                )
            }
        }
    }
    for component in &target_components[common..] {
        match component {
            Component::Normal(segment) => segments.push(
                segment
                    .to_str()
                    .ok_or_else(|| "Resource path is not valid UTF-8".to_string())?
                    .to_string(),
            ),
            Component::CurDir => {}
            _ => return Err("Resource path contains invalid components".to_string()),
        }
    }
    if segments.is_empty() {
        return Err("Resource Markdown path is empty".to_string());
    }
    Ok(segments.join("/"))
}
