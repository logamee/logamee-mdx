use super::test_prelude::*;
use super::*;

fn child_hold_lock(root: PathBuf) {
    let store = RecentStore::new(root);
    store.ensure_storage().unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(store.lock_path())
        .unwrap();
    lock.lock().unwrap();
    fs::write(
        env::var_os("MMD_RECENT_FILES_CHILD_READY").unwrap(),
        b"ready",
    )
    .unwrap();
    let hold_millis = env::var("MMD_RECENT_FILES_CHILD_HOLD_MS")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    thread::sleep(Duration::from_millis(hold_millis));
    lock.unlock().unwrap();
}
fn child_commit(root: PathBuf) {
    let target = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_TARGET").unwrap());
    let recent = RecentFilesState::new(root);
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("child", target).unwrap();
    wait_for_optional_child_start_gate();
    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "child", &authorization)
            .unwrap(),
        OpenCommitResult::Committed { .. }
    ));
}
fn child_clear(root: PathBuf) {
    let recent = RecentFilesState::new(root);
    wait_for_optional_child_start_gate();
    assert!(recent.clear().unwrap().entries.is_empty());
}
fn child_remove(root: PathBuf) {
    let entry_id = env::var("MMD_RECENT_FILES_CHILD_ENTRY_ID").unwrap();
    let recent = RecentFilesState::new(root);
    wait_for_optional_child_start_gate();
    recent.remove(&entry_id).unwrap();
}
#[test]
fn recent_files_child_process_harness() {
    let Ok(action) = env::var("MMD_RECENT_FILES_CHILD_ACTION") else {
        return;
    };
    let root = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_ROOT").unwrap());

    match action.as_str() {
        "hold-lock" => child_hold_lock(root),
        "commit" => child_commit(root),
        "clear" => child_clear(root),
        "remove" => child_remove(root),
        other => panic!("unknown child action: {other}"),
    }
}
#[test]
fn committed_open_promotes_once_retains_status_and_publishes_only_exact_authority() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    let sibling = directory.path().join("sibling.md");
    fs::write(&document, "# document").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &canonical_document).unwrap();

    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
    let committed = recent
        .commit_open(&identifiers.open_receipt, "main", &authorization)
        .unwrap();

    let snapshot = match committed {
        OpenCommitResult::Committed { recent_files } => recent_files,
        OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
    };
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].display_name, "document.md");
    assert_eq!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::Committed {
            recent_files: snapshot.clone(),
        }
    );
    assert!(recent
        .commit_open(&identifiers.open_receipt, "main", &authorization)
        .is_err());
    assert_eq!(
        authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap(),
        Some((crate::path_auth::GrantStatus::Active, 1))
    );
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&sibling.canonicalize().unwrap())
        .unwrap()
        .is_none());
}
#[cfg(unix)]
#[test]
fn recent_target_ignores_the_original_alias_after_it_is_retargeted() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    let alias = directory.path().join("alias.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    symlink(&first, &alias).unwrap();
    let canonical_first = first.canonicalize().unwrap();
    let canonical_second = second.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let initial = commit_document(&recent, "main", &alias, &authorization);
    let entry_id = initial.entries[0].id.clone();

    fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    let ((prepared_path, prepared_content), identifiers) = recent
        .prepare_recent_open("main", &entry_id, |path| {
            Ok((path.to_path_buf(), fs::read_to_string(path).unwrap()))
        })
        .unwrap();

    assert_eq!(prepared_path, canonical_first);
    assert_eq!(prepared_content, "# first");
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_second)
        .unwrap()
        .is_none());
    let committed = recent
        .commit_open(&identifiers.open_receipt, "main", &authorization)
        .unwrap();
    let reopened = match committed {
        OpenCommitResult::Committed { recent_files } => recent_files,
        OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
    };
    assert_eq!(reopened.entries.len(), 1);
    assert_eq!(reopened.entries[0].id, entry_id);
    assert_eq!(
        authorization
            .exact_write_grant_snapshot_for_test(&canonical_first)
            .unwrap(),
        Some((crate::path_auth::GrantStatus::Active, 2))
    );
}
#[cfg(unix)]
#[test]
fn recent_target_rejects_a_stored_canonical_path_retargeted_to_a_symlink() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let recorded = directory.path().join("recorded.md");
    let retargeted = directory.path().join("retargeted.md");
    fs::write(&recorded, "# recorded").unwrap();
    fs::write(&retargeted, "# retargeted").unwrap();
    let canonical_retargeted = retargeted.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let initial = commit_document(&recent, "main", &recorded, &authorization);
    let entry_id = initial.entries[0].id.clone();
    fs::remove_file(&recorded).unwrap();
    symlink(&retargeted, &recorded).unwrap();
    let response_called = AtomicBool::new(false);

    let result = recent.prepare_recent_open("main", &entry_id, |_| {
        response_called.store(true, Ordering::SeqCst);
        Ok(())
    });

    assert!(result.is_err());
    assert!(!response_called.load(Ordering::SeqCst));
    assert!(recent.list().unwrap().entries.is_empty());
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_retargeted)
        .unwrap()
        .is_none());
}
#[test]
fn recent_target_accepts_a_supported_replacement_at_the_same_canonical_path() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# original").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let initial = commit_document(&recent, "main", &document, &authorization);
    let entry_id = initial.entries[0].id.clone();
    fs::remove_file(&document).unwrap();
    fs::write(&document, "# replacement").unwrap();

    let ((prepared_path, prepared_content), identifiers) = recent
        .prepare_recent_open("main", &entry_id, |path| {
            Ok((path.to_path_buf(), fs::read_to_string(path).unwrap()))
        })
        .unwrap();

    assert_eq!(prepared_path, canonical_document);
    assert_eq!(prepared_content, "# replacement");
    let committed = recent
        .commit_open(&identifiers.open_receipt, "main", &authorization)
        .unwrap();
    let reopened = match committed {
        OpenCommitResult::Committed { recent_files } => recent_files,
        OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
    };
    assert_eq!(reopened.entries.len(), 1);
    assert_eq!(reopened.entries[0].id, entry_id);
    assert_eq!(
        authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap(),
        Some((crate::path_auth::GrantStatus::Active, 2))
    );
}
