use super::prelude::*;
use super::super::*;
use super::group6_helpers::*;

#[test]
fn poisoned_site_map_revocation_stops_all_preview_workers() {
    let workspace = tempdir().unwrap();
    let (
        canonical_removed_root,
        removed_document,
        retained_document,
        canonical_removed_document,
        canonical_retained_document,
    ) = write_poisoned_revocation_files(workspace.path());
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let (canonical_workspace, index_generation, query) =
        build_poisoned_revocation_index(&state, workspace.path(), &opened);
    prepare_html_preview_inner(&state, &removed_document, "removed").unwrap();
    prepare_html_preview_inner(&state, &retained_document, "retained").unwrap();

    let worker_stops = document_worker_stops(
        &state,
        &canonical_removed_document,
        &canonical_retained_document,
    );
    poison_site_map(&state, "injected HTML site map poison");

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        revoke_authorized_path_prefix_inner(&state, &canonical_removed_root)
    });
    let error = result.expect_err("poisoned preview revocation must fail closed");

    assert_poisoned_revocation_stopped_everything(&state, &worker_stops);
    assert_eq!(
        error,
        "HTML preview server state was poisoned; all preview sites were stopped"
    );
    assert_poisoned_revocation_teardown(
        &state,
        &opened,
        &canonical_workspace,
        index_generation,
        &query,
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
fn poisoned_site_map_prepare_retires_drained_and_reserved_preview_leases() {
    let workspace = tempdir().unwrap();
    let old_document = workspace.path().join("old.html");
    let new_document = workspace.path().join("new.html");
    fs::write(&old_document, "saved old").unwrap();
    fs::write(&new_document, "saved new").unwrap();
    let canonical_old_document = normalize_existing_path(&old_document).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let old_worker_stop = prepare_poisoned_prepare_old_site(
        &state,
        &old_document,
        &canonical_old_document,
    );
    poison_site_map(&state, "injected HTML site map poison before prepare");

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &new_document, "uncommitted new")
    });
    let error = result.expect_err("prepare against poisoned preview state must fail closed");

    assert_eq!(
        error,
        "HTML preview server state was poisoned; all preview sites were stopped"
    );
    assert_poisoned_prepare_drained(&state, &old_worker_stop);
    let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
    assert!(
        preview_leases.is_empty(),
        "poisoned prepare left drained or reserved preview leases authorized: {preview_leases:?}"
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
#[cfg(unix)]
#[test]
fn non_utf8_html_path_is_rejected_before_loopback_resources_start() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    let workspace = tempdir().unwrap();
    let valid_document = workspace.path().join("preview.html");
    fs::write(&valid_document, "saved HTML").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let scope =
        crate::path_auth::preview_scope_for_file_inner(&state, &valid_document).unwrap();
    let (_, root, lease) = scope.into_parts();
    let document = root.join(OsString::from_vec(b"preview-\xff.html".to_vec()));
    assert_eq!(
        WorkspaceFileKind::classify(&document),
        Some(WorkspaceFileKind::Html)
    );

    let (result, events) = crate::html_preview_server::site_start_test_probe::trace(|| {
        crate::html_preview_server::HtmlPreviewSite::start_parts(
            document,
            root,
            lease.clone(),
            crate::html_preview_server::HtmlPreviewContent::LiveDraft(std::sync::Arc::new(std::sync::Mutex::new(
                "uncommitted content".to_string(),
            ))),
        )
    });
    let error = match result {
        Ok(_) => panic!("non-UTF-8 preview path must be rejected"),
        Err(error) => error,
    };
    crate::path_auth::retire_preview_lease_inner(&state, &lease)
        .map_err(crate::path_auth::PreviewRetirementError::into_message)
        .unwrap();

    assert_eq!(error, "HTML preview path is not valid UTF-8");
    assert!(
        events.is_empty(),
        "loopback resources started before path validation: {events:?}"
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
fn rejects_unauthorized_html_files() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    fs::write(&html, "<h1>Saved</h1>").unwrap();

    let error =
        prepare_html_preview_inner(&AppState::default(), &html, "<h1>Draft</h1>").unwrap_err();

    assert!(error.contains("outside the user-authorized"));
}
