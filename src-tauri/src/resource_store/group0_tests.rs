use super::test_prelude::*;
use super::*;

#[test]
fn writes_supported_image_under_authorized_resource_directory() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let response = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();

    assert_eq!(response.digest_md5.len(), 32);
    assert_eq!(
        response.relative_path,
        format!("assets/images/{}.png", response.digest_md5)
    );
    assert_eq!(response.markdown_path, response.relative_path);
    assert_eq!(response.file_name, format!("{}.png", response.digest_md5));
    assert!(response.created);
    assert_eq!(
        fs::read(dir.path().join(&response.relative_path)).unwrap(),
        PNG
    );
    assert!(fs::read_dir(dir.path().join("assets/images"))
        .unwrap()
        .all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
}
#[test]
fn deduplicates_identical_image_bytes_by_md5_name() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let first = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();
    let second = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();

    assert!(first.created);
    assert!(!second.created);
    assert_eq!(first.relative_path, second.relative_path);
    assert_eq!(first.digest_md5, second.digest_md5);
}
fn assert_workspace_reference_plans(root: &Path, document: &Path) {
    let plan = plan_picked_media_resource(
        root,
        document,
        &root.join("notes/pic.png"),
        WorkspaceFileKind::Image,
    )
    .unwrap();
    assert_eq!(
        plan,
        MediaPickPlan::Reference {
            markdown_path: "pic.png".to_string(),
            name: "pic.png".to_string(),
        }
    );

    let plan = plan_picked_media_resource(
        root,
        document,
        &root.join("assets/clip.mp4"),
        WorkspaceFileKind::Video,
    )
    .unwrap();
    assert_eq!(
        plan,
        MediaPickPlan::Reference {
            markdown_path: "../assets/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
        }
    );
}
fn assert_external_import_plan(root: &Path, document: &Path, external: &TempDir) {
    let plan = plan_picked_media_resource(
        root,
        document,
        &external.path().join("photo.jpg"),
        WorkspaceFileKind::Image,
    )
    .unwrap();
    assert_eq!(
        plan,
        MediaPickPlan::Import {
            source: external.path().join("photo.jpg"),
            name: "photo.jpg".to_string(),
        }
    );
}
#[test]
fn plans_workspace_references_and_external_imports_for_picked_media() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();
    let document = root.join("notes/draft.md");

    assert_workspace_reference_plans(&root, &document);

    assert!(plan_picked_media_resource(
        &root,
        &document,
        &root.join("notes/draft.md"),
        WorkspaceFileKind::Image
    )
    .is_err());

    let external = TempDir::new().unwrap();
    assert_external_import_plan(&root, &document, &external);
}
fn assert_video_import_and_image_deduplication(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    document_path: &Path,
    photo: &Path,
    clip: &Path,
    image_markdown: &str,
) {
    let video_markdown = import_picked_media_file(
        state,
        workspace,
        Path::new("assets"),
        document_path,
        WorkspaceFileKind::Video,
        clip,
        MAX_PICKED_AUDIO_VIDEO_BYTES,
    )
    .unwrap();
    assert!(video_markdown.starts_with("assets/"));
    assert!(video_markdown.ends_with(".mp4"));

    let again = import_picked_media_file(
        state,
        workspace,
        Path::new("assets"),
        document_path,
        WorkspaceFileKind::Image,
        photo,
        MAX_RESOURCE_BYTES as u64,
    )
    .unwrap();
    assert_eq!(again, image_markdown);
}
#[test]
fn imports_picked_external_media_into_the_resource_directory() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
    let document_path = Path::new(&root).join("draft.md");

    let external = TempDir::new().unwrap();
    let photo = external.path().join("vacation photo.png");
    fs::write(&photo, PNG).unwrap();
    let clip = external.path().join("clip.mp4");
    fs::write(&clip, b"video-bytes").unwrap();

    let image_markdown = import_picked_media_file(
        &state,
        &workspace,
        Path::new("assets"),
        &document_path,
        WorkspaceFileKind::Image,
        &photo,
        MAX_RESOURCE_BYTES as u64,
    )
    .unwrap();
    assert!(image_markdown.starts_with("assets/"));
    assert!(image_markdown.ends_with(".png"));
    assert_eq!(
        fs::read(
            Path::new(&root)
                .join("assets")
                .join(image_markdown.trim_start_matches("assets/"))
        )
        .unwrap(),
        PNG
    );

    assert_video_import_and_image_deduplication(
        &state,
        &workspace,
        &document_path,
        &photo,
        &clip,
        &image_markdown,
    );
}
#[test]
fn normalizes_picker_default_directory_for_windows_drive_roots() {
    assert_eq!(normalize_picker_default_directory("C:"), "C:/");
    assert_eq!(normalize_picker_default_directory("d:"), "d:/");
    assert_eq!(normalize_picker_default_directory("E:/"), "E:/");
    assert_eq!(
        normalize_picker_default_directory("/workspace/notes"),
        "/workspace/notes"
    );
    assert_eq!(normalize_picker_default_directory("  assets  "), "assets");
    assert_eq!(normalize_picker_default_directory(""), "");
}
#[test]
fn resolves_picker_default_directory_only_for_existing_directories() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("draft.md");
    fs::write(&file, b"# Draft").unwrap();

    assert_eq!(
        resolve_picked_default_directory(dir.path().to_string_lossy().as_ref()),
        Some(dir.path().to_path_buf())
    );
    assert_eq!(resolve_picked_default_directory(""), None);
    assert_eq!(resolve_picked_default_directory("   "), None);
    assert_eq!(resolve_picked_default_directory("/definitely/not/here"), None);
    assert_eq!(resolve_picked_default_directory(file.to_string_lossy().as_ref()), None);
}
#[test]
fn rejects_unverifiable_or_oversized_picked_media_imports() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
    let document_path = dir.path().join("draft.md");
    let external = TempDir::new().unwrap();

    let svg = external.path().join("icon.svg");
    fs::write(&svg, b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
    let error = import_picked_media_file(
        &state,
        &workspace,
        Path::new("assets"),
        &document_path,
        WorkspaceFileKind::Image,
        &svg,
        MAX_RESOURCE_BYTES as u64,
    )
    .unwrap_err();
    assert!(error.contains("SVG"));

    let disguised = external.path().join("not-really.png");
    fs::write(&disguised, b"<html>not an image</html>").unwrap();
    let error = import_picked_media_file(
        &state,
        &workspace,
        Path::new("assets"),
        &document_path,
        WorkspaceFileKind::Image,
        &disguised,
        MAX_RESOURCE_BYTES as u64,
    )
    .unwrap_err();
    assert!(error.contains("do not match"));

    let oversized = external.path().join("huge.png");
    fs::write(&oversized, PNG).unwrap();
    let error = import_picked_media_file(
        &state,
        &workspace,
        Path::new("assets"),
        &document_path,
        WorkspaceFileKind::Image,
        &oversized,
        4,
    )
    .unwrap_err();
    assert!(error.contains("size limit"));
}
