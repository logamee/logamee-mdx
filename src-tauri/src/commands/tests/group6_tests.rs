use super::fixtures2::*;
use super::group6_helpers::*;

#[test]
fn create_directory_commit_survives_post_commit_snapshot_failure() {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = workspace.path().join("notes");
    let snapshot_calls = std::cell::Cell::new(0);

    let outcome = create_workspace_directory_with_snapshot_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "notes",
        |_source: WorkspaceSnapshotSource<'_>| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            assert!(target.is_dir());
            assert!(refresh_directory_inner(&state, &opened.workspace_token, &target).is_err());
            Err("injected post-commit snapshot failure".to_string())
        },
    );

    let receipt = match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };
    assert_eq!(snapshot_calls.get(), 1);
    assert_eq!(
        Path::new(&receipt.committed.path),
        target.canonicalize().unwrap()
    );
    assert!(target.is_dir());
    match receipt.workspace {
        SnapshotReceipt::Stale {
            workspace_token,
            repair_reason,
        } => {
            assert_eq!(workspace_token, opened.workspace_token);
            assert_eq!(repair_reason, "injected post-commit snapshot failure");
        }
        _ => panic!("expected stale workspace receipt"),
    }

    let unrelated_workspace = tempdir().unwrap();
    let unrelated_opened = open_directory_inner(&state, unrelated_workspace.path()).unwrap();
    assert_eq!(unrelated_opened.workspace_token, "workspace-1");

    let refreshed =
        refresh_directory_inner(&state, &opened.workspace_token, workspace.path()).unwrap();
    assert!(refreshed
        .directories
        .iter()
        .any(|entry| entry.relative_path == "notes"));
}
#[test]
fn rename_commit_survives_post_commit_snapshot_failure() {
    let outer = tempdir().unwrap();
    let space = prepare_renamed_html_workspace(outer.path());
    let snapshot_calls = std::cell::Cell::new(0);

    let outcome = rename_workspace_entry_with_snapshot_inner(
        &space.state,
        &space.opened.workspace_token,
        &space.canonical_source,
        "archive",
        |_source: WorkspaceSnapshotSource<'_>| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            assert_rename_committed_state(&space);
            Err("injected post-commit snapshot failure".to_string())
        },
    )
    .expect("committed rename must not become command failure");

    assert_eq!(snapshot_calls.get(), 1);
    assert!(!space.canonical_source.exists());
    assert!(space.target.is_dir());
    assert_eq!(
        fs::read_to_string(&space.new_document).unwrap(),
        "<h1>before</h1>"
    );
    write_file_inner(&space.state, &space.new_document, "<h1>after</h1>").unwrap();
    assert_eq!(
        fs::read_to_string(&space.new_document).unwrap(),
        "<h1>after</h1>"
    );

    assert_rename_committed_outcome_json(&outcome, &space);

    let unrelated_workspace = tempdir().unwrap();
    let unrelated_opened = open_directory_inner(&space.state, unrelated_workspace.path()).unwrap();
    assert_eq!(unrelated_opened.workspace_token, "workspace-2");

    let refreshed =
        refresh_directory_inner(&space.state, &space.opened.workspace_token, &space.inner).unwrap();
    assert_eq!(refreshed.workspace_token, space.opened.workspace_token);
    assert!(refreshed
        .directories
        .iter()
        .any(|entry| entry.relative_path == "archive"));
    assert!(!refreshed
        .directories
        .iter()
        .any(|entry| entry.relative_path == "drafts"));
}
#[test]
fn poisoned_authorization_fails_before_filesystem_mutation() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let draft = open_html_draft_with_preview(workspace.path());

    assert_rename_authorization_poison_panics(&draft);

    let filesystem = ScriptedFileSystemPort::default();
    let snapshot_calls = Cell::new(0);
    let outcome = rename_workspace_entry_with_ports_inner(
        &draft.state,
        &draft.opened.workspace_token,
        &draft.canonical_source,
        "renamed.html",
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run for a pre-call failure".to_string())
        },
    )
    .expect("pre-call failures must be returned as mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-not-committed",
            "message": "Authorization state is poisoned",
        })
    );
    assert_eq!(filesystem.rename_calls.get(), 0);
    assert_eq!(snapshot_calls.get(), 0);
    assert_disk_and_authorization_unchanged(&draft);
}
#[test]
fn injected_pre_call_rename_failure_preserves_disk_and_authorization() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let draft = open_html_draft_with_preview(workspace.path());
    let filesystem = ScriptedFileSystemPort::default();
    let snapshot_calls = Cell::new(0);

    let outcome = rename_workspace_entry_with_preflight_and_ports_inner(
        &draft.state,
        &draft.opened.workspace_token,
        &draft.canonical_source,
        |entry, is_file| {
            assert_eq!(entry, draft.canonical_source);
            assert!(is_file);
            Err("injected pre-call rename failure".to_string())
        },
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run for a pre-call failure".to_string())
        },
    )
    .expect("pre-call failures must be returned as mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-not-committed",
            "message": "injected pre-call rename failure",
        })
    );
    assert_eq!(filesystem.rename_calls.get(), 0);
    assert_eq!(snapshot_calls.get(), 0);
    assert_disk_and_authorization_unchanged(&draft);
}
