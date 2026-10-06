use std::path::{Path, PathBuf};

use crate::{
    path_auth::{
        canonicalize_existing_path, ensure_authorized_directory_inner,
        ensure_authorized_existing_file_inner, is_authorized_preview_asset_path, path_is_under,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
};

#[derive(Clone, Copy)]
struct RelativeAssetLabels {
    lower: &'static str,
    title: &'static str,
}

const IMAGE_LABELS: RelativeAssetLabels = RelativeAssetLabels {
    lower: "image",
    title: "Image",
};
const MEDIA_LABELS: RelativeAssetLabels = RelativeAssetLabels {
    lower: "media",
    title: "Media",
};
const EXCALIDRAW_LABELS: RelativeAssetLabels = RelativeAssetLabels {
    lower: "Excalidraw embed",
    title: "Excalidraw embed",
};

fn decode_percent(input: &str, labels: RelativeAssetLabels) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(format!("Invalid percent-encoded {} path", labels.lower));
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| format!("Invalid {} path", labels.lower))?;
            let value = u8::from_str_radix(hex, 16)
                .map_err(|_| format!("Invalid percent-encoded {} path", labels.lower))?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("{} path is not valid UTF-8", labels.title))
}

fn strip_url_fragment_or_query(src: &str) -> &str {
    src.split(['?', '#']).next().unwrap_or(src)
}

fn has_rooted_path_syntax(path: &str) -> bool {
    let bytes = path.as_bytes();
    Path::new(path).is_absolute()
        || matches!(bytes.first(), Some(b'/') | Some(b'\\'))
        || matches!(bytes, [drive, b':', ..] if drive.is_ascii_alphabetic())
}

fn reject_unsafe_relative_asset_src(
    src: &str,
    labels: RelativeAssetLabels,
) -> Result<String, String> {
    let trimmed = strip_url_fragment_or_query(src.trim());
    if trimmed.is_empty() {
        return Err(format!("{} path is empty", labels.title));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("file:")
        || lower.starts_with("//")
    {
        return Err(format!(
            "Only relative local {} paths are supported",
            labels.lower
        ));
    }
    let decoded = decode_percent(trimmed, labels)?;
    if has_rooted_path_syntax(&decoded) || decoded.starts_with('~') {
        return Err(format!("Absolute {} paths are not allowed", labels.lower));
    }
    Ok(decoded)
}

#[cfg(test)]
fn reject_unsafe_relative_image_src(src: &str) -> Result<String, String> {
    reject_unsafe_relative_asset_src(src, IMAGE_LABELS)
}

fn resolve_relative_preview_asset_path_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    asset_src: &str,
    labels: RelativeAssetLabels,
) -> Result<PathBuf, String> {
    let current_file = ensure_authorized_existing_file_inner(state, current_file_path)?;
    if !current_file.is_file() {
        return Err("Current Markdown path is not a file".into());
    }
    let relative = reject_unsafe_relative_asset_src(asset_src, labels)?;
    let mut bases = vec![current_file
        .parent()
        .unwrap_or_else(|| Path::new("/"))
        .to_path_buf()];
    if let Some(root) = workspace_root.filter(|root| !root.trim().is_empty()) {
        let root = ensure_authorized_directory_inner(state, root)?;
        if !bases.iter().any(|base| base == &root) {
            bases.push(root);
        }
    }

    for base in bases {
        let candidate = base.join(&relative);
        let canonical = match canonicalize_existing_path(candidate) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("{} file is not accessible: {error}", labels.title));
            }
        };
        if !canonical.is_file() {
            continue;
        }
        if is_authorized_preview_asset_path(state, &canonical)? {
            return Ok(canonical);
        }
        return Err(format!(
            "Resolved {} escaped authorized roots",
            labels.lower
        ));
    }
    Err(format!("{} file not found", labels.title))
}

pub(crate) fn resolve_relative_image_path_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    image_src: &str,
) -> Result<PathBuf, String> {
    resolve_relative_preview_asset_path_inner(
        state,
        current_file_path,
        workspace_root,
        image_src,
        IMAGE_LABELS,
    )
}

pub(crate) fn resolve_relative_media_path_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    media_src: &str,
) -> Result<PathBuf, String> {
    resolve_relative_preview_asset_path_inner(
        state,
        current_file_path,
        workspace_root,
        media_src,
        MEDIA_LABELS,
    )
}

pub(crate) fn resolve_relative_excalidraw_path_inner(
    state: &AppState,
    current_file_path: &str,
    workspace_root: Option<&str>,
    excalidraw_src: &str,
) -> Result<PathBuf, String> {
    let current_file = ensure_authorized_existing_file_inner(state, current_file_path)?;
    if WorkspaceFileKind::classify(&current_file) != Some(WorkspaceFileKind::Markdown) {
        return Err("Excalidraw embed requires an authorized Markdown file".into());
    }
    let boundary = if let Some(root) = workspace_root.filter(|root| !root.trim().is_empty()) {
        let root = ensure_authorized_directory_inner(state, root)?;
        if !path_is_under(&current_file, &root) {
            return Err("Excalidraw embed Markdown file escaped the authorized workspace".into());
        }
        root
    } else {
        current_file
            .parent()
            .ok_or_else(|| "Markdown file has no parent directory".to_string())?
            .to_path_buf()
    };
    let target = resolve_relative_preview_asset_path_inner(
        state,
        current_file_path,
        None,
        excalidraw_src,
        EXCALIDRAW_LABELS,
    )?;
    if !path_is_under(&target, &boundary) {
        return Err("Excalidraw embed target escaped authorized roots".into());
    }
    if WorkspaceFileKind::classify(&target) != Some(WorkspaceFileKind::Excalidraw) {
        return Err("Excalidraw embed requires an .excalidraw file".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests;
