use super::fixtures2::*;

#[test]
fn create_directory_error_with_new_directory_is_indeterminate_and_ungranted() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = PathBuf::from(&opened.root).join("notes");
    let authorization_before = state.file_authorization().state_fingerprint_for_test();
    let snapshot_calls = Cell::new(0);
    let filesystem = DirectoryThenErrorFileSystemPort {
        create_dir_calls: Cell::new(0),
        observe_calls: Cell::new(0),
        attempted_path: RefCell::new(None),
    };

    let outcome = create_workspace_directory_with_ports_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "notes",
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run after an indeterminate create".to_string())
        },
    )
    .expect("post-attempt directory errors must be mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "create",
            "paths": [target.to_string_lossy()],
            "recovery_message": "Directory creation may have committed before an error: Failed to create directory: injected post-attempt directory create failure. Refresh and inspect the workspace before retrying.",
        })
    );
    assert_indeterminate_directory_effects(
        &filesystem,
        &target,
        &snapshot_calls,
        &state,
        &authorization_before,
    );
}
#[test]
fn create_directory_already_exists_race_is_confirmed_not_committed() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = PathBuf::from(&opened.root).join("notes");
    let snapshot_calls = Cell::new(0);
    let filesystem = AlreadyExistsDirectoryPort {
        create_dir_calls: Cell::new(0),
    };

    let outcome = create_workspace_directory_with_ports_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "notes",
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run after a lost directory race".to_string())
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
    assert_eq!(filesystem.create_dir_calls.get(), 1);
    assert_eq!(snapshot_calls.get(), 0);
    assert!(!target.exists());
}
#[test]
fn create_file_snapshot_is_stale_if_workspace_is_revoked_after_capture() {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let canonical_root = PathBuf::from(&opened.root);
    let target = canonical_root.join("draft.md");

    let outcome = create_workspace_file_with_snapshot_inner(
        &state,
        &opened.workspace_token,
        &canonical_root,
        "draft.md",
        |source| {
            let captured = capture_workspace_snapshot(source)?;
            crate::path_auth::revoke_authorized_path_prefix_inner(&state, &canonical_root)?;
            Ok(captured)
        },
    )
    .unwrap();

    assert!(target.is_file());
    let receipt = match outcome {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    };
    match receipt.workspace {
        SnapshotReceipt::Stale {
            workspace_token,
            repair_reason,
        } => {
            assert_eq!(workspace_token, opened.workspace_token);
            assert_eq!(repair_reason, "Workspace authorization is no longer active");
        }
        _ => panic!("expected stale workspace receipt"),
    }
}
#[test]
fn create_mutations_reject_valid_token_for_a_different_authorized_workspace() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let state = AppState::default();
    let first_snapshot = open_directory_inner(&state, first.path()).unwrap();
    open_directory_inner(&state, second.path()).unwrap();
    let target = second.path().join("draft.md");
    let snapshot_calls = std::cell::Cell::new(0);

    let outcome = create_workspace_file_with_snapshot_inner(
        &state,
        &first_snapshot.workspace_token,
        second.path(),
        "draft.md",
        |source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            capture_workspace_snapshot(source)
        },
    )
    .unwrap();

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        serde_json::json!({
            "status": "confirmed-not-committed",
            "message": "Directory is outside the selected workspace",
        })
    );
    assert_eq!(snapshot_calls.get(), 0);
    assert!(!target.exists());

    let directory_target = second.path().join("notes");
    let outcome = create_workspace_directory_with_snapshot_inner(
        &state,
        &first_snapshot.workspace_token,
        second.path(),
        "notes",
        |source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            capture_workspace_snapshot(source)
        },
    )
    .unwrap();

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        serde_json::json!({
            "status": "confirmed-not-committed",
            "message": "Directory is outside the selected workspace",
        })
    );
    assert_eq!(snapshot_calls.get(), 0);
    assert!(!directory_target.exists());
}

fn assert_indeterminate_directory_effects(
    filesystem: &DirectoryThenErrorFileSystemPort,
    target: &Path,
    snapshot_calls: &Cell<usize>,
    state: &AppState,
    authorization_before: &str,
) {
    assert_eq!(filesystem.create_dir_calls.get(), 1);
    assert_eq!(filesystem.observe_calls.get(), 1);
    assert_eq!(filesystem.attempted_path.borrow().as_deref(), Some(target));
    assert_eq!(snapshot_calls.get(), 0);
    assert!(fs::symlink_metadata(target).unwrap().file_type().is_dir());
    assert!(fs::read_dir(target).unwrap().next().is_none());
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(target)
            .unwrap(),
        None
    );
    assert_eq!(
        state.file_authorization().state_fingerprint_for_test(),
        authorization_before
    );
}

struct DirectoryThenErrorFileSystemPort {
    create_dir_calls: Cell<usize>,
    observe_calls: Cell<usize>,
    attempted_path: RefCell<Option<PathBuf>>,
}

impl FileSystemPort for DirectoryThenErrorFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("create-directory error test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-directory error test must not create files")
    }

    fn create_dir(&self, path: &Path) -> std::io::Result<()> {
        self.create_dir_calls.set(self.create_dir_calls.get() + 1);
        *self.attempted_path.borrow_mut() = Some(path.to_path_buf());
        fs::create_dir(path)?;
        Err(std::io::Error::other(
            "injected post-attempt directory create failure",
        ))
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("create-directory error test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-directory error test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-directory error test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        self.observe_calls.set(self.observe_calls.get() + 1);
        assert_eq!(self.attempted_path.borrow().as_deref(), Some(path));
        assert_eq!(expected_bytes, None);
        observe_path(path, None)
    }
}

struct AlreadyExistsDirectoryPort {
    create_dir_calls: Cell<usize>,
}

impl FileSystemPort for AlreadyExistsDirectoryPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("directory race test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory race test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        self.create_dir_calls.set(self.create_dir_calls.get() + 1);
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "injected directory race",
        ))
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("directory race test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory race test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory race test must not delete directories")
    }

    fn observe(
        &self,
        _path: &Path,
        _expected_bytes: Option<&[u8]>,
    ) -> std::io::Result<ObservedPath> {
        unreachable!("AlreadyExists is conclusive without observation")
    }
}
