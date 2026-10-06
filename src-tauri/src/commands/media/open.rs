
use std::{fs, io::Read, path::Path};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::docx_preflight::preflight_docx_zip;
use crate::workspace_file_kind::{ContentMode, WorkspaceFileKind};
use super::super::{
    DOCX_SOURCE_LIMIT_BYTES, open_regular_file_without_following_links, PDF_SOURCE_LIMIT_BYTES,
};

use crate::models::OpenFileResponse;

pub(crate) fn read_open_binary_file_bounded(
    file: fs::File,
    path: &Path,
    source_limit: u64,
    limit_error: &str,
) -> Result<Vec<u8>, String> {
    if file
        .metadata()
        .map_err(|error| format!("Failed to inspect binary file {}: {error}", path.display()))?
        .len()
        > source_limit
    {
        return Err(limit_error.to_string());
    }

    let mut bytes = Vec::new();
    file.take(source_limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read binary file {}: {error}", path.display()))?;
    if bytes.len() as u64 > source_limit {
        return Err(limit_error.to_string());
    }
    Ok(bytes)
}

pub(crate) fn read_binary_file_bounded(
    path: &Path,
    source_limit: u64,
    limit_error: &str,
) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Failed to open binary file {}: {error}", path.display()))?;
    read_open_binary_file_bounded(file, path, source_limit, limit_error)
}

pub(crate) fn embedded_binary_open_response(
    kind: WorkspaceFileKind,
    path: &Path,
    file: fs::File,
) -> Result<OpenFileResponse, String> {
    let bytes = match kind {
        WorkspaceFileKind::Pdf => read_open_binary_file_bounded(
            file,
            path,
            PDF_SOURCE_LIMIT_BYTES,
            "PDF source exceeds the 64 MiB limit",
        )?,
        WorkspaceFileKind::Docx => {
            let bytes = read_open_binary_file_bounded(
                file,
                path,
                DOCX_SOURCE_LIMIT_BYTES,
                "DOCX source exceeds the 32 MiB limit",
            )?;
            preflight_docx_zip(&bytes)?;
            bytes
        }
        _ => return Err("Workspace file does not require embedded binary bytes".to_string()),
    };

    Ok(OpenFileResponse {
        kind,
        path: path.to_string_lossy().to_string(),
        content_mode: ContentMode::Binary,
        file_version: None,
        content: None,
        mime_type: kind.mime_type(path),
        bytes_base64: Some(BASE64_STANDARD.encode(bytes)),
    })
}

pub(crate) fn open_authorized_file_response(
    file: std::path::PathBuf,
) -> Result<OpenFileResponse, String> {
    let handle = open_regular_file_without_following_links(&file)
        .map_err(|error| format!("Failed to securely open file {}: {error}", file.display()))?;
    open_authorized_file_response_from_handle(file, handle)
}

pub(crate) fn open_authorized_file_response_from_handle(
    file: std::path::PathBuf,
    handle: fs::File,
) -> Result<OpenFileResponse, String> {
    let kind = WorkspaceFileKind::classify(&file)
        .ok_or_else(|| "Selected file is not a supported preview file".to_string())?;
    if kind.requires_embedded_bytes() {
        embedded_binary_open_response(kind, &file, handle)
    } else {
        kind.open_response_from_handle(&file, handle)
    }
}
