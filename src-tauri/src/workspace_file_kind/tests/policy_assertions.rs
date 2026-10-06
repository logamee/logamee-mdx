//! Grouped assertion helpers for the exhaustive workspace file kind policy
//! tests. Each helper covers one stage (kind coverage, per-kind contract,
//! extension classification, mime projection, rename scoping).

use std::path::Path;

use super::*;

pub(super) fn assert_all_kinds_are_covered_by_expected_policies() {
    let expected_kinds = EXPECTED_POLICIES
        .iter()
        .map(|policy| policy.kind)
        .collect::<Vec<_>>();
    assert_eq!(WorkspaceFileKind::ALL, expected_kinds.as_slice());
}

pub(super) fn assert_policy_matches_expected_contract(policy: &ExpectedPolicy) {
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
        assert_extension_variants_classify_as(policy, extension);
        assert_extension_mime_type(policy, extension);
    }

    assert_rename_policy_is_scoped_to_kind(policy);
}

pub(super) fn assert_unclassified_paths_and_extension_projections() {
    assert_eq!(WorkspaceFileKind::classify(Path::new("file.txt")), None);
    assert_eq!(WorkspaceFileKind::classify(Path::new("README")), None);
    assert_ne!(
        WorkspaceFileKind::classify(Path::new("source.ts")),
        Some(WorkspaceFileKind::Video)
    );
    assert_ne!(
        WorkspaceFileKind::classify(Path::new("module.mts")),
        Some(WorkspaceFileKind::Video)
    );
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

pub(super) fn assert_pdf_docx_wire_policy(
    name: &str,
    path: &str,
    wire_kind: &str,
    expected_mime: &str,
) {
    let path = Path::new(path);
    let kind = WorkspaceFileKind::classify(path)
        .unwrap_or_else(|| panic!("{name} must have a P2 workspace file kind"));

    assert_eq!(serde_json::to_value(kind).unwrap(), wire_kind);
    assert_eq!(kind.content_mode(), ContentMode::Binary);
    assert!(!kind.is_editable());
    assert_eq!(kind.mime_type(path).as_deref(), Some(expected_mime));
    assert!(!kind.allows_rename_to(path));
}

pub(super) fn assert_pdf_and_docx_extension_registration() {
    let extensions = WorkspaceFileKind::all_extensions();
    assert!(extensions.contains(&"pdf"));
    assert!(extensions.contains(&"docx"));
    assert!(!WorkspaceFileKind::editable_extensions().contains(&"pdf"));
    assert!(!WorkspaceFileKind::editable_extensions().contains(&"docx"));
}

fn assert_extension_variants_classify_as(policy: &ExpectedPolicy, extension: &str) {
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
}

fn assert_extension_mime_type(policy: &ExpectedPolicy, extension: &str) {
    let path = format!("file.{extension}");
    let mime_type = policy.kind.mime_type(Path::new(&path));
    match policy.kind {
        WorkspaceFileKind::Markdown | WorkspaceFileKind::Excalidraw | WorkspaceFileKind::Html => {
            assert_text_kind_mime_type(policy.kind, extension, mime_type)
        }
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
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        ),
    }
}

fn assert_text_kind_mime_type(kind: WorkspaceFileKind, extension: &str, mime_type: Option<String>) {
    if matches!(
        kind,
        WorkspaceFileKind::Markdown | WorkspaceFileKind::Excalidraw
    ) {
        assert_eq!(mime_type, None);
    } else {
        assert_html_mime_type(extension, mime_type);
    }
}

fn assert_html_mime_type(extension: &str, mime_type: Option<String>) {
    if extension == "xhtml" {
        assert!(mime_type.is_some())
    } else {
        assert_eq!(mime_type.as_deref(), Some("text/html"))
    }
}

fn assert_rename_policy_is_scoped_to_kind(policy: &ExpectedPolicy) {
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
