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
            "3g2", "3gp", "asf", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg",
            "ogv", "vob", "webm", "wmv",
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

mod policy_assertions;

#[test]
fn workspace_file_kind_policy_is_exhaustive() {
    policy_assertions::assert_all_kinds_are_covered_by_expected_policies();

    for policy in EXPECTED_POLICIES {
        policy_assertions::assert_policy_matches_expected_contract(policy);
    }

    policy_assertions::assert_unclassified_paths_and_extension_projections();
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
            policy_assertions::assert_pdf_docx_wire_policy(name, &path, wire_kind, expected_mime);
        }
    }

    policy_assertions::assert_pdf_and_docx_extension_registration();
}
