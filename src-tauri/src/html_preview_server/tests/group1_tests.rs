use super::prelude::*;
use super::super::*;

#[test]
fn reused_embed_removes_revoked_active_generation_before_returning_new_owner() {
    let workspace = tempdir().unwrap();
    let markdown = workspace.path().join("notes.md");
    let html = workspace.path().join("embed.html");
    fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
    fs::write(&html, "<button>Click</button>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let first =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let key = crate::html_preview_server::HtmlEmbedSiteKey {
        anchor: normalize_existing_path(&markdown).unwrap(),
        document: normalize_existing_path(&html).unwrap(),
    };
    let (active_lease, stop) = {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let site = sites.embeds.get(&key).unwrap();
        (site.lease.clone(), site.stop.clone())
    };

    crate::html_preview_server::preview_commit_test_probe::before_next_commit(move |state, _reserved_lease| {
        crate::path_auth::retire_preview_lease_inner(state, &active_lease)
            .map_err(crate::path_auth::PreviewRetirementError::into_message)
            .unwrap();
    });

    let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
        .expect_err("a revoked active embed generation must not gain a new owner");

    assert_eq!(error, crate::html_preview_server::PREVIEW_AUTHORIZATION_CHANGED_ERROR);
    assert!(stop.load(Ordering::Acquire));
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
    release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();
}
#[test]
fn reused_embed_rolls_back_only_new_owner_when_reserved_lease_was_revoked() {
    let workspace = tempdir().unwrap();
    let markdown = workspace.path().join("notes.md");
    let html = workspace.path().join("embed.html");
    fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
    fs::write(&html, "<button>Click</button>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let first =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let key = crate::html_preview_server::HtmlEmbedSiteKey {
        anchor: normalize_existing_path(&markdown).unwrap(),
        document: normalize_existing_path(&html).unwrap(),
    };
    let active_lease = state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .embeds
        .get(&key)
        .unwrap()
        .lease
        .clone();

    crate::html_preview_server::preview_commit_test_probe::before_next_commit(|state, reserved_lease| {
        crate::path_auth::retire_preview_lease_inner(state, reserved_lease)
            .map_err(crate::path_auth::PreviewRetirementError::into_message)
            .unwrap();
    });

    let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
        .expect_err("a revoked reserved embed lease must roll back its owner");

    assert_eq!(error, crate::html_preview_server::PREVIEW_AUTHORIZATION_CHANGED_ERROR);
    {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let retained = sites.embeds.get(&key).unwrap();
        assert_eq!(retained.lease, active_lease);
        assert_eq!(
            retained.owners,
            HashMap::from([(first.owner_id, "main".into())])
        );
    }
    assert_eq!(
        state.file_authorization().preview_lease_snapshot().unwrap(),
        HashSet::from([active_lease])
    );
    release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();
}
#[test]
fn markdown_embed_serves_only_files_under_the_markdown_parent() {
    let workspace = tempdir().unwrap();
    let notes = workspace.path().join("notes");
    fs::create_dir(&notes).unwrap();
    let markdown = notes.join("guide.md");
    let html = notes.join("embed.html");
    fs::write(&markdown, "# Guide").unwrap();
    fs::write(&html, "<script src=\"/shared.js\"></script>").unwrap();
    fs::write(notes.join("shared.js"), "window.shared = true;").unwrap();
    fs::write(workspace.path().join("secret.js"), "window.secret = true;").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();
    let authority = url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();

    assert!(http_get(&format!("http://{authority}/shared.js")).contains("window.shared"));
    assert!(http_get(&format!("http://{authority}/secret.js")).starts_with("HTTP/1.1 404"));
}
#[test]
fn standalone_preview_and_markdown_embed_of_the_same_html_coexist() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Saved embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let standalone_url =
        prepare_html_preview_inner(&state, &html, "<h1>Unsaved draft</h1>").unwrap();
    let embed_url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();

    assert_ne!(standalone_url, embed_url);
    assert!(http_get(&standalone_url).contains("<h1>Unsaved draft</h1>"));
    assert!(http_get(&embed_url).contains("<h1>Saved embed</h1>"));
}
#[test]
fn markdown_embed_reads_the_current_html_from_disk_for_each_request() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>First version</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();
    assert!(http_get(&url).contains("<h1>First version</h1>"));

    fs::write(&html, "<h1>Second version</h1>").unwrap();

    assert!(http_get(&url).contains("<h1>Second version</h1>"));
}
#[test]
fn markdown_embed_site_lives_until_its_final_owner_releases_it() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Shared embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let first =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let second =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    assert_eq!(first.url, second.url);
    assert_ne!(first.owner_id, second.owner_id);
    let stop = state
        .html_preview_server
        .embed_stop_flag_for_test(&markdown, &html)
        .unwrap();

    release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();

    assert!(!stop.load(std::sync::atomic::Ordering::Acquire));
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

    assert!(stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn mismatched_window_cannot_release_an_embed_owner() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Shared embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    let handle =
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
    let key = crate::html_preview_server::HtmlEmbedSiteKey {
        anchor: normalize_existing_path(&markdown).unwrap(),
        document: normalize_existing_path(&html).unwrap(),
    };
    let (lease, stop) = {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let site = sites.embeds.get(&key).unwrap();
        (site.lease.clone(), site.stop.clone())
    };

    assert!(
        release_markdown_html_embed_inner(&state, handle.owner_id, "guessed-window",).is_ok()
    );

    {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let site = sites.embeds.get(&key).unwrap();
        assert_eq!(site.lease, lease);
        assert_eq!(
            site.owners,
            HashMap::from([(handle.owner_id, "main".into())])
        );
    }
    assert!(!stop.load(Ordering::Acquire));
    assert_eq!(
        state.file_authorization().preview_lease_snapshot().unwrap(),
        HashSet::from([lease])
    );

    release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
}
