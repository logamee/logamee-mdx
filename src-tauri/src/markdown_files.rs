use std::{fs, path::Path};

pub(crate) fn read_markdown_file(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Path is not a file".into());
    }
    fs::read_to_string(path).map_err(|err| format!("Failed to read file: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::open_directory_inner, models::WorkspaceSnapshot,
        path_auth::normalize_existing_path, state::AppState,
        workspace_file_kind::WorkspaceFileKind, workspace_snapshot::EXCLUDED_WALK_DIRS,
    };
    use tempfile::tempdir;

    fn workspace_snapshot(root: &Path) -> WorkspaceSnapshot {
        open_directory_inner(&AppState::default(), root).unwrap()
    }

    #[test]
    fn classifies_the_complete_supported_extension_set_case_insensitively() {
        let supported = [
            (
                WorkspaceFileKind::Markdown,
                &["md", "mdx", "markdown", "mdown", "mkd"][..],
            ),
            (WorkspaceFileKind::Html, &["html", "htm", "xhtml"][..]),
            (
                WorkspaceFileKind::Image,
                &["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"][..],
            ),
            (
                WorkspaceFileKind::Video,
                &[
                    "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm",
                ][..],
            ),
            (
                WorkspaceFileKind::Audio,
                &[
                    "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba",
                ][..],
            ),
        ];

        for (kind, extensions) in supported {
            for extension in extensions {
                assert_eq!(
                    WorkspaceFileKind::classify(Path::new(&format!("file.{extension}"))),
                    Some(kind)
                );
                assert_eq!(
                    WorkspaceFileKind::classify(Path::new(&format!(
                        "file.{}",
                        extension.to_uppercase()
                    ))),
                    Some(kind)
                );
            }
        }
        assert_eq!(WorkspaceFileKind::classify(Path::new("file.txt")), None);
        assert_eq!(WorkspaceFileKind::classify(Path::new("README")), None);
    }

    #[test]
    fn lists_only_markdown_files_and_skips_symlinks() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/a.md"), "# a").unwrap();
        fs::write(dir.path().join("notes/b.txt"), "b").unwrap();
        let root = normalize_existing_path(dir.path()).unwrap();
        let files = workspace_snapshot(&root).files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "notes/a.md");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_lists_skip_symlink_files_and_directories() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("outside.md");
        let outside_directory = outside.path().join("assets");
        fs::write(&outside_file, "# outside").unwrap();
        fs::create_dir(&outside_directory).unwrap();
        symlink(&outside_file, workspace.path().join("linked.md")).unwrap();
        symlink(&outside_directory, workspace.path().join("linked-assets")).unwrap();
        let root = normalize_existing_path(workspace.path()).unwrap();
        let snapshot = workspace_snapshot(&root);

        assert!(snapshot.files.is_empty());
        assert!(snapshot.directories.is_empty());
    }

    #[test]
    fn excluded_directories_are_not_traversed_when_listing_markdown() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("visible.md"), "# visible").unwrap();
        for excluded in EXCLUDED_WALK_DIRS {
            let excluded_dir = dir.path().join(excluded);
            fs::create_dir(&excluded_dir).unwrap();
            fs::write(excluded_dir.join("hidden.md"), "# hidden").unwrap();
        }

        let root = normalize_existing_path(dir.path()).unwrap();
        let files = workspace_snapshot(&root).files;
        let rels: Vec<_> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(rels, vec!["visible.md"]);
    }

    #[test]
    fn lists_mdx_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("component.mdx"), "# mdx").unwrap();
        let root = normalize_existing_path(dir.path()).unwrap();
        let files = workspace_snapshot(&root).files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "component.mdx");
    }

    #[test]
    fn lists_supported_image_files_for_preview() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("doc.md"), "# doc").unwrap();
        fs::write(dir.path().join("cover.png"), b"png").unwrap();
        fs::write(dir.path().join("notes.txt"), "notes").unwrap();
        let root = normalize_existing_path(dir.path()).unwrap();

        let files = workspace_snapshot(&root).files;
        let rels: Vec<_> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        let kinds: Vec<_> = files.iter().map(|file| file.kind).collect();

        assert_eq!(rels, vec!["cover.png", "doc.md"]);
        assert_eq!(
            kinds,
            vec![WorkspaceFileKind::Image, WorkspaceFileKind::Markdown]
        );
    }

    #[test]
    fn lists_html_audio_and_video_files_for_preview() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        fs::write(dir.path().join("clip.mp4"), b"mp4").unwrap();
        fs::write(dir.path().join("stream.flv"), b"flv").unwrap();
        fs::write(dir.path().join("song.mp3"), b"mp3").unwrap();
        fs::write(dir.path().join("sample.wav"), b"wav").unwrap();
        fs::write(dir.path().join("archive.zip"), b"zip").unwrap();
        let root = normalize_existing_path(dir.path()).unwrap();

        let files = workspace_snapshot(&root).files;
        let entries: Vec<_> = files
            .iter()
            .map(|file| (file.relative_path.as_str(), file.kind))
            .collect();

        assert_eq!(
            entries,
            vec![
                ("clip.mp4", WorkspaceFileKind::Video),
                ("index.html", WorkspaceFileKind::Html),
                ("sample.wav", WorkspaceFileKind::Audio),
                ("song.mp3", WorkspaceFileKind::Audio),
                ("stream.flv", WorkspaceFileKind::Video),
            ]
        );
    }

    #[test]
    fn lists_empty_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/doc.md"), "# doc").unwrap();
        let root = normalize_existing_path(dir.path()).unwrap();
        let directories = workspace_snapshot(&root).directories;
        let rels: Vec<_> = directories
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect();
        assert_eq!(rels, vec!["empty", "notes"]);
    }
}
