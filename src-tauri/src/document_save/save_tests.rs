use super::test_prelude::*;
use super::*;

#[test]
fn workspace_save_after_external_inode_replacement_returns_version_conflict() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let expected = capture_file_version(&path).unwrap().unwrap();
    let coordinator = DocumentSaveCoordinator::default();

    let displaced = dir.path().join("note.md.displaced");
    fs::rename(&path, &displaced).unwrap();
    fs::write(&path, b"external").unwrap();

    let outcome = coordinator
        .save_expected(
            authorization,
            &path,
            b"new",
            expected,
            "op-external-replace",
            MAIN_SAVE_OWNER,
        )
        .expect("save must surface a version conflict instead of a hard authority error");
    assert!(matches!(outcome, DocumentSaveDisposition::Conflict { .. }));
}
#[test]
fn workspace_save_after_external_replacement_commits_with_current_version() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let coordinator = DocumentSaveCoordinator::default();

    let displaced = dir.path().join("note.md.displaced");
    fs::rename(&path, &displaced).unwrap();
    fs::write(&path, b"external").unwrap();
    let applied = capture_file_version(&path).unwrap().unwrap();

    let outcome = coordinator
        .save_expected(
            authorization,
            &path,
            b"edited on top of external",
            applied,
            "op-external-applied",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(&path).unwrap(), b"edited on top of external");
}
#[test]
#[cfg(unix)]
fn workspace_save_fails_closed_when_replacement_is_a_symlink() {
    use std::os::unix::fs::symlink;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let expected = capture_file_version(&path).unwrap().unwrap();
    let outside = dir.path().join("outside.md");
    fs::write(&outside, b"outside").unwrap();
    let coordinator = DocumentSaveCoordinator::default();

    fs::remove_file(&path).unwrap();
    symlink(&outside, &path).unwrap();

    assert!(coordinator
        .save_expected(
            authorization,
            &path,
            b"new",
            expected,
            "op-symlink-replace",
            MAIN_SAVE_OWNER,
        )
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
}
#[test]
#[cfg(windows)]
fn workspace_save_fails_closed_when_replacement_is_a_symlink() {
    use std::os::windows::fs::symlink_file;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let expected = capture_file_version(&path).unwrap().unwrap();
    let outside = dir.path().join("outside.md");
    fs::write(&outside, b"outside").unwrap();
    let coordinator = DocumentSaveCoordinator::default();

    fs::remove_file(&path).unwrap();
    symlink_file(&outside, &path).unwrap();

    assert!(coordinator
        .save_expected(
            authorization,
            &path,
            b"new",
            expected,
            "op-symlink-replace",
            MAIN_SAVE_OWNER,
        )
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
}
#[test]
fn overwrite_token_retry_after_external_replacement_returns_conflict() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &path).unwrap();
    let authorization = state.file_authorization();
    let coordinator = DocumentSaveCoordinator::default();
    let token = coordinator
        .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
        .unwrap();

    let displaced = dir.path().join("note.md.displaced");
    fs::rename(&path, &displaced).unwrap();
    fs::write(&path, b"external").unwrap();

    let outcome = coordinator
        .retry_with_token(
            authorization,
            &token,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .expect("token retry must arbitrate the external replacement instead of erroring");
    assert!(matches!(outcome, DocumentSaveDisposition::Conflict { .. }));
    assert_eq!(fs::read(&path).unwrap(), b"external");
}
#[test]
fn expected_exact_save_commits_and_stale_exact_conflicts() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = authorized_file(&path);
    let expected = capture_file_version(&path).unwrap().unwrap();
    let coordinator = DocumentSaveCoordinator::default();
    let committed = coordinator
        .save_expected(
            &authorization,
            &path,
            b"new",
            expected.clone(),
            "op-1",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    assert!(matches!(
        committed,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
    let conflict = coordinator
        .save_expected(
            &authorization,
            &path,
            b"again",
            expected,
            "op-2",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
}
