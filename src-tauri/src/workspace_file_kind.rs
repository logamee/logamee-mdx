use std::{fs::File, path::Path};

use serde::{Deserialize, Serialize};

use crate::{
    durable_write::read_versioned_open_file, excalidraw_scene::validate_excalidraw_scene,
    models::OpenFileResponse,
};

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "mdx", "markdown", "mdown", "mkd"];
const HTML_EXTENSIONS: &[&str] = &["html", "htm", "xhtml"];
const EXCALIDRAW_EXTENSIONS: &[&str] = &["excalidraw"];
const IMAGE_EXTENSIONS: &[&str] = &["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];
const VIDEO_EXTENSIONS: &[&str] = &[
    "3g2", "3gp", "asf", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv",
    "vob", "webm", "wmv",
];
const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba",
];
const PDF_EXTENSIONS: &[&str] = &["pdf"];
const DOCX_EXTENSIONS: &[&str] = &["docx"];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceFileKind {
    Markdown,
    Html,
    Excalidraw,
    Image,
    Video,
    Audio,
    Pdf,
    Docx,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ContentMode {
    Text,
    Binary,
}

impl WorkspaceFileKind {
    pub(crate) const ALL: &'static [Self] = &[
        Self::Markdown,
        Self::Html,
        Self::Excalidraw,
        Self::Image,
        Self::Video,
        Self::Audio,
        Self::Pdf,
        Self::Docx,
    ];

    pub(crate) fn classify(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        Self::ALL
            .iter()
            .copied()
            .find(|kind| kind.extensions().contains(&extension.as_str()))
    }

    pub(crate) const fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Markdown => MARKDOWN_EXTENSIONS,
            Self::Html => HTML_EXTENSIONS,
            Self::Excalidraw => EXCALIDRAW_EXTENSIONS,
            Self::Image => IMAGE_EXTENSIONS,
            Self::Video => VIDEO_EXTENSIONS,
            Self::Audio => AUDIO_EXTENSIONS,
            Self::Pdf => PDF_EXTENSIONS,
            Self::Docx => DOCX_EXTENSIONS,
        }
    }

    pub(crate) fn all_extensions() -> Vec<&'static str> {
        Self::ALL
            .iter()
            .flat_map(|kind| kind.extensions().iter().copied())
            .collect()
    }

    pub(crate) fn editable_extensions() -> Vec<&'static str> {
        Self::ALL
            .iter()
            .filter(|kind| kind.is_editable())
            .flat_map(|kind| kind.extensions().iter().copied())
            .collect()
    }

    pub(crate) const fn is_editable(self) -> bool {
        matches!(self, Self::Markdown | Self::Html | Self::Excalidraw)
    }

    pub(crate) const fn content_mode(self) -> ContentMode {
        if self.is_editable() {
            ContentMode::Text
        } else {
            ContentMode::Binary
        }
    }

    pub(crate) fn mime_type(self, path: &Path) -> Option<String> {
        match self {
            Self::Markdown | Self::Excalidraw => None,
            Self::Html
                if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("xhtml")) =>
            {
                Some("application/xhtml+xml".to_string())
            }
            Self::Html => Some("text/html".to_string()),
            Self::Image | Self::Video | Self::Audio => Some(
                mime_guess::from_path(path)
                    .first_or_octet_stream()
                    .to_string(),
            ),
            Self::Pdf => Some("application/pdf".to_string()),
            Self::Docx => Some(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_string(),
            ),
        }
    }

    pub(crate) fn allows_rename_to(self, path: &Path) -> bool {
        !matches!(self, Self::Pdf | Self::Docx) && Self::classify(path) == Some(self)
    }

    pub(crate) const fn requires_embedded_bytes(self) -> bool {
        matches!(self, Self::Pdf | Self::Docx)
    }

    pub(crate) fn open_response_from_handle(
        self,
        path: &Path,
        file: File,
    ) -> Result<OpenFileResponse, String> {
        if self.requires_embedded_bytes() {
            return Err("PDF and DOCX responses require validated binary bytes".to_string());
        }
        let content_mode = self.content_mode();
        let (content, file_version) = match content_mode {
            ContentMode::Text => {
                let observed = read_versioned_open_file(file, path, usize::MAX)
                    .map_err(|error| format!("Failed to read stable file contents: {error}"))?;
                let content = String::from_utf8(observed.bytes)
                    .map_err(|_| "Failed to read file: content is not valid UTF-8".to_string())?;
                (Some(content), Some(observed.version))
            }
            ContentMode::Binary => (None, None),
        };
        if self == Self::Excalidraw {
            let scene = content
                .as_deref()
                .ok_or_else(|| "Excalidraw scene response requires text content".to_string())?;
            validate_excalidraw_scene(scene)?;
        }
        Ok(OpenFileResponse {
            kind: self,
            path: path.to_string_lossy().to_string(),
            content_mode,
            file_version,
            content,
            mime_type: self.mime_type(path),
            bytes_base64: None,
        })
    }
}

#[cfg(test)]
mod tests;
