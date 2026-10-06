use super::test_prelude::*;
use super::*;

fn displace_workspace_root(canonical_root: &Path, displaced: &Path) -> (PathBuf, PathBuf) {
    fs::rename(canonical_root, displaced).unwrap();
    fs::create_dir(canonical_root).unwrap();
    fs::write(canonical_root.join("note.md"), "external secret").unwrap();
    fs::write(canonical_root.join("image.png"), b"external image").unwrap();
    (
        canonical_root.join("note.md"),
        canonical_root.join("image.png").canonicalize().unwrap(),
    )
}
fn assert_replacement_root_stays_unauthorized(
    state: &AppState,
    replacement_document: &Path,
    replacement_asset: &Path,
) {
    assert!(ensure_authorized_existing_file_inner(state, replacement_document).is_err());
    assert!(open_authorized_existing_file_inner(state, replacement_document).is_err());
    assert!(ensure_authorized_write_file_inner(state, replacement_document).is_err());
    assert!(state
        .file_authorization()
        .with_exact_write_authority(replacement_document, |_, _| Ok(()))
        .is_err());
    assert!(!is_authorized_image_path(state, replacement_asset).unwrap());
}
#[test]
fn committed_workspace_open_does_not_authorize_a_replacement_root() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let displaced = directory.path().join("displaced");
    let document = root.join("note.md");
    let asset = root.join("image.png");
    fs::create_dir(&root).unwrap();
    fs::write(&document, "authorized content").unwrap();
    fs::write(&asset, b"authorized image").unwrap();
    let canonical_root = root.canonicalize().unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, root.clone()).unwrap();
    let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let identifiers = recent
        .issue_workspace_open(
            "main",
            opened
                .workspace_authorization()
                .expect("workspace reads carry their authorization"),
        )
        .unwrap();
    drop(opened);

    assert!(matches!(
        recent
            .commit_open(
                &identifiers.open_receipt,
                "main",
                state.file_authorization()
            )
            .unwrap(),
        OpenCommitResult::Committed { .. }
    ));
    assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
    assert!(is_authorized_image_path(&state, &asset.canonicalize().unwrap()).unwrap());

    let (replacement_document, replacement_asset) =
        displace_workspace_root(&canonical_root, &displaced);
    assert_replacement_root_stays_unauthorized(&state, &replacement_document, &replacement_asset);
}
#[test]
fn workspace_commit_does_not_transfer_write_authority_to_a_replaced_file() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let document = root.join("note.md");
    let displaced = root.join("displaced.md");
    fs::create_dir(&root).unwrap();
    fs::write(&document, "authorized content").unwrap();
    let state = Arc::new(AppState::default());
    authorize_directory_root_inner(&state, root).unwrap();
    let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
    let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
    let recent = Arc::new(state_with(
        directory.path().join("app-data"),
        replacer.clone(),
    ));
    let identifiers = recent
        .issue_workspace_open(
            "main",
            opened
                .workspace_authorization()
                .expect("workspace reads carry their authorization"),
        )
        .unwrap();
    drop(opened);
    replacer.pause_next_replacement();
    let commit_recent = recent.clone();
    let commit_state = state.clone();
    let open_receipt = identifiers.open_receipt;
    let commit = thread::spawn(move || {
        commit_recent.commit_open(&open_receipt, "main", commit_state.file_authorization())
    });
    replacement_entered
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    fs::rename(&document, &displaced).unwrap();
    fs::write(&document, "replacement content").unwrap();
    release_replacement.send(()).unwrap();

    assert!(matches!(
        commit.join().unwrap().unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
    assert!(state
        .file_authorization()
        .with_exact_write_authority(&document, |_, _| Ok(()))
        .is_err());
    assert!(recent.list().unwrap().entries.is_empty());
}
#[test]
fn workspace_commit_reports_indeterminate_when_recent_store_rollback_fails() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let document = root.join("note.md");
    let displaced = root.join("displaced.md");
    fs::create_dir(&root).unwrap();
    fs::write(&document, "authorized content").unwrap();
    let state = Arc::new(AppState::default());
    authorize_directory_root_inner(&state, root).unwrap();
    let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
    let (replacer, replacement_entered, release_replacement) =
        PausingRollbackFailingReplacer::new();
    let recent = Arc::new(state_with(directory.path().join("app-data"), replacer));
    let identifiers = recent
        .issue_workspace_open(
            "main",
            opened
                .workspace_authorization()
                .expect("workspace reads carry their authorization"),
        )
        .unwrap();
    drop(opened);
    let commit_recent = recent.clone();
    let commit_state = state.clone();
    let open_receipt = identifiers.open_receipt;
    let commit = thread::spawn(move || {
        commit_recent.commit_open(&open_receipt, "main", commit_state.file_authorization())
    });
    replacement_entered
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    fs::rename(&document, &displaced).unwrap();
    fs::write(&document, "replacement content").unwrap();
    release_replacement.send(()).unwrap();

    let error = commit.join().unwrap().unwrap_err();
    assert!(error.contains("indeterminate"));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::Unknown
    ));
    assert_eq!(recent.list().unwrap().entries.len(), 1);
    assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
}
#[test]
fn replacement_failure_is_terminal_not_committed_and_publishes_no_grant() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with(directory.path().join("app-data"), Arc::new(FailingReplacer));
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &canonical_document).unwrap();

    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::NotCommitted { .. }
    ));
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
}
#[test]
fn pre_commit_target_revalidation_failure_is_not_committed_and_grants_nothing() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &document).unwrap();
    fs::remove_file(&document).unwrap();

    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::NotCommitted { .. }
    ));
    assert!(!recent.store.store_path().exists());
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
}
#[test]
fn pre_commit_terminal_outcome_reservation_failure_cannot_publish_store_or_grant() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &document).unwrap();
    recent.runtime.lock().unwrap().next_sequence = u64::MAX;

    let error = recent
        .commit_open(&identifiers.open_receipt, "main", &authorization)
        .unwrap_err();

    assert!(error.contains("insertion sequence is exhausted"));
    assert_eq!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::Unknown
    );
    assert!(!recent.store.store_path().exists());
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
}
