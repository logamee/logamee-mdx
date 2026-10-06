use super::prelude::*;
use super::super::*;

#[test]
fn serves_authorized_media_with_range_support_over_loopback_http() {
    let dir = tempdir().unwrap();
    let video = dir.path().join("clip.mp4");
    let bytes = b"synthetic media bytes";
    fs::write(&video, bytes).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let handle = prepare_media_preview_inner(&state, &video, "main").unwrap();
    let response = http_request(&handle.url, "GET", &[]);
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    assert!(String::from_utf8_lossy(&response).contains("Content-Type: video/mp4"));
    assert!(String::from_utf8_lossy(&response).contains("Access-Control-Allow-Origin: *"));
    assert_eq!(response_body(&response), bytes);

    let ranged = http_request(&handle.url, "GET", &[("Range", "bytes=2-6")]);
    assert!(String::from_utf8_lossy(&ranged).starts_with("HTTP/1.1 206"));
    assert_eq!(response_body(&ranged), b"nthet");
    let address = handle
        .url
        .strip_prefix("http://")
        .unwrap()
        .split_once('/')
        .unwrap()
        .0;
    let unauthorized = http_request_with_host(address, "clip.mp4", "GET", address, &[]);
    assert!(String::from_utf8_lossy(&unauthorized).starts_with("HTTP/1.1 403"));

    release_media_preview_inner(&state, handle.owner_id, "main").unwrap();
}
#[test]
fn media_preview_does_not_commit_a_revoked_lease() {
    let workspace = tempdir().unwrap();
    let video = workspace.path().join("clip.mp4");
    fs::write(&video, b"synthetic media bytes").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();

    crate::html_preview_server::preview_commit_test_probe::before_next_commit(move |state, _lease| {
        revoke_authorized_path_prefix_inner(state, &canonical_root).unwrap();
    });

    let error = prepare_media_preview_inner(&state, &video, "main")
        .expect_err("a revoked media lease must not be committed");

    assert_eq!(error, crate::html_preview_server::PREVIEW_AUTHORIZATION_CHANGED_ERROR);
    assert!(state
        .html_preview_server
        .site_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn serves_live_html_and_relative_assets_over_loopback_http() {
    let dir = tempdir().unwrap();
    let site = dir.path().join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    fs::write(&html, "<h1>Saved</h1>").unwrap();
    fs::write(site.join("app.js"), "window.previewLoaded = true;").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let url = prepare_html_preview_inner(
        &state,
        &html,
        "<h1>Unsaved</h1><script src=\"app.js\"></script>",
    )
    .unwrap();

    assert!(url.starts_with("http://127.0.0.1:"));
    let html_response = http_get(&url);
    assert!(html_response.starts_with("HTTP/1.1 200"));
    assert!(html_response.contains("<h1>Unsaved</h1>"));
    assert!(!html_response
        .to_ascii_lowercase()
        .contains("access-control-allow-origin"));

    let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
    let asset_response = http_get(&asset_url);
    assert!(asset_response.starts_with("HTTP/1.1 200"));
    assert!(asset_response.contains("window.previewLoaded = true;"));
    assert!(!asset_response
        .to_ascii_lowercase()
        .contains("access-control-allow-origin"));

    let updated_url =
        prepare_html_preview_inner(&state, &html, "<h1>Updated again</h1>").unwrap();
    assert_eq!(updated_url, url);
    assert!(http_get(&updated_url).contains("<h1>Updated again</h1>"));
}
#[test]
fn prepares_relative_html_embed_from_authorized_markdown() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("notes.md");
    let embed_dir = dir.path().join("embed");
    fs::create_dir(&embed_dir).unwrap();
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(
        embed_dir.join("index.html"),
        "<h1>Embedded</h1><script src=\"app.js\"></script>",
    )
    .unwrap();
    fs::write(embed_dir.join("app.js"), "window.embedded = true;").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed/index.html")
        .expect("authorized relative HTML should be prepared");

    let response = http_get(&url);
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("<h1>Embedded</h1>"));
    let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
    assert!(http_get(&asset_url).contains("window.embedded = true;"));
}
#[test]
fn nested_markdown_embeds_parent_html_within_authorized_workspace() {
    let workspace = tempdir().unwrap();
    let notes = workspace.path().join("notes");
    let shared = workspace.path().join("shared");
    fs::create_dir(&notes).unwrap();
    fs::create_dir(&shared).unwrap();
    let markdown = notes.join("guide.md");
    fs::write(&markdown, "# Guide").unwrap();
    fs::write(
        shared.join("embed.html"),
        "<h1>Workspace embed</h1><script src=\"app.js\"></script>",
    )
    .unwrap();
    fs::write(shared.join("app.js"), "window.workspaceEmbed = true;").unwrap();
    fs::write(
        workspace.path().join("unrelated.js"),
        "window.unrelated = true;",
    )
    .unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let url = prepare_markdown_html_embed_in_workspace_inner(
        &state,
        &markdown,
        "../shared/embed.html",
        workspace.path(),
    )
    .expect("a parent-relative embed inside the authorized workspace should be prepared");

    assert!(http_get(&url).contains("<h1>Workspace embed</h1>"));
    let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
    assert!(http_get(&asset_url).contains("window.workspaceEmbed = true;"));
    let authority = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    assert!(http_get(&format!("http://{authority}/unrelated.js")).starts_with("HTTP/1.1 404"));
}
#[test]
fn parent_relative_html_embed_cannot_escape_authorized_workspace() {
    let container = tempdir().unwrap();
    let workspace = container.path().join("workspace");
    let notes = workspace.join("notes");
    fs::create_dir_all(&notes).unwrap();
    let markdown = notes.join("guide.md");
    fs::write(&markdown, "# Guide").unwrap();
    fs::write(container.path().join("outside.html"), "outside").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.clone()).unwrap();

    let error = prepare_markdown_html_embed_in_workspace_inner(
        &state,
        &markdown,
        "../../outside.html",
        &workspace,
    )
    .expect_err("a parent-relative embed must remain inside its authorized workspace");

    assert!(error.contains("workspace"));
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn standalone_preview_does_not_commit_a_lease_revoked_before_site_commit() {
    let workspace = tempdir().unwrap();
    let html = workspace.path().join("preview.html");
    fs::write(&html, "<h1>Saved</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();

    crate::html_preview_server::preview_commit_test_probe::before_next_commit(move |state, _lease| {
        revoke_authorized_path_prefix_inner(state, &canonical_root).unwrap();
    });

    let error = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>")
        .expect_err("a revoked preview lease must not be committed");

    assert_eq!(
        error,
        "HTML preview authorization changed before the site was committed"
    );
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn markdown_embed_does_not_commit_a_lease_revoked_before_site_commit() {
    let workspace = tempdir().unwrap();
    let markdown = workspace.path().join("notes.md");
    let html = workspace.path().join("embed.html");
    fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
    fs::write(&html, "<button>Click</button>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();

    crate::html_preview_server::preview_commit_test_probe::before_next_commit(move |state, _lease| {
        revoke_authorized_path_prefix_inner(state, &canonical_root).unwrap();
    });

    let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
        .expect_err("a revoked embed lease must not be committed");

    assert_eq!(
        error,
        "HTML preview authorization changed before the site was committed"
    );
    assert!(state
        .html_preview_server
        .site_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
