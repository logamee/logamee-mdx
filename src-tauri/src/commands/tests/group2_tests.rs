use super::fixtures2::*;
use super::fixtures3::*;

#[test]
fn workspace_image_open_returns_preview_metadata_without_utf8_decoding() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    fs::write(&image, [0x89, b'P', b'N', b'G']).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let response = open_workspace_file_inner(&state, &image).unwrap();

    assert_eq!(response.kind, WorkspaceFileKind::Image);
    assert_eq!(response.content, None);
    assert_eq!(response.mime_type.as_deref(), Some("image/png"));
}
#[test]
fn markdown_media_resolution_accepts_authorized_video_and_rejects_other_files() {
    let dir = tempdir().unwrap();
    let document = dir.path().join("guide.md");
    let video = dir.path().join("clip.m2ts");
    let image = dir.path().join("cover.png");
    fs::write(&document, "# guide").unwrap();
    fs::write(&video, b"video").unwrap();
    fs::write(&image, b"image").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    assert_eq!(
        resolve_markdown_media_inner(
            &state,
            document.to_str().unwrap(),
            Some(dir.path().to_str().unwrap()),
            "clip.m2ts",
        )
        .unwrap(),
        video.canonicalize().unwrap(),
    );
    assert_eq!(
        resolve_markdown_media_inner(
            &state,
            document.to_str().unwrap(),
            Some(dir.path().to_str().unwrap()),
            "cover.png",
        )
        .unwrap_err(),
        "Markdown media source is not a supported video",
    );
}
#[test]
fn workspace_media_resolution_requires_existing_audio_or_video_authority() {
    let dir = tempdir().unwrap();
    let video = dir.path().join("clip.mp4");
    let image = dir.path().join("cover.png");
    fs::write(&video, b"video").unwrap();
    fs::write(&image, b"image").unwrap();
    let state = AppState::default();

    assert!(resolve_workspace_media_inner(&state, &video).is_err());
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    assert_eq!(
        resolve_workspace_media_inner(&state, &video).unwrap(),
        video.canonicalize().unwrap().to_string_lossy(),
    );
    assert!(resolve_workspace_media_inner(&state, &image).is_err());
}
#[test]
fn workspace_html_open_returns_source_for_rendering() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    fs::write(&html, "<!doctype html><h1>Hello</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let response = open_workspace_file_inner(&state, &html).unwrap();

    assert_eq!(response.kind, WorkspaceFileKind::Html);
    assert_eq!(
        response.content.as_deref(),
        Some("<!doctype html><h1>Hello</h1>")
    );
    assert_eq!(response.mime_type.as_deref(), Some("text/html"));
}
#[test]
fn workspace_media_open_returns_preview_metadata_without_utf8_decoding() {
    let dir = tempdir().unwrap();
    let video = dir.path().join("clip.mp4");
    fs::write(&video, [0, 0, 0, 24, b'f', b't', b'y', b'p']).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let response = open_workspace_file_inner(&state, &video).unwrap();

    assert_eq!(response.kind, WorkspaceFileKind::Video);
    assert_eq!(response.content, None);
    assert_eq!(response.mime_type.as_deref(), Some("video/mp4"));
}
#[test]
fn authorized_workspace_image_reads_as_a_typed_data_url() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    let bytes = [0x89, b'P', b'N', b'G'];
    fs::write(&image, bytes).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let data_url = read_workspace_image_inner(&state, &image).unwrap();

    assert_eq!(
        data_url,
        format!("data:image/png;base64,{}", test_base64(&bytes))
    );
}
#[test]
fn workspace_image_read_requires_an_authorized_image_file() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    let markdown = dir.path().join("notes.md");
    fs::write(&image, [0x89, b'P', b'N', b'G']).unwrap();
    fs::write(&markdown, "# Notes").unwrap();
    let state = AppState::default();

    assert!(read_workspace_image_inner(&state, &image).is_err());

    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    assert_eq!(
        read_workspace_image_inner(&state, &markdown).unwrap_err(),
        "Workspace file is not a supported image"
    );
}
#[test]
fn markdown_excalidraw_embed_reads_a_valid_standalone_sibling() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("guide.md");
    let drawing = dir.path().join("system.excalidraw");
    fs::write(&markdown, "[system](system.excalidraw)").unwrap();
    fs::write(&drawing, default_excalidraw_scene()).unwrap();
    let state = AppState::default();
    open_standalone_file_with_ports_inner(
        &state,
        &markdown,
        |path| open_authorized_file_response(path.to_path_buf()),
        |_| Ok(()),
    )
    .unwrap();

    let content = read_markdown_excalidraw_inner(
        &state,
        markdown.to_str().unwrap(),
        None,
        "system.excalidraw",
    )
    .unwrap();

    assert_eq!(content, default_excalidraw_scene());
}
#[test]
fn markdown_excalidraw_embed_rejects_wrong_type_invalid_content_and_large_sources() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("guide.md");
    let html = dir.path().join("diagram.html");
    let invalid_utf8 = dir.path().join("invalid-utf8.excalidraw");
    let invalid_scene = dir.path().join("invalid-scene.excalidraw");
    let oversized = dir.path().join("oversized.excalidraw");
    fs::write(&markdown, "# Guide").unwrap();
    fs::write(&html, default_excalidraw_scene()).unwrap();
    fs::write(&invalid_utf8, [0xff, 0xfe]).unwrap();
    fs::write(&invalid_scene, "{}").unwrap();
    fs::write(
        &oversized,
        vec![b' '; EXCALIDRAW_EMBED_SOURCE_LIMIT_BYTES as usize + 1],
    )
    .unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    assert!(read_excalidraw_embed(&state, &markdown, dir.path(), "diagram.html").is_err());
    assert_eq!(
        read_excalidraw_embed(&state, &markdown, dir.path(), "invalid-utf8.excalidraw")
            .unwrap_err(),
        "Excalidraw embed is not valid UTF-8",
    );
    assert!(
        read_excalidraw_embed(&state, &markdown, dir.path(), "invalid-scene.excalidraw")
            .unwrap_err()
            .contains("Excalidraw scene")
    );
    assert_eq!(
        read_excalidraw_embed(&state, &markdown, dir.path(), "oversized.excalidraw").unwrap_err(),
        "Failed to read Excalidraw embed: Excalidraw embed exceeds the 16 MiB limit",
    );
}

fn read_excalidraw_embed(
    state: &AppState,
    markdown: &Path,
    workspace_root: &Path,
    source: &str,
) -> Result<String, String> {
    read_markdown_excalidraw_inner(
        state,
        markdown.to_str().unwrap(),
        Some(workspace_root.to_str().unwrap()),
        source,
    )
}
#[test]
fn markdown_write_command_rejects_an_opened_image() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    let original = [0x89, b'P', b'N', b'G'];
    fs::write(&image, original).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    open_workspace_file_inner(&state, &image).unwrap();

    let result = write_file_inner(&state, &image, "not an image");

    assert_confirmed_not_committed(result);
    assert_eq!(fs::read(&image).unwrap(), original);
}
#[test]
fn read_file_rejects_non_editable_binary_content_before_utf8_decode() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    fs::write(&image, "valid UTF-8 bytes inside a binary file").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    open_workspace_file_inner(&state, &image).unwrap();

    let result = read_file_inner(&state, &image);

    assert_eq!(
        result.unwrap_err(),
        "Only Markdown, HTML, and Excalidraw files can be read as text"
    );
}
