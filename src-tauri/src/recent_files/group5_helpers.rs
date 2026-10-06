//! Helpers extracted from group5 tests to keep each file within size limits.
use super::test_prelude::*;
use super::*;

pub(super) fn assert_prior_store_and_grants_survive_fault(
    recent: &RecentFilesState,
    authorization: &FileAuthorizationSession,
    identifiers: &OpenReceiptIdentifiers,
    prior: &RecentFilesSnapshot,
    prior_bytes: &[u8],
    canonical_first: &Path,
    canonical_second: &Path,
    app_data: &Path,
    fault: PersistFault,
) {
    assert_prior_store_bytes_survive_fault(recent, authorization, identifiers, prior, prior_bytes);
    assert_prior_grants_survive_fault(
        authorization,
        canonical_first,
        canonical_second,
        app_data,
        fault,
    );
}

fn assert_prior_store_bytes_survive_fault(
    recent: &RecentFilesState,
    authorization: &FileAuthorizationSession,
    identifiers: &OpenReceiptIdentifiers,
    prior: &RecentFilesSnapshot,
    prior_bytes: &[u8],
) {
    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "main", authorization)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::NotCommitted { .. }
    ));
    assert_eq!(fs::read(recent.store.store_path()).unwrap(), prior_bytes);
    assert_eq!(&recent.list().unwrap(), prior);
    assert_eq!(load_strict_store(&recent.store).entries.len(), 1);
}

fn assert_prior_grants_survive_fault(
    authorization: &FileAuthorizationSession,
    canonical_first: &Path,
    canonical_second: &Path,
    app_data: &Path,
    fault: PersistFault,
) {
    assert_eq!(
        authorization
            .exact_write_grant_snapshot_for_test(canonical_first)
            .unwrap(),
        Some((crate::path_auth::GrantStatus::Active, 1)),
        "prior grant changed for {fault:?}"
    );
    assert!(authorization
        .exact_write_grant_snapshot_for_test(canonical_second)
        .unwrap()
        .is_none());
    assert!(fs::read_dir(app_data).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".tmp-")));
}
#[cfg(unix)]
pub(super) fn assert_private_store_permissions(app_data: &Path, store: &RecentStore) {
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(app_data).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.store_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(store.lock_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
