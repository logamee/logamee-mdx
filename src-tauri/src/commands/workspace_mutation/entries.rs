use std::path::Path;

use crate::excalidraw_scene::default_excalidraw_scene;
use crate::workspace_file_kind::WorkspaceFileKind;

pub(crate) fn validate_workspace_entry_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Workspace entry name is empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Workspace entry name cannot contain path separators".into());
    }
    if matches!(name, "." | "..") || Path::new(name).components().count() != 1 {
        return Err("Workspace entry name is invalid".into());
    }
    if is_windows_reserved_entry_name(name) {
        return Err("Workspace entry name is reserved on Windows".into());
    }
    Ok(name)
}

// Workspaces are local folders that can sync across platforms; a name that
// Windows resolves to a device object would be created fine on this platform
// and then be unreadable or shadowed on Windows, so it is rejected everywhere.
fn is_windows_reserved_entry_name(name: &str) -> bool {
    if name.ends_with('.') {
        return true;
    }
    let base = name.split('.').next().unwrap_or(name);
    matches!(
        base.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

pub(crate) fn markdown_file_name(name: &str) -> Result<String, String> {
    let name = validate_workspace_entry_name(name)?;
    let path = Path::new(name);
    let normalized = if path.extension().is_none() {
        format!("{name}.md")
    } else {
        name.to_string()
    };
    if !WorkspaceFileKind::Markdown.allows_rename_to(Path::new(&normalized)) {
        return Err("Workspace file is not a Markdown/MDX file".into());
    }
    Ok(normalized)
}

pub(crate) fn excalidraw_file_name(name: &str) -> Result<String, String> {
    let name = validate_workspace_entry_name(name)?;
    let path = Path::new(name);
    let normalized = if path.extension().is_none() {
        format!("{name}.excalidraw")
    } else {
        name.to_string()
    };
    if !WorkspaceFileKind::Excalidraw.allows_rename_to(Path::new(&normalized)) {
        return Err("Workspace file is not an Excalidraw scene".into());
    }
    Ok(normalized)
}

pub(crate) fn new_workspace_file_spec(
    kind: WorkspaceFileKind,
    name: &str,
) -> Result<(String, String), String> {
    match kind {
        WorkspaceFileKind::Markdown => Ok((markdown_file_name(name)?, String::new())),
        WorkspaceFileKind::Excalidraw => Ok((
            excalidraw_file_name(name)?,
            default_excalidraw_scene().to_string(),
        )),
        _ => Err("Only Markdown and Excalidraw files can be created".into()),
    }
}

pub(crate) fn preview_file_name(current_kind: WorkspaceFileKind, name: &str) -> Result<String, String> {
    let name = validate_workspace_entry_name(name)?;
    if !current_kind.allows_rename_to(Path::new(name)) {
        return Err("Workspace file must keep the same supported file type".into());
    }
    Ok(name.to_string())
}


