use super::prelude::*;
use super::super::*;

#[test]
fn serves_non_utf8_html_bytes_without_a_prepare_time_decode() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("notes.md");
    let html = dir.path().join("invalid.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, [0xff, 0xfe]).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let handle =
        acquire_markdown_html_embed_inner(&state, &markdown, "invalid.html", "main").unwrap();
    let response = http_request(&handle.url, "GET", &[]);

    assert_eq!(response_body(&response), [0xff, 0xfe]);
    release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn standalone_markdown_can_embed_a_sibling_without_html_write_authority() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("notes.md");
    let html = dir.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, markdown.clone()).unwrap();

    let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();

    assert!(http_get(&url).contains("<h1>Embed</h1>"));
    assert!(ensure_authorized_write_file_inner(&state, &html).is_err());
}
#[test]
fn isolates_preview_documents_on_separate_origins() {
    let dir = tempdir().unwrap();
    let first = dir.path().join("first.html");
    let second = dir.path().join("second.html");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let first_url = prepare_html_preview_inner(&state, &first, "first").unwrap();
    let second_url = prepare_html_preview_inner(&state, &second, "second").unwrap();
    let first_origin = first_url.rsplit_once('/').unwrap().0;
    let second_origin = second_url.rsplit_once('/').unwrap().0;

    assert_ne!(first_origin, second_origin);
}
#[test]
fn gives_workspace_pages_normal_root_relative_url_semantics() {
    let dir = tempdir().unwrap();
    let site = dir.path().join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    fs::write(&html, "<script src=\"/root.js\"></script>").unwrap();
    fs::write(dir.path().join("root.js"), "window.fromRoot = true;").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let url = prepare_html_preview_inner(&state, &html, "<script src=\"/root.js\"></script>")
        .unwrap();
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();

    let response = http_get(&format!("http://{address}/root.js"));
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("window.fromRoot = true;"));
}
#[test]
fn preview_scope_uses_the_most_specific_authorized_root() {
    let workspace = tempdir().unwrap();
    let site = workspace.path().join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    fs::write(&html, "<script src=\"app.js\"></script>").unwrap();
    fs::write(site.join("app.js"), "window.fromSite = true;").unwrap();
    fs::write(workspace.path().join("root.js"), "window.fromRoot = true;").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, html.clone()).unwrap();

    let url =
        prepare_html_preview_inner(&state, &html, "<script src=\"app.js\"></script>").unwrap();
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();

    assert!(!url.contains("/site/"));
    assert!(http_get(&format!("http://{address}/app.js")).starts_with("HTTP/1.1 200"));
    assert!(http_get(&format!("http://{address}/root.js")).starts_with("HTTP/1.1 404"));
}
#[test]
fn reprepare_applies_changed_authorized_scope_root() {
    let workspace = tempdir().unwrap();
    let (html, canonical_document) =
        write_reprepare_scope_files(workspace.path(), "<script src=\"/scope.js\"></script>");
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let wide_url =
        prepare_html_preview_inner(&state, &html, "<script src=\"/scope.js\"></script>")
            .unwrap();
    let wide_address = preview_origin(&wide_url);
    let wide_asset_url = format!("http://{wide_address}/scope.js");
    assert!(http_get(&wide_asset_url).contains("previewScope = 'wide'"));
    let old_worker_stop = state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .get(&canonical_document)
        .unwrap()
        .stop
        .clone();

    authorize_file_inner(&state, html.clone()).unwrap();
    let (narrow_url, reprepare_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &html, "<script src=\"/scope.js\"></script>")
    });
    let narrow_url = narrow_url.unwrap();

    assert_ne!(
        narrow_url, wide_url,
        "changed authorized root reused the old preview worker"
    );
    let narrow_address = preview_origin(&narrow_url);
    let narrow_asset_url = format!("http://{narrow_address}/scope.js");
    assert!(http_get(&narrow_asset_url).contains("previewScope = 'narrow'"));
    assert!(old_worker_stop.load(std::sync::atomic::Ordering::Acquire));
    assert_eq!(
        reprepare_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
        ]
    );
}
#[test]
fn failed_site_commit_rolls_back_only_new_preview_lease() {
    let workspace = tempdir().unwrap();
    let (html, canonical_document) = write_reprepare_scope_files(workspace.path(), "saved");
    let canonical_wide_root = normalize_existing_path(workspace.path()).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let old_content = "<h1>old preview</h1><script src=\"/scope.js\"></script>";
    let old_url = prepare_html_preview_inner(&state, &html, old_content).unwrap();
    let old_address = preview_origin(&old_url);
    let old_asset_url = format!("http://{old_address}/scope.js");
    let (old_lease, old_stop, old_server, old_content_state) =
        preview_site_handles(&state, &canonical_document);

    let (leases_before, sites_before) =
        prime_failed_commit_replacement(&state, &html, &old_lease);

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &html, "<h1>replacement preview</h1>")
    });
    let error = result.expect_err("injected replacement start must fail");
    assert_eq!(error, "injected replacement start failure");
    let leases_after = state.file_authorization().preview_lease_snapshot().unwrap();

    assert_eq!(
        leases_after, leases_before,
        "failed site commit leaked the newly reserved preview generation"
    );
    assert_eq!(
        state.html_preview_server.site_documents().unwrap(),
        sites_before,
        "failed replacement changed the preview site map"
    );
    assert_retained_failed_commit_site(
        &state,
        &canonical_document,
        &canonical_wide_root,
        &old_url,
        (&old_lease, &old_stop, &old_server, &old_content_state),
    );
    assert!(!old_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(http_get(&old_url).contains("<h1>old preview</h1>"));
    assert!(http_get(&old_asset_url).contains("previewScope = 'wide'"));
    assert_eq!(
        events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
        ]
    );
}
fn preview_origin(url: &str) -> &str {
    url.strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
}
fn write_reprepare_scope_files(
    workspace: &Path,
    html_content: &str,
) -> (PathBuf, PathBuf) {
    let site = workspace.join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    fs::write(&html, html_content).unwrap();
    fs::write(workspace.join("scope.js"), "window.previewScope = 'wide';").unwrap();
    fs::write(site.join("scope.js"), "window.previewScope = 'narrow';").unwrap();
    let canonical_html = normalize_existing_path(&html).unwrap();
    (html, canonical_html)
}
fn preview_site_handles(
    state: &AppState,
    canonical_document: &Path,
) -> (
    PreviewLeaseId,
    Arc<AtomicBool>,
    Arc<Server>,
    HtmlPreviewContent,
) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    let site = sites.get(canonical_document).unwrap();
    (
        site.lease.clone(),
        site.stop.clone(),
        site.server.clone(),
        site.content.clone(),
    )
}
fn prime_failed_commit_replacement(
    state: &AppState,
    html: &PathBuf,
    old_lease: &PreviewLeaseId,
) -> (HashSet<PreviewLeaseId>, HashSet<PathBuf>) {
    authorize_file_inner(state, html.clone()).unwrap();
    let leases_before = state.file_authorization().preview_lease_snapshot().unwrap();
    let sites_before = state.html_preview_server.site_documents().unwrap();
    assert_eq!(leases_before, HashSet::from([old_lease.clone()]));
    state
        .html_preview_server
        .fail_next_site_start("injected replacement start failure")
        .unwrap();
    (leases_before, sites_before)
}
fn assert_retained_failed_commit_site(
    state: &AppState,
    canonical_document: &Path,
    canonical_wide_root: &Path,
    old_url: &str,
    old_handles: (
        &PreviewLeaseId,
        &Arc<AtomicBool>,
        &Arc<Server>,
        &HtmlPreviewContent,
    ),
) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    let retained = sites.get(canonical_document).unwrap();
    assert_eq!(retained.url, old_url);
    assert_eq!(retained.root, canonical_wide_root);
    assert_eq!(retained.lease, old_handles.0.clone());
    assert!(std::sync::Arc::ptr_eq(&retained.stop, old_handles.1));
    assert!(std::sync::Arc::ptr_eq(&retained.server, old_handles.2));
    assert!(retained.content.shares_state_with(old_handles.3));
}
