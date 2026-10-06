//! Helpers for group6 html-preview tests.
use super::prelude::*;
use super::super::*;

pub(super) fn write_poisoned_revocation_files(
    workspace: &Path,
) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
    let removed_root = workspace.join("removed");
    fs::create_dir(&removed_root).unwrap();
    let removed_document = removed_root.join("index.html");
    let retained_document = workspace.join("retained.html");
    let search_document = workspace.join("search.md");
    fs::write(&removed_document, "removed").unwrap();
    fs::write(&retained_document, "retained").unwrap();
    fs::write(&search_document, "needle").unwrap();
    let canonical_removed_root = normalize_existing_path(&removed_root).unwrap();
    let canonical_removed_document = normalize_existing_path(&removed_document).unwrap();
    let canonical_retained_document = normalize_existing_path(&retained_document).unwrap();
    (
        canonical_removed_root,
        removed_document,
        retained_document,
        canonical_removed_document,
        canonical_retained_document,
    )
}
pub(super) fn build_poisoned_revocation_index(
    state: &AppState,
    workspace: &Path,
    opened: &crate::models::WorkspaceSnapshot,
) -> (
    PathBuf,
    u64,
    crate::workspace_index_runtime::WorkspaceIndexQueryLease,
) {
    rebuild_workspace_index_inner(
        state,
        &opened.workspace_token,
        &opened.root,
        "poisoned-preview-build",
    )
    .unwrap();
    let canonical_workspace = normalize_existing_path(workspace).unwrap();
    let index_generation = state
        .workspace_index()
        .current_generation(&opened.workspace_token, &canonical_workspace)
        .unwrap()
        .unwrap();
    let query = state
        .workspace_index()
        .begin_query(
            &opened.workspace_token,
            &canonical_workspace,
            "poisoned-preview-query",
        )
        .unwrap();
    (canonical_workspace, index_generation, query)
}
pub(super) fn document_worker_stops(
    state: &AppState,
    canonical_removed: &Path,
    canonical_retained: &Path,
) -> Vec<Arc<AtomicBool>> {
    let sites = state.html_preview_server.sites.lock().unwrap();
    vec![
        sites.get(canonical_removed).unwrap().stop.clone(),
        sites.get(canonical_retained).unwrap().stop.clone(),
    ]
}
pub(super) fn poison_site_map(state: &AppState, reason: &str) {
    let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _sites = state.html_preview_server.sites.lock().unwrap();
        panic!("{reason}");
    }));
    assert!(poison.is_err());
    assert!(state.html_preview_server.sites.is_poisoned());
}
pub(super) fn assert_poisoned_revocation_stopped_everything(
    state: &AppState,
    worker_stops: &[Arc<AtomicBool>],
) {
    let workers_stopped = worker_stops
        .iter()
        .all(|stop| stop.load(std::sync::atomic::Ordering::Acquire));
    let sites_empty = state
        .html_preview_server
        .sites
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty();
    assert!(
        workers_stopped && sites_empty,
        "poisoned site map did not fail closed: workers_stopped={workers_stopped}, sites_empty={sites_empty}"
    );
    assert!(!state.html_preview_server.sites.is_poisoned());
}
pub(super) fn assert_poisoned_revocation_teardown(
    state: &AppState,
    opened: &crate::models::WorkspaceSnapshot,
    canonical_workspace: &Path,
    index_generation: u64,
    query: &crate::workspace_index_runtime::WorkspaceIndexQueryLease,
) {
    assert!(query.lease.cancellation.is_cancelled());
    assert_eq!(
        state
            .workspace_index()
            .current_generation(&opened.workspace_token, canonical_workspace)
            .unwrap(),
        None
    );
    assert!(!state
        .workspace_index()
        .is_result_current(
            &opened.workspace_token,
            canonical_workspace,
            index_generation,
        )
        .unwrap());
    let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
    assert!(
        preview_leases.is_empty(),
        "poisoned recovery left preview leases authorized: {preview_leases:?}"
    );
}
pub(super) fn prepare_poisoned_prepare_old_site(
    state: &AppState,
    old_document: &Path,
    canonical_old_document: &Path,
) -> Arc<AtomicBool> {
    let old_url = prepare_html_preview_inner(state, old_document, "live old").unwrap();
    assert!(http_get(&old_url).contains("live old"));
    let old_worker_stop = state
        .html_preview_server
        .sites
        .lock()
        .unwrap()
        .get(canonical_old_document)
        .unwrap()
        .stop
        .clone();
    assert_eq!(
        state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        1
    );
    old_worker_stop
}
pub(super) fn assert_poisoned_prepare_drained(state: &AppState, old_worker_stop: &Arc<AtomicBool>) {
    assert!(old_worker_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(!state.html_preview_server.sites.is_poisoned());
    assert!(state.html_preview_server.sites.lock().unwrap().is_empty());
}
