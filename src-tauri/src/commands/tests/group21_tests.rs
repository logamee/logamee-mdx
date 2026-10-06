use super::trash_fixtures::*;

#[test]
fn native_trash_mismatched_recovery_is_indeterminate_and_suspends_file_authority() {
    let workspace = tempdir().unwrap();
    let recovery = tempdir().unwrap();
    let source = workspace.path().join("note.md");
    let recovery_path = recovery.path().join("unverified.md");
    fs::write(&source, "before").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &source).unwrap();
    let mut port = scripted_trash(ScriptedTrashMode::PlacementMismatch, recovery_path.clone());

    let outcome = delete_workspace_entry_with_trash_port_inner(
        &state,
        &opened.workspace_token,
        &source,
        &mut port,
        capture_workspace_snapshot,
    )
    .unwrap();
    let wire = serde_json::to_string(&outcome).unwrap();

    assert!(matches!(outcome, MutationOutcome::Indeterminate { .. }));
    assert!(recovery_path.exists());
    assert!(!wire.contains(&recovery_path.to_string_lossy().to_string()));
    assert!(!wire.contains("rejected"));
    fs::write(&source, "replacement").unwrap();
    assert!(ensure_authorized_write_file_inner(&state, &source).is_err());
}
#[test]
fn native_trash_post_move_error_requires_a_verified_recovery_receipt() {
    for (mode, expected_committed) in [
        (ScriptedTrashMode::PostMoveWithReceipt, true),
        (ScriptedTrashMode::PostMoveWithoutReceipt, false),
    ] {
        let workspace = tempdir().unwrap();
        let recovery = tempdir().unwrap();
        let source = workspace.path().join("note.md");
        let recovery_path = recovery.path().join("recovery.md");
        fs::write(&source, "before").unwrap();
        let state = AppState::default();
        let opened = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, &source).unwrap();
        let mut port = scripted_trash(mode, recovery_path.clone());

        let outcome = delete_workspace_entry_with_trash_port_inner(
            &state,
            &opened.workspace_token,
            &source,
            &mut port,
            capture_workspace_snapshot,
        )
        .unwrap();
        let wire = serde_json::to_string(&outcome).unwrap();

        assert_eq!(
            matches!(&outcome, MutationOutcome::ConfirmedCommitted { .. }),
            expected_committed
        );
        if !expected_committed {
            assert!(matches!(&outcome, MutationOutcome::Indeterminate { .. }));
        }
        assert!(recovery_path.exists());
        assert!(!wire.contains("post-move failure"));
        assert!(!wire.contains(&recovery_path.to_string_lossy().to_string()));
    }
}
#[cfg(unix)]
struct SymlinkTrashFixture {
    workspace: tempfile::TempDir,
    outside: tempfile::TempDir,
    state: AppState,
    opened: WorkspaceSnapshot,
    outside_file: PathBuf,
    outside_link: PathBuf,
    inside_file: PathBuf,
    inside_link: PathBuf,
    nested_file: PathBuf,
    directory_link: PathBuf,
}

#[cfg(unix)]
fn symlink_trash_fixture() -> SymlinkTrashFixture {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_file = outside.path().join("outside.md");
    let outside_link = workspace.path().join("outside-link.md");
    let inside_file = workspace.path().join("inside.md");
    let inside_link = workspace.path().join("inside-link.md");
    let inside_directory = workspace.path().join("inside-directory");
    let directory_link = workspace.path().join("directory-link");
    let nested_file = inside_directory.join("nested.md");
    fs::write(&outside_file, "outside").unwrap();
    fs::write(&inside_file, "inside").unwrap();
    fs::create_dir(&inside_directory).unwrap();
    fs::write(&nested_file, "nested").unwrap();
    symlink(&outside_file, &outside_link).unwrap();
    symlink(&inside_file, &inside_link).unwrap();
    symlink(&inside_directory, &directory_link).unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    SymlinkTrashFixture {
        state,
        opened,
        workspace,
        outside,
        outside_file,
        outside_link,
        inside_file,
        inside_link,
        nested_file,
        directory_link,
    }
}

#[cfg(unix)]
fn assert_trash_rejects_forbidden_targets(
    fixture: &SymlinkTrashFixture,
    port: &mut ScriptedTrashPort,
) {
    for forbidden in [
        fixture.workspace.path(),
        fixture.outside_file.as_path(),
        fixture.outside_link.as_path(),
        fixture.inside_link.as_path(),
        fixture.directory_link.as_path(),
        fixture.directory_link.join("nested.md").as_path(),
    ] {
        let outcome = delete_workspace_entry_with_trash_port_inner(
            &fixture.state,
            &fixture.opened.workspace_token,
            forbidden,
            port,
            capture_workspace_snapshot,
        )
        .unwrap();
        assert!(matches!(
            outcome,
            MutationOutcome::ConfirmedNotCommitted { .. }
        ));
    }
}

#[cfg(unix)]
fn assert_symlink_trash_targets_untouched(fixture: &SymlinkTrashFixture) {
    assert!(fixture.outside_file.exists());
    assert!(fixture
        .outside_link
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&fixture.inside_file).unwrap(), "inside");
    assert!(fixture
        .inside_link
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&fixture.nested_file).unwrap(), "nested");
    assert!(fixture
        .directory_link
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn native_trash_rejects_root_outside_and_symlink_before_calling_port() {
    let fixture = symlink_trash_fixture();
    let mut port = scripted_trash(
        ScriptedTrashMode::Rejected,
        fixture.outside.path().join("unused"),
    );
    assert_trash_rejects_forbidden_targets(&fixture, &mut port);
    assert_eq!(port.calls, 0);
    assert_symlink_trash_targets_untouched(&fixture);
}
