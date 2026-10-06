use super::fixtures2::*;

fn assert_refresh_uses_one_snapshot_operation(
    state: &AppState,
    workspace_token: &str,
    root: &Path,
) {
    let refresh_calls = Cell::new(0);
    refresh_directory_with_snapshot_inner(state, workspace_token, root, |source| {
        assert!(matches!(source, WorkspaceSnapshotSource::Authorized(_)));
        refresh_calls.set(refresh_calls.get() + 1);
        crate::workspace_snapshot::capture_workspace_snapshot(source)
    })
    .unwrap();
    assert_eq!(refresh_calls.get(), 1);
}

fn assert_create_uses_one_snapshot_operation(
    state: &AppState,
    workspace_token: &str,
    root: &Path,
) -> PathBuf {
    let notes = root.join("notes");
    let create_calls = Cell::new(0);
    let created = create_workspace_directory_with_snapshot_inner(
        state,
        workspace_token,
        root,
        "notes",
        |source| {
            assert!(matches!(source, WorkspaceSnapshotSource::Authorized(_)));
            assert!(notes.is_dir());
            create_calls.set(create_calls.get() + 1);
            crate::workspace_snapshot::capture_workspace_snapshot(source)
        },
    )
    .unwrap();
    assert_eq!(create_calls.get(), 1);
    let receipt = match created {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };
    assert_eq!(Path::new(&receipt.committed.path), notes);
    assert_fresh_snapshot_lists_directory(receipt.workspace, "notes");
    notes
}

fn assert_rename_uses_one_snapshot_operation(
    state: &AppState,
    workspace_token: &str,
    root: &Path,
    notes: &Path,
) -> PathBuf {
    let archive = root.join("archive");
    let rename_calls = Cell::new(0);
    let renamed = rename_workspace_entry_with_snapshot_inner(
        state,
        workspace_token,
        notes,
        "archive",
        |source| {
            assert!(matches!(source, WorkspaceSnapshotSource::Authorized(_)));
            assert!(!notes.exists());
            assert!(archive.is_dir());
            rename_calls.set(rename_calls.get() + 1);
            crate::workspace_snapshot::capture_workspace_snapshot(source)
        },
    )
    .unwrap();
    assert_eq!(rename_calls.get(), 1);
    let receipt = match renamed {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };
    assert_fresh_snapshot_lists_directory(receipt.workspace, "archive");
    archive
}

fn assert_delete_uses_one_snapshot_operation(
    state: &AppState,
    workspace_token: &str,
    archive: &Path,
) {
    let delete_calls = Cell::new(0);
    let deleted =
        delete_workspace_entry_with_snapshot_inner(state, workspace_token, archive, |source| {
            assert!(matches!(source, WorkspaceSnapshotSource::Authorized(_)));
            assert!(!archive.exists());
            delete_calls.set(delete_calls.get() + 1);
            crate::workspace_snapshot::capture_workspace_snapshot(source)
        })
        .unwrap();
    assert_eq!(delete_calls.get(), 1);
    let receipt = match deleted {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };
    assert_fresh_snapshot_is_empty(receipt.workspace);
}

fn assert_fresh_snapshot_lists_directory(
    receipt: SnapshotReceipt<WorkspaceSnapshot>,
    expected: &str,
) {
    match receipt {
        SnapshotReceipt::Fresh { snapshot } => assert!(snapshot
            .directories
            .iter()
            .any(|entry| entry.relative_path == expected)),
        _ => panic!("expected fresh workspace receipt"),
    }
}

fn assert_fresh_snapshot_is_empty(receipt: SnapshotReceipt<WorkspaceSnapshot>) {
    match receipt {
        SnapshotReceipt::Fresh { snapshot } => assert!(snapshot.directories.is_empty()),
        _ => panic!("expected fresh workspace receipt"),
    }
}

#[test]
fn refresh_and_committed_mutations_each_use_one_snapshot_operation() {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let root = PathBuf::from(&opened.root);

    assert_refresh_uses_one_snapshot_operation(&state, &opened.workspace_token, &root);
    let notes = assert_create_uses_one_snapshot_operation(&state, &opened.workspace_token, &root);
    let archive =
        assert_rename_uses_one_snapshot_operation(&state, &opened.workspace_token, &root, &notes);
    assert_delete_uses_one_snapshot_operation(&state, &opened.workspace_token, &archive);
}
