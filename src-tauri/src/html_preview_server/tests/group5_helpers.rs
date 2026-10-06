//! Helpers for group5 html-preview tests.
use super::prelude::*;
use super::super::*;
pub(super) fn cleanup_stop_flags(
    state: &AppState,
    target: &Path,
    unrelated: &Path,
) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    let sites = state.html_preview_server.sites.lock().unwrap();
    (
        sites
            .get(&normalize_existing_path(target).unwrap())
            .unwrap()
            .stop
            .clone(),
        sites
            .get(&normalize_existing_path(unrelated).unwrap())
            .unwrap()
            .stop
            .clone(),
    )
}
pub(super) fn poisoned_site_handles(
    state: &AppState,
    canonical_target: &Path,
    canonical_unrelated: &Path,
) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    let (leases, stops) = {
        let sites = state.html_preview_server.sites.lock().unwrap();
        let target = sites.get(canonical_target).unwrap();
        let unrelated = sites.get(canonical_unrelated).unwrap();
        (
            HashSet::from([target.lease.clone(), unrelated.lease.clone()]),
            (target.stop.clone(), unrelated.stop.clone()),
        )
    };
    assert_eq!(
        state.file_authorization().preview_lease_snapshot().unwrap(),
        leases
    );
    stops
}
pub(super) fn poison_site_map(state: &AppState, reason: &str) {
    let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _sites = state.html_preview_server.sites.lock().unwrap();
        panic!("{reason}");
    }));
    assert!(poison.is_err());
    assert!(state.html_preview_server.sites.is_poisoned());
}
pub(super) fn assert_poisoned_sites_drained(
    state: &AppState,
    target_stop: &Arc<AtomicBool>,
    unrelated_stop: &Arc<AtomicBool>,
) {
    assert!(!state.html_preview_server.sites.is_poisoned());
    assert!(state.html_preview_server.sites.lock().unwrap().is_empty());
    assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
}
