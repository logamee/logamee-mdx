use super::prelude::*;
use super::super::*;
use super::group4_helpers::*;

#[test]
fn authorization_unavailable_during_failed_commit_rollback_stops_all_preview_sites() {
    let workspace = tempdir().unwrap();
    let (target, unrelated, canonical_target, canonical_unrelated) =
        write_rollback_documents(workspace.path());
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let target_url = prepare_html_preview_inner(&state, &target, "live target").unwrap();
    let unrelated_url =
        prepare_html_preview_inner(&state, &unrelated, "live unrelated").unwrap();
    assert!(http_get(&target_url).contains("live target"));
    assert!(http_get(&unrelated_url).contains("live unrelated"));
    let (target_stop, unrelated_stop) =
        document_stop_flags(&state, &canonical_target, &canonical_unrelated);

    authorize_file_inner(&state, target.clone()).unwrap();
    state
        .html_preview_server
        .fail_next_site_start("injected replacement start failure")
        .unwrap();
    state
        .file_authorization()
        .fail_next_preview_retirement_as_unavailable(
            "injected authorization unavailable during failed-commit rollback",
        )
        .unwrap();

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &target, "uncommitted replacement")
    });
    let error = result.expect_err("authorization-unavailable rollback must not return a URL");
    assert_eq!(
        error,
        "injected authorization unavailable during failed-commit rollback"
    );
    let documents_after = state.html_preview_server.site_documents().unwrap();

    assert!(
        documents_after.is_empty(),
        "authorization-unavailable rollback preserved unverified preview sites: {documents_after:?}"
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
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
        ]
    );
}
#[test]
fn capacity_rejection_preserves_every_active_preview_site() {
    let workspace = tempdir().unwrap();
    let documents = write_capacity_documents(workspace.path());
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let active_urls = prepare_capacity_site_urls(&state, &documents);

    let authorization_before = state.file_authorization().preview_lease_snapshot().unwrap();
    let sites_before = state.html_preview_server.site_lease_snapshot().unwrap();
    assert_eq!(authorization_before, sites_before);
    assert_eq!(sites_before.len(), MAX_PREVIEW_SITES);
    let worker_stops_before = capacity_worker_stops(&state);

    let new_document = normalize_existing_path(&documents[MAX_PREVIEW_SITES]).unwrap();
    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(
            &state,
            &new_document,
            &format!("live site {MAX_PREVIEW_SITES}"),
        )
    });
    let error = result.expect_err("capacity must reject a new preview site");
    let sites_after = state.html_preview_server.site_lease_snapshot().unwrap();
    let authorization_after = state.file_authorization().preview_lease_snapshot().unwrap();

    assert_capacity_snapshots_unchanged(
        &error,
        sites_before,
        authorization_before,
        sites_after,
        authorization_after,
    );
    assert!(!state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&new_document));
    assert!(worker_stops_before
        .iter()
        .all(|(_, stop)| !stop.load(std::sync::atomic::Ordering::Acquire)));
    for (index, url) in active_urls.iter().enumerate() {
        assert!(http_get(url).contains(&format!("live site {index}")));
    }
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
fn post_commit_retirement_failure_removes_committed_generation_and_preserves_unrelated_site() {
    let workspace = tempdir().unwrap();
    let (target, unrelated, canonical_target, canonical_unrelated) =
        write_retirement_documents(workspace.path());
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let target_url = prepare_html_preview_inner(&state, &target, "old target content").unwrap();
    let unrelated_url =
        prepare_html_preview_inner(&state, &unrelated, "stable unrelated content").unwrap();
    let (
        old_target_lease,
        target_stop,
        unrelated_lease,
        unrelated_stop,
        unrelated_server,
        unrelated_content,
    ) = retirement_site_handles(&state, &canonical_target, &canonical_unrelated);
    assert_retirement_leases_before(&state, &old_target_lease, &unrelated_lease);
    state
        .file_authorization()
        .fail_next_preview_retirement("injected post-commit retirement failure")
        .unwrap();

    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &target, "new committed target content")
    });
    let error = result.expect_err("injected post-commit retirement must fail");
    assert_eq!(error, "injected post-commit retirement failure");
    assert_retirement_failure_aftermath(
        &state,
        &canonical_target,
        &canonical_unrelated,
        &target_url,
        &target_stop,
    );
    assert_retained_unrelated_site(
        &state,
        &canonical_unrelated,
        &unrelated_url,
        (
            &unrelated_lease,
            &unrelated_stop,
            &unrelated_server,
            &unrelated_content,
        ),
    );
    assert!(!unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(http_get(&unrelated_url).contains("stable unrelated content"));
    assert_retirement_leases_after(&state, unrelated_lease);
    assert_replacement_retirement_events(events);
}
