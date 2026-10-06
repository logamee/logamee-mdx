use super::prelude::*;
use super::super::*;

#[test]
fn window_cleanup_removes_only_that_windows_owners_until_the_final_window_closes() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Shared embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    let main_first =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let main_second =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let popout =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "popout").unwrap();
    let (key, lease, stop) = embed_site_key_and_handles(&state, &markdown, &html);

    release_markdown_html_embed_window_inner(&state, "main").unwrap();

    {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let site = sites.embeds.get(&key).unwrap();
        assert_eq!(site.lease, lease);
        assert_eq!(
            site.owners,
            HashMap::from([(popout.owner_id, "popout".into())])
        );
        assert!(!site.owners.contains_key(&main_first.owner_id));
        assert!(!site.owners.contains_key(&main_second.owner_id));
    }
    assert!(!stop.load(Ordering::Acquire));
    assert_eq!(
        state.file_authorization().preview_lease_snapshot().unwrap(),
        HashSet::from([lease])
    );

    release_markdown_html_embed_window_inner(&state, "popout").unwrap();

    assert!(stop.load(Ordering::Acquire));
    assert!(state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .embeds
        .is_empty());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
fn embed_site_key_and_handles(
    state: &AppState,
    markdown: &Path,
    html: &Path,
) -> (HtmlEmbedSiteKey, PreviewLeaseId, Arc<AtomicBool>) {
    let key = HtmlEmbedSiteKey {
        anchor: normalize_existing_path(markdown).unwrap(),
        document: normalize_existing_path(html).unwrap(),
    };
    let sites = state.html_preview_server.sites.lock().unwrap();
    let site = sites.embeds.get(&key).unwrap();
    (key, site.lease.clone(), site.stop.clone())
}
#[test]
fn poisoned_site_map_window_cleanup_stops_drained_sites_and_retires_their_leases() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Shared embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let stop = state
        .html_preview_server
        .embed_stop_flag_for_test(&markdown, &html)
        .unwrap();

    let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _sites = state.html_preview_server.sites.lock().unwrap();
        panic!("injected HTML site map poison before window cleanup");
    }));
    assert!(poison.is_err());
    assert!(state.html_preview_server.sites.is_poisoned());

    let _cleanup_result = release_markdown_html_embed_window_inner(&state, "main");

    assert!(!state.html_preview_server.sites.is_poisoned());
    assert!(state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .embeds
        .is_empty());
    assert!(stop.load(Ordering::Acquire));
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn renaming_the_markdown_anchor_stops_its_active_embed_site() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let renamed_markdown = directory.path().join("renamed.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let canonical_markdown = normalize_existing_path(&markdown).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    let handle =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let stop = state
        .html_preview_server
        .embed_stop_flag_for_test(&markdown, &html)
        .unwrap();

    fs::rename(&markdown, &renamed_markdown).unwrap();
    let canonical_renamed_markdown = normalize_existing_path(&renamed_markdown).unwrap();
    relocate_authorized_path_prefix_inner(
        &state,
        &canonical_markdown,
        &canonical_renamed_markdown,
    )
    .unwrap();

    assert!(stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
}
#[test]
fn two_markdown_anchors_have_independent_embed_lifetimes() {
    let directory = tempdir().unwrap();
    let first_markdown = directory.path().join("first.md");
    let renamed_first_markdown = directory.path().join("renamed-first.md");
    let second_markdown = directory.path().join("second.md");
    let html = directory.path().join("embed.html");
    fs::write(&first_markdown, "# First").unwrap();
    fs::write(&second_markdown, "# Second").unwrap();
    fs::write(&html, "<h1>Shared embed</h1>").unwrap();
    let canonical_first_markdown = normalize_existing_path(&first_markdown).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    let first =
        acquire_markdown_html_embed_inner(&state, &first_markdown, "embed.html", "main")
            .unwrap();
    let second =
        acquire_markdown_html_embed_inner(&state, &second_markdown, "embed.html", "main")
            .unwrap();
    assert_ne!(first.url, second.url);
    let first_stop = state
        .html_preview_server
        .embed_stop_flag_for_test(&first_markdown, &html)
        .unwrap();
    let second_stop = state
        .html_preview_server
        .embed_stop_flag_for_test(&second_markdown, &html)
        .unwrap();

    fs::rename(&first_markdown, &renamed_first_markdown).unwrap();
    let canonical_renamed = normalize_existing_path(&renamed_first_markdown).unwrap();
    relocate_authorized_path_prefix_inner(
        &state,
        &canonical_first_markdown,
        &canonical_renamed,
    )
    .unwrap();

    assert!(first_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(!second_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(http_get(&second.url).contains("<h1>Shared embed</h1>"));
    assert_eq!(
        state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        1
    );
    release_markdown_html_embed_inner(&state, second.owner_id, "main").unwrap();
}
#[test]
fn rejects_unsafe_markdown_html_embed_sources_before_allocating_a_lease() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("notes.md");
    fs::write(&markdown, "# Notes").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    for source in [
        "",
        "https://example.com/embed.html",
        "//example.com/embed.html",
        "/tmp/embed.html",
        "C:\\embed.html",
        "../embed.html",
        "%2e%2e/embed.html",
        "embed%2findex.html",
        "embed\\index.html",
        "embed.txt",
        "embed.html?mode=preview",
        "embed.html#section",
    ] {
        assert!(
            prepare_markdown_html_embed_inner(&state, &markdown, source).is_err(),
            "unsafe source was accepted: {source}"
        );
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }
}
#[test]
fn rejects_missing_unauthorized_and_symlink_escape_html_embeds() {
    let dir = tempdir().unwrap();
    let markdown = dir.path().join("notes.md");
    let existing = dir.path().join("existing.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&existing, "existing").unwrap();

    let unauthorized_state = AppState::default();
    assert!(
        prepare_markdown_html_embed_inner(&unauthorized_state, &markdown, "existing.html")
            .is_err()
    );

    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    assert!(prepare_markdown_html_embed_inner(&state, &markdown, "missing.html").is_err());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let outside = tempdir().unwrap();
        let target = outside.path().join("outside.html");
        fs::write(&target, "outside").unwrap();
        symlink(&target, dir.path().join("linked.html")).unwrap();
        let error =
            prepare_markdown_html_embed_inner(&state, &markdown, "linked.html").unwrap_err();
        assert!(error.contains("escaped the Markdown directory"));
    }

    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
