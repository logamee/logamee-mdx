use super::test_prelude::*;
use super::*;

#[test]
fn workspace_document_identity_rebinds_after_each_confirmed_save() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let coordinator = DocumentSaveCoordinator::default();

    for (index, bytes) in [b"first".as_slice(), b"second".as_slice()]
        .into_iter()
        .enumerate()
    {
        let expected = capture_file_version(&path).unwrap().unwrap();
        let outcome = coordinator
            .save_expected(
                authorization,
                &path,
                bytes,
                expected,
                &format!("op-{index}"),
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert!(matches!(
            outcome,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
    }

    assert_eq!(fs::read(&path).unwrap(), b"second");
}
#[test]
fn workspace_identity_settlement_reserves_its_terminal_generation_before_writing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let expected = capture_file_version(&path).unwrap().unwrap();
    authorization
        .set_authorization_generation_for_test(u64::MAX - 1)
        .unwrap();

    let outcome = DocumentSaveCoordinator::default()
        .save_expected(
            authorization,
            &path,
            b"new",
            expected,
            "generation-limit",
            MAIN_SAVE_OWNER,
        )
        .unwrap();

    assert!(matches!(
        outcome,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    assert_eq!(authorization.authorization_generation().unwrap(), u64::MAX);
    assert_eq!(fs::read(path).unwrap(), b"new");
}
#[test]
fn exhausted_workspace_identity_generation_fails_before_the_writer() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let expected = capture_file_version(&path).unwrap().unwrap();
    authorization
        .set_authorization_generation_for_test(u64::MAX)
        .unwrap();
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));

    assert!(coordinator
        .save_expected(
            authorization,
            &path,
            b"new",
            expected,
            "generation-exhausted",
            MAIN_SAVE_OWNER,
        )
        .is_err());
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(path).unwrap(), b"old");
}
#[test]
fn confirmed_save_does_not_bind_authority_to_a_post_commit_replacement() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let generation_before = authorization.authorization_generation().unwrap();
    let expected = capture_file_version(&path).unwrap().unwrap();
    let coordinator = DocumentSaveCoordinator::with_ports(
        Arc::new(CommitThenReplaceWriter),
        Arc::new(SystemMonotonicClock),
    );

    let outcome = coordinator
        .save_expected(
            authorization,
            &path,
            b"committed content",
            expected,
            "op-replaced",
            MAIN_SAVE_OWNER,
        )
        .unwrap();

    assert!(matches!(
        outcome,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(&path).unwrap(), b"external replacement");
    assert!(ensure_authorized_write_file_inner(&state, &path).is_err());
    assert!(authorization.authorization_generation().unwrap() > generation_before);
}
#[test]
fn pending_save_as_can_create_expected_absent_and_publishes_exact_grant() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("new.md");
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    let outcome = DocumentSaveCoordinator::default()
        .save_as_expected(
            &authorization,
            &pending,
            &path,
            b"new",
            "op",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    assert!(authorization
        .with_exact_write_authority(&path, |_, _| Ok(()))
        .is_ok());
    assert!(!authorization
        .with_save_authorization_scope(&path, |scope| Ok(scope.matches_pending(&pending)))
        .unwrap());
}
fn race_save_as_conflict(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    pending: &PendingSaveAuthority,
    path: &Path,
) -> DocumentSaveDisposition {
    coordinator
        .save_as_expected(authorization, pending, path, b"new", "op", MAIN_SAVE_OWNER)
        .unwrap()
}
fn retry_race_commit(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    token: &OverwriteToken,
    path: &Path,
) -> Result<DocumentSaveDisposition, String> {
    coordinator.retry_with_token(
        authorization,
        token,
        path,
        b"new",
        "op",
        MAIN_SAVE_OWNER,
        |_| Ok(()),
    )
}
#[test]
fn save_as_absent_to_existing_race_returns_single_use_confirmation_without_writing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
    let conflict = race_save_as_conflict(&coordinator, &authorization, &pending, &path);
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(&path).unwrap(), b"old");
    let DocumentSaveDisposition::Conflict {
        overwrite_token: Some(token),
        ..
    } = conflict
    else {
        panic!("save-as race must return a confirmation token");
    };
    let committed = retry_race_commit(&coordinator, &authorization, &token, &path).unwrap();
    assert!(matches!(
        committed,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert!(retry_race_commit(&coordinator, &authorization, &token, &path).is_err());
}
