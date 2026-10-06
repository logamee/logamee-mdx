use super::prelude::*;
use super::super::*;

#[test]
fn file_authorization_serves_sibling_assets_but_not_parent_traversal() {
    let dir = tempdir().unwrap();
    let site = dir.path().join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    fs::write(&html, "<h1>Saved</h1>").unwrap();
    fs::write(site.join("app.js"), "window.ok = true;").unwrap();
    fs::write(dir.path().join("secret.txt"), "secret").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, html.clone()).unwrap();

    let url =
        prepare_html_preview_inner(&state, &html, "<script src=\"app.js\"></script>").unwrap();
    let base = url.rsplit_once('/').unwrap().0;

    assert!(http_get(&format!("{base}/app.js")).starts_with("HTTP/1.1 200"));
    assert!(http_get(&format!("{base}/%2e%2e/secret.txt")).starts_with("HTTP/1.1 403"));
}
#[cfg(unix)]
#[test]
fn rejects_symlink_assets_that_escape_the_preview_root() {
    use std::os::unix::fs::symlink;

    let dir = tempdir().unwrap();
    let site = dir.path().join("site");
    fs::create_dir(&site).unwrap();
    let html = site.join("index.html");
    let secret = dir.path().join("secret.txt");
    fs::write(&html, "<h1>Saved</h1>").unwrap();
    fs::write(&secret, "secret").unwrap();
    symlink(&secret, site.join("secret-link.txt")).unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, html.clone()).unwrap();

    let url = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>").unwrap();
    let linked_url = format!("{}/secret-link.txt", url.rsplit_once('/').unwrap().0);

    assert!(http_get(&linked_url).starts_with("HTTP/1.1 404"));
}
#[cfg(unix)]
#[test]
fn rejects_an_opened_file_when_the_request_path_is_swapped_after_open() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let secret = outside.path().join("secret.js");
    let requested = root.path().join("asset.js");
    fs::write(&secret, "window.secret = true;").unwrap();
    symlink(&secret, &requested).unwrap();
    let canonical_root = normalize_existing_path(root.path()).unwrap();

    let result = crate::html_preview_server::open_authorized_file_with(
        &requested,
        &canonical_root,
        || {
            fs::remove_file(&requested).unwrap();
            fs::write(&requested, "window.inside = true;").unwrap();
        },
        || {},
    );

    assert!(result.is_err());
}
#[cfg(unix)]
#[test]
fn rejects_an_opened_file_when_its_reported_path_is_swapped_before_validation() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let inside = root.path().join("inside.js");
    let secret = outside.path().join("secret.js");
    let retained_secret = outside.path().join("retained-secret.js");
    let requested = root.path().join("asset.js");
    fs::write(&inside, "window.inside = true;").unwrap();
    fs::write(&secret, "window.secret = true;").unwrap();
    symlink(&secret, &requested).unwrap();
    let canonical_root = normalize_existing_path(root.path()).unwrap();

    let result = crate::html_preview_server::open_authorized_file_with(
        &requested,
        &canonical_root,
        || {},
        || {
            fs::rename(&secret, &retained_secret).unwrap();
            symlink(&inside, &secret).unwrap();
        },
    );

    assert!(result.is_err());
}
#[test]
fn rejects_unknown_paths_and_forged_hosts() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    fs::write(&html, "<h1>Saved</h1>").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, html.clone()).unwrap();
    let url = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>").unwrap();
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();

    assert!(
        http_get(&format!("http://{address}/invalid/index.html")).starts_with("HTTP/1.1 404")
    );

    let response =
        http_request_with_host(address, "index.html", "GET", "attacker.example", &[]);
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 421"));
}
#[test]
fn supports_head_and_byte_ranges_for_preview_assets() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    fs::write(&html, "<video src=\"clip.mp4\"></video>").unwrap();
    fs::write(dir.path().join("clip.mp4"), b"0123456789").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, html.clone()).unwrap();
    let url =
        prepare_html_preview_inner(&state, &html, "<video src=\"clip.mp4\"></video>").unwrap();
    let asset_url = format!("{}/clip.mp4", url.rsplit_once('/').unwrap().0);

    let head = http_request(&asset_url, "HEAD", &[]);
    let head_text = String::from_utf8(head.clone()).unwrap();
    assert!(head_text.starts_with("HTTP/1.1 200"));
    assert!(head_text
        .to_ascii_lowercase()
        .contains("content-length: 10"));
    assert!(response_body(&head).is_empty());

    let range = http_request(&asset_url, "GET", &[("Range", "bytes=2-5")]);
    let headers = String::from_utf8_lossy(&range[..range.len() - response_body(&range).len()]);
    assert!(headers.starts_with("HTTP/1.1 206"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-range: bytes 2-5/10"));
    assert_eq!(response_body(&range), b"2345");
}
