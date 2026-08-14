use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{
    durable_write::{
        capture_file_version, durable_remove_exact, durable_write, DurableWriteOutcome,
        ExpectedFileState, FileVersion,
    },
    state::AppState,
};

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ExportKind {
    Html,
    Png,
}

impl ExportKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Png => "png",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Html => "Offline HTML",
            Self::Png => "PNG image",
        }
    }

    fn validate(self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Html
                if std::str::from_utf8(bytes).is_ok() && bytes.starts_with(b"<!doctype html>") =>
            {
                Ok(())
            }
            Self::Png if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(()),
            Self::Html => Err("HTML export must be a UTF-8 standalone document".to_string()),
            Self::Png => Err("PNG export bytes are invalid".to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveExportRequest {
    kind: ExportKind,
    default_name: String,
    bytes_base64: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveExportResponse {
    path: String,
    bytes_written: usize,
}

fn decode_export_bytes(input: &SaveExportRequest) -> Result<Vec<u8>, String> {
    if input.default_name.trim().is_empty() || input.default_name.len() > 255 {
        return Err("Export file name is invalid".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(&input.bytes_base64)
        .map_err(|_| "Export payload is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES {
        return Err("Export payload exceeds the supported size limit".to_string());
    }
    input.kind.validate(&bytes)?;
    Ok(bytes)
}

fn write_export_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let expected = capture_file_version(path)
        .map_err(|error| format!("Cannot inspect export destination: {error}"))?
        .map_or(ExpectedFileState::Absent, |version| {
            ExpectedFileState::Exact { version }
        });
    match durable_write(path, bytes, &expected)
        .map_err(|error| format!("Cannot write export: {error}"))?
    {
        DurableWriteOutcome::ConfirmedCommitted { .. } => Ok(()),
        DurableWriteOutcome::ConfirmedNotCommitted { message, .. } => Err(message),
        DurableWriteOutcome::Conflict { .. } => {
            Err("Export destination changed before it could be written".to_string())
        }
        DurableWriteOutcome::Indeterminate { .. } => {
            Err("Export result could not be verified".to_string())
        }
    }
}

#[tauri::command]
pub(crate) async fn save_export_dialog(
    app: AppHandle,
    input: SaveExportRequest,
    _state: State<'_, AppState>,
) -> Result<Option<SaveExportResponse>, String> {
    let bytes = decode_export_bytes(&input)?;
    let extension = input.kind.extension();
    let default_name = if input
        .default_name
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        input.default_name.clone()
    } else {
        format!("{}.{}", input.default_name, extension)
    };
    let selected = app
        .dialog()
        .file()
        .add_filter(input.kind.label(), &[extension])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Invalid export path: {error}"))?;
    write_export_file(&path, &bytes)?;
    Ok(Some(SaveExportResponse {
        path: path.to_string_lossy().to_string(),
        bytes_written: bytes.len(),
    }))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveExcalidrawBundleRequest {
    base_name: String,
    source: String,
    svg_base64: String,
    png_1x_base64: String,
    png_2x_base64: String,
    png_3x_base64: String,
}

fn safe_bundle_base_name(name: &str) -> Result<String, String> {
    let name = name.trim().trim_end_matches(".excalidraw");
    if name.is_empty()
        || name.len() > 128
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
    {
        return Err("Excalidraw export name is invalid".to_string());
    }
    Ok(name.to_string())
}

fn decode_png(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Excalidraw PNG payload is invalid".to_string())?;
    if bytes.is_empty()
        || bytes.len() > MAX_EXPORT_BYTES
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return Err("Excalidraw PNG payload is invalid".to_string());
    }
    Ok(bytes)
}

fn publish_new_bundle(
    directory: &Path,
    files: &[(String, Vec<u8>)],
) -> Result<Vec<PathBuf>, String> {
    let mut published: Vec<(PathBuf, FileVersion)> = Vec::new();
    let rollback = |published: &[(PathBuf, FileVersion)]| {
        for (created, version) in published.iter().rev() {
            let _ = durable_remove_exact(created, version);
        }
    };
    for (name, bytes) in files {
        let path = directory.join(name);
        if path.exists() {
            rollback(&published);
            return Err(
                "An Excalidraw export file already exists in the selected folder".to_string(),
            );
        }
        match durable_write(&path, bytes, &ExpectedFileState::Absent) {
            Ok(DurableWriteOutcome::ConfirmedCommitted { version, .. }) => {
                published.push((path, version))
            }
            _ => {
                rollback(&published);
                return Err("Excalidraw bundle could not be written completely".to_string());
            }
        }
    }
    Ok(published.into_iter().map(|(path, _)| path).collect())
}

#[tauri::command]
pub(crate) async fn save_excalidraw_bundle_dialog(
    app: AppHandle,
    input: SaveExcalidrawBundleRequest,
) -> Result<Option<Vec<String>>, String> {
    let base = safe_bundle_base_name(&input.base_name)?;
    crate::excalidraw_scene::validate_excalidraw_scene(&input.source)?;
    let svg = BASE64_STANDARD
        .decode(&input.svg_base64)
        .map_err(|_| "Excalidraw SVG payload is invalid".to_string())?;
    if svg.is_empty()
        || svg.len() > MAX_EXPORT_BYTES
        || !String::from_utf8_lossy(&svg)
            .trim_start()
            .starts_with("<svg")
    {
        return Err("Excalidraw SVG payload is invalid".to_string());
    }
    let files = vec![
        (format!("{base}.excalidraw"), input.source.into_bytes()),
        (format!("{base}.svg"), svg),
        (format!("{base}@1x.png"), decode_png(&input.png_1x_base64)?),
        (format!("{base}@2x.png"), decode_png(&input.png_2x_base64)?),
        (format!("{base}@3x.png"), decode_png(&input.png_3x_base64)?),
    ];
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let directory = selected
        .into_path()
        .map_err(|error| format!("Invalid export folder: {error}"))?;
    Ok(Some(
        publish_new_bundle(&directory, &files)?
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validates_export_payloads_and_writes_exact_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.html");
        let bytes = b"<!doctype html><title>ok</title>";
        let request = SaveExportRequest {
            kind: ExportKind::Html,
            default_name: "report".to_string(),
            bytes_base64: BASE64_STANDARD.encode(bytes),
        };
        assert_eq!(decode_export_bytes(&request).unwrap(), bytes);
        write_export_file(&path, bytes).unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn bundle_is_all_new_and_rolls_back_partial_publication() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("drawing.svg"), b"occupied").unwrap();
        let files = vec![
            ("drawing.excalidraw".to_string(), b"source".to_vec()),
            ("drawing.svg".to_string(), b"svg".to_vec()),
        ];
        assert!(publish_new_bundle(directory.path(), &files).is_err());
        assert!(!directory.path().join("drawing.excalidraw").exists());
        assert_eq!(
            fs::read(directory.path().join("drawing.svg")).unwrap(),
            b"occupied"
        );
    }

    #[test]
    fn rejects_invalid_bundle_names_and_image_signatures() {
        assert!(safe_bundle_base_name("../drawing").is_err());
        assert!(decode_png(&BASE64_STANDARD.encode(b"not png")).is_err());
    }
}
