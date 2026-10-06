//! Helpers for group4 html-preview tests.
use super::prelude::*;
use super::super::*;

pub(super) fn write_rollback_documents(workspace: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let target_root = workspace.join("target");
    fs::create_dir(&target_root).unwrap();
    let target = target_root.join("index.html");
    let unrelated = workspace.join("unrelated.html");
    fs::write(&target, "saved target").unwrap();
    fs::write(&unrelated, "saved unrelated").unwrap();
    (
        target.clone(),
        unrelated.clone(),
        normalize_existing_path(&target).unwrap(),
        normalize_existing_path(&unrelated).unwrap(),
    )
}
pub(super) fn document_stop_flags(
    state: &AppState,
    canonical_target: &Path,
    canonical_unrelated: &Path,
) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    (
        sites.get(canonical_target).unwrap().stop.clone(),
        sites.get(canonical_unrelated).unwrap().stop.clone(),
    )
}
pub(super) fn write_capacity_documents(workspace: &Path) -> Vec<PathBuf> {
    (0..=MAX_PREVIEW_SITES)
        .map(|index| {
            let document = workspace.join(format!("site-{index}.html"));
            fs::write(&document, format!("saved site {index}")).unwrap();
            document
        })
        .collect()
}
pub(super) fn prepare_capacity_site_urls(state: &AppState, documents: &[PathBuf]) -> Vec<String> {
    documents
        .iter()
        .take(MAX_PREVIEW_SITES)
        .enumerate()
        .map(|(index, document)| {
            prepare_html_preview_inner(state, document, &format!("live site {index}")).unwrap()
        })
        .collect()
}
pub(super) fn capacity_worker_stops(state: &AppState) -> Vec<(PreviewLeaseId, Arc<AtomicBool>)> {
    let sites = state.html_preview_server.sites.lock().unwrap();
    sites
        .values()
        .map(|site| (site.lease.clone(), site.stop.clone()))
        .collect()
}
pub(super) fn assert_capacity_snapshots_unchanged(
    error: &str,
    sites_before: HashSet<PreviewLeaseId>,
    authorization_before: HashSet<PreviewLeaseId>,
    sites_after: HashSet<PreviewLeaseId>,
    authorization_after: HashSet<PreviewLeaseId>,
) {
    assert!(error.contains("Too many active HTML preview sites"));
    assert_eq!(sites_after, sites_before);
    assert_eq!(authorization_after, authorization_before);
}
pub(super) fn write_retirement_documents(workspace: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let target = workspace.join("target.html");
    let unrelated = workspace.join("unrelated.html");
    fs::write(&target, "saved target").unwrap();
    fs::write(&unrelated, "saved unrelated").unwrap();
    (
        target.clone(),
        unrelated.clone(),
        normalize_existing_path(&target).unwrap(),
        normalize_existing_path(&unrelated).unwrap(),
    )
}
pub(super) fn retirement_site_handles(
    state: &AppState,
    canonical_target: &Path,
    canonical_unrelated: &Path,
) -> (
    PreviewLeaseId,
    Arc<AtomicBool>,
    PreviewLeaseId,
    Arc<AtomicBool>,
    Arc<Server>,
    HtmlPreviewContent,
) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    let target_site = sites.get(canonical_target).unwrap();
    let unrelated_site = sites.get(canonical_unrelated).unwrap();
    (
        target_site.lease.clone(),
        target_site.stop.clone(),
        unrelated_site.lease.clone(),
        unrelated_site.stop.clone(),
        unrelated_site.server.clone(),
        unrelated_site.content.clone(),
    )
}
pub(super) fn assert_retirement_leases_before(
    state: &AppState,
    old_target_lease: &PreviewLeaseId,
    unrelated_lease: &PreviewLeaseId,
) {
    let leases_before = state.file_authorization().preview_lease_snapshot().unwrap();
    assert_eq!(
        leases_before,
        HashSet::from([old_target_lease.clone(), unrelated_lease.clone()])
    );
    assert_eq!(
        state.html_preview_server.site_lease_snapshot().unwrap(),
        leases_before
    );
}
pub(super) fn assert_retirement_failure_aftermath(
    state: &AppState,
    canonical_target: &Path,
    canonical_unrelated: &Path,
    target_url: &str,
    target_stop: &Arc<AtomicBool>,
) {
    let documents_after = state.html_preview_server.site_documents().unwrap();
    let target_remained = documents_after.contains(canonical_target);
    let serves_new_content =
        target_remained && http_get(target_url).contains("new committed target content");

    assert!(
        !target_remained,
        "post-commit cleanup failure left the committed target live; serves_new_content={serves_new_content}"
    );
    assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
    assert_eq!(
        documents_after,
        HashSet::from([canonical_unrelated.to_path_buf()])
    );
}
pub(super) fn assert_retained_unrelated_site(
    state: &AppState,
    canonical_unrelated: &Path,
    unrelated_url: &str,
    unrelated_handles: (
        &PreviewLeaseId,
        &Arc<AtomicBool>,
        &Arc<Server>,
        &HtmlPreviewContent,
    ),
) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    let retained = sites.get(canonical_unrelated).unwrap();
    assert_eq!(retained.url, unrelated_url);
    assert_eq!(retained.lease, unrelated_handles.0.clone());
    assert!(std::sync::Arc::ptr_eq(&retained.stop, unrelated_handles.1));
    assert!(std::sync::Arc::ptr_eq(
        &retained.server,
        unrelated_handles.2
    ));
    assert!(retained.content.shares_state_with(unrelated_handles.3));
}
pub(super) fn assert_retirement_leases_after(state: &AppState, unrelated_lease: PreviewLeaseId) {
    let expected_leases = HashSet::from([unrelated_lease]);
    assert_eq!(
        state.html_preview_server.site_lease_snapshot().unwrap(),
        expected_leases
    );
    assert_eq!(
        state.file_authorization().preview_lease_snapshot().unwrap(),
        expected_leases
    );
}
pub(super) fn assert_replacement_retirement_events(
    events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
) {
    assert_eq!(
        events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
        ]
    );
}
