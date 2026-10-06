use super::prelude::*;
use super::super::*;
use super::group5_helpers::*;

#[test]
fn authorization_unavailable_during_cleanup_stops_all_preview_sites() {
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("target.html");
    let unrelated = workspace.path().join("unrelated.html");
    fs::write(&target, "saved target").unwrap();
    fs::write(&unrelated, "saved unrelated").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    prepare_html_preview_inner(&state, &target, "old target content").unwrap();
    prepare_html_preview_inner(&state, &unrelated, "unrelated content").unwrap();
    let (target_stop, unrelated_stop) = cleanup_stop_flags(&state, &target, &unrelated);
    state
        .file_authorization()
        .fail_next_preview_retirement_as_unavailable(
            "injected authorization unavailable during preview cleanup",
        )
        .unwrap();

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &target, "new committed target content")
    });
    let error = result.expect_err("authorization-unavailable cleanup must not return a URL");
    assert_eq!(
        error,
        "injected authorization unavailable during preview cleanup"
    );
    let documents_after = state.html_preview_server.site_documents().unwrap();

    assert!(
        documents_after.is_empty(),
        "authorization-unavailable cleanup preserved preview sites: {documents_after:?}"
    );
    assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
    assert_eq!(
        events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
        ]
    );
}
#[test]
fn relocate_prefix_relocates_internal_grants_and_invalidates_old_preview_sites() {
    let container = tempdir().unwrap();
    let old_root = container.path().join("old");
    fs::create_dir(&old_root).unwrap();
    let old_document = old_root.join("index.html");
    let old_asset = old_root.join("asset.png");
    fs::write(&old_document, "<img src=\"asset.png\">").unwrap();
    fs::write(&old_asset, b"png").unwrap();
    let canonical_old_root = normalize_existing_path(&old_root).unwrap();
    let canonical_old_document = normalize_existing_path(&old_document).unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, old_document.clone()).unwrap();
    let old_url = prepare_html_preview_inner(&state, &old_document, "old").unwrap();

    let new_root = container.path().join("new");
    fs::rename(&old_root, &new_root).unwrap();
    let canonical_new_root = normalize_existing_path(&new_root).unwrap();
    let new_document = canonical_new_root.join("index.html");
    let new_asset = normalize_existing_path(canonical_new_root.join("asset.png")).unwrap();
    relocate_authorized_path_prefix_inner(&state, &canonical_old_root, &canonical_new_root)
        .unwrap();

    assert!(!state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .contains_key(&canonical_old_document));
    assert!(ensure_authorized_existing_file_inner(&state, &new_document).is_ok());
    assert!(is_authorized_image_path(&state, &new_asset).unwrap());

    let new_url = prepare_html_preview_inner(&state, &new_document, "new").unwrap();
    assert_ne!(new_url, old_url);
}
#[test]
fn poisoned_site_map_relocation_retires_unrelated_drained_preview_leases() {
    let workspace = tempdir().unwrap();
    let old_root = workspace.path().join("old");
    fs::create_dir(&old_root).unwrap();
    let target_document = old_root.join("target.html");
    let unrelated_document = workspace.path().join("unrelated.html");
    fs::write(&target_document, "target").unwrap();
    fs::write(&unrelated_document, "unrelated").unwrap();
    let canonical_old_root = normalize_existing_path(&old_root).unwrap();
    let canonical_target_document = normalize_existing_path(&target_document).unwrap();
    let canonical_unrelated_document = normalize_existing_path(&unrelated_document).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    prepare_html_preview_inner(&state, &target_document, "live target").unwrap();
    prepare_html_preview_inner(&state, &unrelated_document, "live unrelated").unwrap();

    let (target_stop, unrelated_stop) = poisoned_site_handles(
        &state,
        &canonical_target_document,
        &canonical_unrelated_document,
    );

    let new_root = workspace.path().join("new");
    fs::rename(&old_root, &new_root).unwrap();
    let canonical_new_root = normalize_existing_path(&new_root).unwrap();
    poison_site_map(&state, "injected HTML site map poison before relocation");

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        relocate_authorized_path_prefix_inner(&state, &canonical_old_root, &canonical_new_root)
    });
    let error = result.expect_err("poisoned preview relocation must fail closed");

    assert_eq!(
        error,
        "HTML preview server state was poisoned; all preview sites were stopped"
    );
    assert_poisoned_sites_drained(&state, &target_stop, &unrelated_stop);
    let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
    assert!(
        preview_leases.is_empty(),
        "poisoned relocation left drained preview leases authorized: {preview_leases:?}; events={events:?}"
    );
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
#[test]
fn poisoned_preview_cleanup_after_rename_returns_indeterminate_outcome() {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("draft.html");
    let target = workspace.path().join("renamed.html");
    fs::write(&source, "draft").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    prepare_html_preview_inner(&state, &source, "live draft").unwrap();
    let canonical_source = normalize_existing_path(&source).unwrap();

    let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _sites = state.html_preview_server.sites.lock().unwrap();
        panic!("injected HTML site map poison before rename cleanup");
    }));
    assert!(poison.is_err());

    let outcome = rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &canonical_source,
        "renamed.html",
    )
    .unwrap();

    let MutationOutcome::Indeterminate {
        operation: MutationKind::Rename,
        paths,
        recovery_message,
    } = outcome
    else {
        panic!("post-commit preview failure must be indeterminate");
    };
    assert_eq!(
        paths,
        [
            canonical_source.to_string_lossy().to_string(),
            target.canonicalize().unwrap().to_string_lossy().to_string(),
        ]
    );
    assert_eq!(
        recovery_message,
        "HTML preview server state was poisoned; all preview sites were stopped"
    );
    assert!(!canonical_source.exists());
    assert!(target.is_file());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}
#[test]
fn poisoned_site_map_file_revocation_retires_unrelated_drained_preview_leases() {
    let workspace = tempdir().unwrap();
    let target_document = workspace.path().join("target.html");
    let unrelated_document = workspace.path().join("unrelated.html");
    fs::write(&target_document, "target").unwrap();
    fs::write(&unrelated_document, "unrelated").unwrap();
    let canonical_target_document = normalize_existing_path(&target_document).unwrap();
    let canonical_unrelated_document = normalize_existing_path(&unrelated_document).unwrap();
    let state = AppState::default();
    let (authorized_target, ()) = state
        .file_authorization()
        .open_standalone_file(&target_document, |_| Ok(()), |_| Ok(()))
        .unwrap();
    authorize_file_inner(&state, unrelated_document.clone()).unwrap();
    prepare_html_preview_inner(&state, &target_document, "live target").unwrap();
    prepare_html_preview_inner(&state, &unrelated_document, "live unrelated").unwrap();

    let (target_stop, unrelated_stop) = poisoned_site_handles(
        &state,
        &canonical_target_document,
        &canonical_unrelated_document,
    );

    poison_site_map(&state, "injected HTML site map poison before file revocation");

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        revoke_authorized_file_inner(&state, &authorized_target)
    });
    let error = result.expect_err("poisoned preview file revocation must fail closed");

    assert_eq!(
        error,
        "HTML preview server state was poisoned; all preview sites were stopped"
    );
    assert_poisoned_sites_drained(&state, &target_stop, &unrelated_stop);
    let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
    assert!(
        preview_leases.is_empty(),
        "poisoned file revocation left drained preview leases authorized: {preview_leases:?}; events={events:?}"
    );
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
