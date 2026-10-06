use super::test_prelude::*;
use super::*;

#[test]
fn unlock_failure_after_commit_preserves_committed_result_status_and_exact_grant() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let mut recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    recent.store.fail_unlock = true;
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &canonical_document).unwrap();

    let committed = catch_unwind(AssertUnwindSafe(|| {
        recent.commit_open(&identifiers.open_receipt, "main", &authorization)
    }))
    .expect("post-commit unlock failure must not panic")
    .unwrap();

    let snapshot = match committed {
        OpenCommitResult::Committed { recent_files } => recent_files,
        OpenCommitResult::NotCommitted { message } => {
            panic!("post-commit unlock failure reported not_committed: {message}")
        }
    };
    let persisted: RecentFileStoreV1 =
        serde_json::from_slice(&fs::read(recent.store.store_path()).unwrap()).unwrap();
    assert_eq!(persisted.entries.len(), 1);
    assert_eq!(
        persisted.entries[0].canonical_target,
        canonical_document.to_string_lossy()
    );
    assert_eq!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::Committed {
            recent_files: snapshot,
        }
    );
    assert_eq!(
        authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap(),
        Some((crate::path_auth::GrantStatus::Active, 1))
    );
}
#[test]
fn unlock_failure_does_not_replace_the_primary_operation_error() {
    let directory = tempdir().unwrap();
    let mut store = store_with(
        directory.path().to_path_buf(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(1),
        Duration::from_millis(100),
    );
    store.fail_unlock = true;

    let result: Result<(), String> =
        store.with_exclusive_lock(|| Err("primary operation failure".to_string()));

    assert_eq!(result.unwrap_err(), "primary operation failure");
}
#[test]
fn same_process_commit_then_clear_is_serialized_without_lost_state() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
    let recent = Arc::new(state_with(
        directory.path().join("app-data"),
        replacer.clone(),
    ));
    let authorization = Arc::new(FileAuthorizationSession::default());
    let identifiers = recent.issue_open("main", &document).unwrap();
    replacer.pause_next_replacement();

    let commit_recent = Arc::clone(&recent);
    let commit_authorization = Arc::clone(&authorization);
    let open_receipt = identifiers.open_receipt;
    let commit_thread = thread::spawn(move || {
        commit_recent.commit_open(&open_receipt, "main", &commit_authorization)
    });
    replacement_entered
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    let (clear_started_tx, clear_started_rx) = mpsc::channel();
    let (clear_done_tx, clear_done_rx) = mpsc::channel();
    let clear_recent = Arc::clone(&recent);
    let clear_thread = thread::spawn(move || {
        clear_started_tx.send(()).unwrap();
        let result = clear_recent.clear();
        clear_done_tx.send(()).unwrap();
        result
    });
    clear_started_rx.recv().unwrap();
    assert!(clear_done_rx
        .recv_timeout(Duration::from_millis(40))
        .is_err());

    release_replacement.send(()).unwrap();
    assert!(matches!(
        commit_thread.join().unwrap().unwrap(),
        OpenCommitResult::Committed { .. }
    ));
    assert!(clear_thread.join().unwrap().unwrap().entries.is_empty());
    assert!(recent.list().unwrap().entries.is_empty());
}
#[test]
fn same_process_commit_then_remove_reloads_before_removing_without_lost_promotion() {
    let directory = tempdir().unwrap();
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
    let recent = Arc::new(state_with(
        directory.path().join("app-data"),
        replacer.clone(),
    ));
    let authorization = Arc::new(FileAuthorizationSession::default());
    let first_snapshot = commit_document(&recent, "main", &first, &authorization);
    let first_id = first_snapshot.entries[0].id.clone();
    let identifiers = recent.issue_open("main", &second).unwrap();
    replacer.pause_next_replacement();

    let commit_recent = Arc::clone(&recent);
    let commit_authorization = Arc::clone(&authorization);
    let open_receipt = identifiers.open_receipt;
    let commit_thread = thread::spawn(move || {
        commit_recent.commit_open(&open_receipt, "main", &commit_authorization)
    });
    replacement_entered
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    let (remove_started_tx, remove_started_rx) = mpsc::channel();
    let (remove_done_tx, remove_done_rx) = mpsc::channel();
    let remove_recent = Arc::clone(&recent);
    let remove_thread = thread::spawn(move || {
        remove_started_tx.send(()).unwrap();
        let result = remove_recent.remove(&first_id);
        remove_done_tx.send(()).unwrap();
        result
    });
    remove_started_rx.recv().unwrap();
    assert!(remove_done_rx
        .recv_timeout(Duration::from_millis(40))
        .is_err());

    release_replacement.send(()).unwrap();
    assert!(matches!(
        commit_thread.join().unwrap().unwrap(),
        OpenCommitResult::Committed { .. }
    ));
    let removed = remove_thread.join().unwrap().unwrap();
    assert_eq!(removed.entries.len(), 1);
    assert_eq!(removed.entries[0].display_name, "second.md");
    assert_eq!(recent.list().unwrap(), removed);
}
#[test]
fn same_process_clear_then_remove_is_serialized_to_one_empty_store() {
    let directory = tempdir().unwrap();
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
    let recent = Arc::new(state_with(
        directory.path().join("app-data"),
        replacer.clone(),
    ));
    let authorization = FileAuthorizationSession::default();
    commit_document(&recent, "main", &first, &authorization);
    let snapshot = commit_document(&recent, "main", &second, &authorization);
    let first_id = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_name == "first.md")
        .unwrap()
        .id
        .clone();
    replacer.pause_next_replacement();

    let clear_recent = Arc::clone(&recent);
    let clear_thread = thread::spawn(move || clear_recent.clear());
    replacement_entered
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    let (remove_started_tx, remove_started_rx) = mpsc::channel();
    let (remove_done_tx, remove_done_rx) = mpsc::channel();
    let remove_recent = Arc::clone(&recent);
    let remove_thread = thread::spawn(move || {
        remove_started_tx.send(()).unwrap();
        let result = remove_recent.remove(&first_id);
        remove_done_tx.send(()).unwrap();
        result
    });
    remove_started_rx.recv().unwrap();
    assert!(remove_done_rx
        .recv_timeout(Duration::from_millis(40))
        .is_err());

    release_replacement.send(()).unwrap();
    assert!(clear_thread.join().unwrap().unwrap().entries.is_empty());
    assert!(remove_thread.join().unwrap().unwrap().entries.is_empty());
    assert!(recent.list().unwrap().entries.is_empty());
    let persisted: RecentFileStoreV1 =
        serde_json::from_slice(&fs::read(recent.store.store_path()).unwrap()).unwrap();
    assert_eq!(persisted, RecentFileStoreV1::empty());
}
#[test]
fn committed_open_obeys_mru_fs2_authorization_lock_order() {
    use crate::path_auth::lock_order_test_probe::{trace, LockEvent};

    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &document).unwrap();

    let mut published_asset_target = None;
    let (result, events) = trace(|| {
        recent.commit_open_with_post_commit(
            &identifiers.open_receipt,
            "main",
            &authorization,
            |target| {
                crate::path_auth::lock_order_test_probe::assert_no_locks_held();
                published_asset_target = Some(target.to_path_buf());
            },
        )
    });

    assert!(matches!(
        result.unwrap(),
        OpenCommitResult::Committed { .. }
    ));
    assert_eq!(
        published_asset_target,
        Some(document.canonicalize().unwrap())
    );
    assert_eq!(
        events,
        vec![
            LockEvent::RecentRuntimeAcquired,
            LockEvent::RecentFs2Acquired,
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::RecentFs2Released,
            LockEvent::RecentRuntimeReleased,
        ]
    );
}
