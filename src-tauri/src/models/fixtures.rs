use serde_json::json;

use super::*;

#[derive(Serialize)]
pub(crate) struct FixtureWorkspaceFileEntry {
    kind: WorkspaceFileKind,
    path: &'static str,
    relative_path: &'static str,
    name: &'static str,
}

#[derive(Serialize)]
pub(crate) struct FixtureWorkspaceDirectoryEntry {
    path: &'static str,
    relative_path: &'static str,
    name: &'static str,
}

#[derive(Serialize)]
pub(crate) struct FixtureWorkspaceSnapshot {
    workspace_token: &'static str,
    root: &'static str,
    files: Vec<FixtureWorkspaceFileEntry>,
    directories: Vec<FixtureWorkspaceDirectoryEntry>,
}

pub(crate) fn fixture_snapshot() -> FixtureWorkspaceSnapshot {
    FixtureWorkspaceSnapshot {
        workspace_token: "workspace-7",
        root: "/workspace",
        files: vec![
            FixtureWorkspaceFileEntry {
                kind: WorkspaceFileKind::Markdown,
                path: "/workspace/notes.md",
                relative_path: "notes.md",
                name: "notes.md",
            },
            FixtureWorkspaceFileEntry {
                kind: WorkspaceFileKind::Html,
                path: "/workspace/page.xhtml",
                relative_path: "page.xhtml",
                name: "page.xhtml",
            },
            FixtureWorkspaceFileEntry {
                kind: WorkspaceFileKind::Image,
                path: "/workspace/assets/pixel.png",
                relative_path: "assets/pixel.png",
                name: "pixel.png",
            },
            FixtureWorkspaceFileEntry {
                kind: WorkspaceFileKind::Video,
                path: "/workspace/assets/clip.mp4",
                relative_path: "assets/clip.mp4",
                name: "clip.mp4",
            },
            FixtureWorkspaceFileEntry {
                kind: WorkspaceFileKind::Audio,
                path: "/workspace/assets/track.mp3",
                relative_path: "assets/track.mp3",
                name: "track.mp3",
            },
        ],
        directories: vec![FixtureWorkspaceDirectoryEntry {
            path: "/workspace/assets",
            relative_path: "assets",
            name: "assets",
        }],
    }
}

pub(crate) fn fixture_file_version(
    canonical_path: &str,
    platform_identity: &str,
    length: &str,
    modified_nanos: &str,
    sha256: &str,
) -> FileVersion {
    serde_json::from_value(json!({
        "canonicalPath": canonical_path,
        "platformIdentity": platform_identity,
        "length": length,
        "modifiedNanos": modified_nanos,
        "sha256": sha256,
    }))
    .unwrap()
}

pub(crate) fn markdown_open_file_response(
    path: &str,
    length: &str,
    modified_nanos: &str,
    sha256_letter: char,
    content: &str,
) -> OpenFileResponse {
    OpenFileResponse {
        kind: WorkspaceFileKind::Markdown,
        path: path.to_string(),
        content_mode: ContentMode::Text,
        file_version: Some(fixture_file_version(
            path,
            "1",
            length,
            modified_nanos,
            &sha256_letter.to_string().repeat(64),
        )),
        content: Some(content.to_string()),
        mime_type: None,
        bytes_base64: None,
    }
}

fn html_open_file_response() -> OpenFileResponse {
    OpenFileResponse {
        kind: WorkspaceFileKind::Html,
        path: "/workspace/page.xhtml".to_string(),
        content_mode: ContentMode::Text,
        file_version: Some(fixture_file_version(
            "/workspace/page.xhtml",
            "2",
            "17",
            "2",
            &"b".repeat(64),
        )),
        content: Some("<main>Page</main>".to_string()),
        mime_type: Some("application/xhtml+xml".to_string()),
        bytes_base64: None,
    }
}

fn binary_open_file_response(
    kind: WorkspaceFileKind,
    path: &str,
    mime_type: &str,
) -> OpenFileResponse {
    OpenFileResponse {
        kind,
        path: path.to_string(),
        content_mode: ContentMode::Binary,
        file_version: None,
        content: None,
        mime_type: Some(mime_type.to_string()),
        bytes_base64: None,
    }
}

pub(crate) fn open_file_responses() -> Vec<OpenFileResponse> {
    vec![
        markdown_open_file_response("/workspace/notes.md", "7", "1", 'a', "# Notes"),
        html_open_file_response(),
        binary_open_file_response(
            WorkspaceFileKind::Image,
            "/workspace/assets/pixel.png",
            "image/png",
        ),
        binary_open_file_response(
            WorkspaceFileKind::Video,
            "/workspace/assets/clip.mp4",
            "video/mp4",
        ),
        binary_open_file_response(
            WorkspaceFileKind::Audio,
            "/workspace/assets/track.mp3",
            "audio/mpeg",
        ),
    ]
}
