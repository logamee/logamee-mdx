use super::fixtures2::*;

#[test]
fn delete_receipt_carries_the_selected_workspace_identity() {
    let outer = tempdir().unwrap();
    let inner = outer.path().join("inner");
    fs::create_dir(&inner).unwrap();
    let document = inner.join("draft.md");
    fs::write(&document, "# draft").unwrap();
    let state = AppState::default();
    let outer_snapshot = open_directory_inner(&state, outer.path()).unwrap();
    let inner_snapshot = open_directory_inner(&state, &inner).unwrap();

    assert_ne!(
        outer_snapshot.workspace_token,
        inner_snapshot.workspace_token
    );

    let canonical_document = document.canonicalize().unwrap();
    let deleted = delete_workspace_entry_legacy_inner(
        &state,
        &inner_snapshot.workspace_token,
        &canonical_document,
    )
    .unwrap();
    let receipt = match deleted {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };

    assert_eq!(
        receipt.committed.deleted_path,
        canonical_document.to_string_lossy()
    );
    match receipt.workspace {
        SnapshotReceipt::Fresh { snapshot } => {
            assert_eq!(snapshot.workspace_token, inner_snapshot.workspace_token);
            assert_eq!(snapshot.root, inner_snapshot.root);
        }
        _ => panic!("expected fresh selected-workspace receipt"),
    }
}
#[test]
fn create_file_commit_survives_post_commit_snapshot_failure() {
    use crate::models::MutationOutcome;

    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = workspace.path().join("draft.md");

    let (outcome, snapshot_calls) = create_file_with_failing_post_commit_snapshot(
        &state,
        &opened.workspace_token,
        workspace.path(),
        &target,
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
    assert_eq!(receipt.committed.content.as_deref(), Some(""));
    assert!(target.is_file());
    assert!(ensure_authorized_write_file_inner(&state, &target).is_ok());

    assert_stale_workspace_receipt(
        receipt.workspace,
        &opened,
        "injected post-commit snapshot failure",
    );

    let unrelated_workspace = tempdir().unwrap();
    let unrelated_opened = open_directory_inner(&state, unrelated_workspace.path()).unwrap();
    assert_eq!(unrelated_opened.workspace_token, "workspace-1");

    let refreshed =
        refresh_directory_inner(&state, &opened.workspace_token, workspace.path()).unwrap();
    assert!(refreshed
        .files
        .iter()
        .any(|entry| entry.relative_path == "draft.md"));
}
#[test]
fn create_file_already_exists_race_is_confirmed_not_committed_without_overwrite() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = PathBuf::from(&opened.root).join("draft.md");
    let snapshot_calls = Cell::new(0);
    let filesystem = RacingCreateFileSystemPort {
        create_new_calls: Cell::new(0),
        created_path: RefCell::new(None),
    };

    let outcome = create_workspace_file_with_ports_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "draft.md",
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run after a lost create race".to_string())
        },
    )
    .expect("AlreadyExists must be returned as a mutation outcome");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-not-committed",
            "message": "Workspace entry already exists",
        })
    );
    assert_eq!(filesystem.create_new_calls.get(), 1);
    assert_eq!(
        filesystem.created_path.borrow().as_deref(),
        Some(target.as_path())
    );
    assert_eq!(snapshot_calls.get(), 0);
    assert_eq!(fs::read(&target).unwrap(), b"racer-owned");
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&target)
            .unwrap(),
        None
    );
    assert!(ensure_authorized_write_file_inner(&state, &target).is_err());
}

fn assert_stale_workspace_receipt(
    workspace: SnapshotReceipt<WorkspaceSnapshot>,
    opened: &WorkspaceSnapshot,
    expected_reason: &str,
) {
    match workspace {
        SnapshotReceipt::Stale {
            workspace_token,
            repair_reason,
        } => {
            assert_eq!(workspace_token, opened.workspace_token);
            assert_eq!(repair_reason, expected_reason);
        }
        _ => panic!("expected stale workspace receipt"),
    }
}

fn create_file_with_failing_post_commit_snapshot(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &Path,
    target: &Path,
) -> (
    Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String>,
    Cell<usize>,
) {
    let snapshot_calls = Cell::new(0);
    let outcome: Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> =
        create_workspace_file_with_snapshot_inner(
            state,
            workspace_token,
            workspace_root,
            "draft.md",
            |_source: WorkspaceSnapshotSource<'_>| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                assert!(target.is_file());
                assert_eq!(fs::read_to_string(target).unwrap(), "");
                assert!(ensure_authorized_write_file_inner(state, target).is_ok());
                Err("injected post-commit snapshot failure".to_string())
            },
        );
    (outcome, snapshot_calls)
}

struct RacingCreateFileSystemPort {
    create_new_calls: Cell<usize>,
    created_path: RefCell<Option<PathBuf>>,
}

impl FileSystemPort for RacingCreateFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("create-file race test must not use truncating write")
    }

    fn create_new(&self, path: &Path) -> std::io::Result<()> {
        self.create_new_calls.set(self.create_new_calls.get() + 1);
        *self.created_path.borrow_mut() = Some(path.to_path_buf());
        fs::write(path, b"racer-owned")?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file race test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("create-file race test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file race test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file race test must not delete directories")
    }

    fn observe(
        &self,
        _path: &Path,
        _expected_bytes: Option<&[u8]>,
    ) -> std::io::Result<ObservedPath> {
        unreachable!("AlreadyExists is conclusive without observation")
    }
}
