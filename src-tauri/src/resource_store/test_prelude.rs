//! Shared resource-store test imports.
pub(crate) use super::*;
pub(crate) use crate::{
    commands::{open_directory_inner, open_workspace_file_inner},
    state::AppState,
};
pub(crate) use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
pub(crate) use std::{
    fs,
    sync::{Arc, Barrier, Mutex as TestMutex},
    thread,
};
pub(crate) use tempfile::TempDir;
#[cfg(unix)]
pub(crate) use std::os::unix::fs::symlink;
pub(crate) const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
pub(crate) static BEFORE_PUBLISH_HOOK: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);
pub(super) fn run_before_publish_hook() {
    if let Some(hook) = BEFORE_PUBLISH_HOOK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        hook();
    }
}
pub(crate) fn set_before_publish_hook(hook: impl FnOnce() + Send + 'static) {
    *BEFORE_PUBLISH_HOOK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(hook));
}
pub(crate) fn open_workspace_and_document(state: &AppState, dir: &TempDir) -> (String, String) {
    let snapshot = open_directory_inner(state, dir.path()).unwrap();
    open_workspace_file_inner(state, dir.path().join("draft.md")).unwrap();
    (snapshot.workspace_token, snapshot.root)
}
pub(crate) fn request(token: &str, root: &str, bytes: &[u8]) -> WriteWorkspaceResourceRequest {
    WriteWorkspaceResourceRequest {
        workspace_token: token.to_string(),
        workspace_root: root.to_string(),
        document_path: Path::new(root)
            .join("draft.md")
            .to_string_lossy()
            .to_string(),
        resource_directory: "assets/images".to_string(),
        bytes_base64: BASE64_STANDARD.encode(bytes),
        mime_type: "image/png".to_string(),
        suggested_name: Some("clipboard.png".to_string()),
        trusted_generated: None,
        resource_directory_token: None,
    }
}

pub(crate) fn excalidraw_asset_request(
    token: &str,
    root: &str,
    source_content: &str,
    svg: &[u8],
    png: &[u8],
) -> WriteExcalidrawAssetPairRequest {
    WriteExcalidrawAssetPairRequest {
        workspace_token: token.to_string(),
        workspace_root: root.to_string(),
        document_path: Path::new(root)
            .join("docs/guide.md")
            .to_string_lossy()
            .to_string(),
        source_relative_path: "diagrams/system.excalidraw".to_string(),
        source_content: source_content.to_string(),
        resource_directory: "assets/diagrams".to_string(),
        resource_directory_token: None,
        svg_base64: BASE64_STANDARD.encode(svg),
        png_base64: BASE64_STANDARD.encode(png),
    }
}