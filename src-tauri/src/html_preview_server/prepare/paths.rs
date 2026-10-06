//! HTML embed path decoding and relative path resolution.
use std::path::PathBuf;

use crate::workspace_file_kind::WorkspaceFileKind;

pub(super) fn decode_embed_path(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Invalid percent-encoded HTML embed path".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "Invalid HTML embed path".to_string())?;
            decoded.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "Invalid percent-encoded HTML embed path".to_string())?,
            );
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "HTML embed path is not valid UTF-8".into())
}

pub(super) fn relative_html_embed_path(html_src: &str) -> Result<PathBuf, String> {
    let source = html_src.trim();
    if source.is_empty() {
        return Err("HTML embed path is empty".into());
    }
    if source.contains(['?', '#']) {
        return Err("HTML embed paths cannot contain a query or fragment".into());
    }
    let decoded = decode_embed_path(source)?;
    if decoded.contains(['?', '#']) {
        return Err("HTML embed paths cannot contain a query or fragment".into());
    }
    let lower = decoded.to_ascii_lowercase();
    let has_scheme = lower.find(':').is_some_and(|colon| {
        colon > 0
            && lower[..colon].bytes().enumerate().all(|(index, byte)| {
                if index == 0 {
                    byte.is_ascii_alphabetic()
                } else {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                }
            })
    });
    if has_scheme || lower.starts_with("//") {
        return Err("Only relative local HTML embed paths are supported".into());
    }
    if decoded.contains('\\') {
        return Err("Backslashes are not allowed in HTML embed paths".into());
    }
    let path = PathBuf::from(&decoded);
    if path.is_absolute() || decoded.starts_with('/') || decoded.starts_with('~') {
        return Err("Absolute HTML embed paths are not allowed".into());
    }
    let encoded_source = source.to_ascii_lowercase();
    if encoded_source.contains("%2f") || encoded_source.contains("%5c") {
        return Err("Percent-encoded path separators are not allowed".into());
    }
    let has_encoded_parent = source.split('/').any(|segment| {
        segment != ".."
            && decode_embed_path(segment).is_ok_and(|decoded_segment| decoded_segment == "..")
    });
    if has_encoded_parent {
        return Err("Percent-encoded path traversal is not allowed".into());
    }
    if WorkspaceFileKind::classify(&path) != Some(WorkspaceFileKind::Html) {
        return Err("HTML embed requires an .html, .htm, or .xhtml file".into());
    }
    Ok(path)
}
