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
    "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm",
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
mod tests {
    use std::{fs, fs::File, path::Path};

    use super::{ContentMode, WorkspaceFileKind};
    use tempfile::tempdir;

    struct ExpectedPolicy {
        kind: WorkspaceFileKind,
        wire_value: &'static str,
        extensions: &'static [&'static str],
        content_mode: ContentMode,
        editable: bool,
        renameable: bool,
        requires_embedded_bytes: bool,
    }

    const EXPECTED_POLICIES: &[ExpectedPolicy] = &[
        ExpectedPolicy {
            kind: WorkspaceFileKind::Markdown,
            wire_value: "markdown",
            extensions: &["md", "mdx", "markdown", "mdown", "mkd"],
            content_mode: ContentMode::Text,
            editable: true,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Html,
            wire_value: "html",
            extensions: &["html", "htm", "xhtml"],
            content_mode: ContentMode::Text,
            editable: true,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Excalidraw,
            wire_value: "excalidraw",
            extensions: &["excalidraw"],
            content_mode: ContentMode::Text,
            editable: true,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Image,
            wire_value: "image",
            extensions: &["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"],
            content_mode: ContentMode::Binary,
            editable: false,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Video,
            wire_value: "video",
            extensions: &[
                "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm",
            ],
            content_mode: ContentMode::Binary,
            editable: false,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Audio,
            wire_value: "audio",
            extensions: &[
                "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba",
            ],
            content_mode: ContentMode::Binary,
            editable: false,
            renameable: true,
            requires_embedded_bytes: false,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Pdf,
            wire_value: "pdf",
            extensions: &["pdf"],
            content_mode: ContentMode::Binary,
            editable: false,
            renameable: false,
            requires_embedded_bytes: true,
        },
        ExpectedPolicy {
            kind: WorkspaceFileKind::Docx,
            wire_value: "docx",
            extensions: &["docx"],
            content_mode: ContentMode::Binary,
            editable: false,
            renameable: false,
            requires_embedded_bytes: true,
        },
    ];

    fn alternating_case(value: &str) -> String {
        value
            .chars()
            .enumerate()
            .map(|(index, character)| {
                if index % 2 == 0 {
                    character.to_ascii_uppercase()
                } else {
                    character.to_ascii_lowercase()
                }
            })
            .collect()
    }

    #[test]
    fn workspace_file_kind_policy_is_exhaustive() {
        let expected_kinds = EXPECTED_POLICIES
            .iter()
            .map(|policy| policy.kind)
            .collect::<Vec<_>>();
        assert_eq!(WorkspaceFileKind::ALL, expected_kinds.as_slice());

        for policy in EXPECTED_POLICIES {
            assert_eq!(policy.kind.extensions(), policy.extensions);
            assert_eq!(policy.kind.content_mode(), policy.content_mode);
            assert_eq!(policy.kind.is_editable(), policy.editable);
            assert_eq!(
                policy.kind.requires_embedded_bytes(),
                policy.requires_embedded_bytes
            );
            assert_eq!(
                serde_json::to_value(policy.kind).unwrap(),
                serde_json::json!(policy.wire_value)
            );

            for extension in policy.extensions {
                for variant in [
                    extension.to_string(),
                    extension.to_ascii_uppercase(),
                    alternating_case(extension),
                ] {
                    let path = format!("file.{variant}");
                    assert_eq!(
                        WorkspaceFileKind::classify(Path::new(&path)),
                        Some(policy.kind)
                    );
                    assert_eq!(
                        policy.kind.allows_rename_to(Path::new(&path)),
                        policy.renameable
                    );
                }

                let path = format!("file.{extension}");
                let mime_type = policy.kind.mime_type(Path::new(&path));
                match policy.kind {
                    WorkspaceFileKind::Markdown => assert_eq!(mime_type, None),
                    WorkspaceFileKind::Excalidraw => assert_eq!(mime_type, None),
                    WorkspaceFileKind::Html if *extension == "xhtml" => {
                        assert!(mime_type.is_some())
                    }
                    WorkspaceFileKind::Html => assert_eq!(mime_type.as_deref(), Some("text/html")),
                    WorkspaceFileKind::Image => {
                        assert!(mime_type.is_some_and(|value| value.starts_with("image/")))
                    }
                    WorkspaceFileKind::Video => {
                        assert!(mime_type.is_some_and(|value| value.starts_with("video/")))
                    }
                    WorkspaceFileKind::Audio => {
                        assert!(mime_type.is_some_and(|value| value.starts_with("audio/")))
                    }
                    WorkspaceFileKind::Pdf => {
                        assert_eq!(mime_type.as_deref(), Some("application/pdf"))
                    }
                    WorkspaceFileKind::Docx => assert_eq!(
                        mime_type.as_deref(),
                        Some(
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        )
                    ),
                }
            }

            for other in EXPECTED_POLICIES
                .iter()
                .filter(|candidate| candidate.kind != policy.kind)
            {
                let cross_kind_path = format!("file.{}", other.extensions[0]);
                assert!(!policy.kind.allows_rename_to(Path::new(&cross_kind_path)));
            }
            assert!(!policy.kind.allows_rename_to(Path::new("file.txt")));
            assert!(!policy.kind.allows_rename_to(Path::new("README")));
        }

        assert_eq!(WorkspaceFileKind::classify(Path::new("file.txt")), None);
        assert_eq!(WorkspaceFileKind::classify(Path::new("README")), None);
        assert_eq!(
            WorkspaceFileKind::all_extensions(),
            EXPECTED_POLICIES
                .iter()
                .flat_map(|policy| policy.extensions.iter().copied())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            WorkspaceFileKind::editable_extensions(),
            EXPECTED_POLICIES
                .iter()
                .filter(|policy| policy.editable)
                .flat_map(|policy| policy.extensions.iter().copied())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn xhtml_uses_application_xhtml_xml() {
        for path in ["page.xhtml", "page.XHTML", "page.XhTmL"] {
            assert_eq!(
                WorkspaceFileKind::classify(Path::new(path)),
                Some(WorkspaceFileKind::Html)
            );
            assert_eq!(
                WorkspaceFileKind::Html
                    .mime_type(Path::new(path))
                    .as_deref(),
                Some("application/xhtml+xml")
            );
        }

        for path in ["page.html", "page.HTML", "page.htm", "page.HTM"] {
            assert_eq!(
                WorkspaceFileKind::Html
                    .mime_type(Path::new(path))
                    .as_deref(),
                Some("text/html")
            );
        }
    }

    #[test]
    fn non_editable_open_never_reads_utf8_content() {
        let directory = tempdir().unwrap();
        let cases = [
            (WorkspaceFileKind::Image, "asset.png", "image/"),
            (WorkspaceFileKind::Video, "clip.mp4", "video/"),
            (WorkspaceFileKind::Audio, "track.mp3", "audio/"),
        ];

        for (expected_kind, name, expected_mime_family) in cases {
            let path = directory.path().join(name);
            fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
            let kind = WorkspaceFileKind::classify(&path).unwrap();

            let response = kind
                .open_response_from_handle(&path, File::open(&path).unwrap())
                .unwrap();

            assert_eq!(kind, expected_kind);
            assert_eq!(response.kind, expected_kind);
            assert_eq!(response.path, path.to_string_lossy());
            assert_eq!(response.content_mode, ContentMode::Binary);
            assert_eq!(response.content, None);
            assert!(response
                .mime_type
                .is_some_and(|mime_type| mime_type.starts_with(expected_mime_family)));
        }
    }

    #[test]
    fn pdf_and_docx_policy_is_binary_non_editable_and_non_renameable() {
        let cases = [
            ("report.pdf", "pdf", "application/pdf"),
            (
                "report.docx",
                "docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
        ];

        for (name, wire_kind, expected_mime) in cases {
            for path in [name.to_string(), name.to_ascii_uppercase()] {
                let path = Path::new(&path);
                let kind = WorkspaceFileKind::classify(path)
                    .unwrap_or_else(|| panic!("{name} must have a P2 workspace file kind"));

                assert_eq!(serde_json::to_value(kind).unwrap(), wire_kind);
                assert_eq!(kind.content_mode(), ContentMode::Binary);
                assert!(!kind.is_editable());
                assert_eq!(kind.mime_type(path).as_deref(), Some(expected_mime));
                assert!(!kind.allows_rename_to(path));
            }
        }

        let extensions = WorkspaceFileKind::all_extensions();
        assert!(extensions.contains(&"pdf"));
        assert!(extensions.contains(&"docx"));
        assert!(!WorkspaceFileKind::editable_extensions().contains(&"pdf"));
        assert!(!WorkspaceFileKind::editable_extensions().contains(&"docx"));
    }
}
