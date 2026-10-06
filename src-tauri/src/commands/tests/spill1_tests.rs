use super::trash_fixtures::*;

struct EmptyThenErrorFileSystemPort {
    create_new_calls: Cell<usize>,
    observe_calls: Cell<usize>,
    attempted_path: RefCell<Option<PathBuf>>,
}

impl FileSystemPort for EmptyThenErrorFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("create-file error test must not use truncating write")
    }

    fn create_new(&self, path: &Path) -> std::io::Result<()> {
        self.create_new_calls.set(self.create_new_calls.get() + 1);
        *self.attempted_path.borrow_mut() = Some(path.to_path_buf());
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)?;
        Err(std::io::Error::other(
            "injected post-attempt create failure",
        ))
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file error test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("create-file error test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file error test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("create-file error test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        self.observe_calls.set(self.observe_calls.get() + 1);
        assert_eq!(self.attempted_path.borrow().as_deref(), Some(path));
        assert_eq!(expected_bytes, Some([].as_slice()));
        observe_path(path, Some(&[]))
    }
}

fn assert_indeterminate_create_side_effects(
    state: &AppState,
    filesystem: &EmptyThenErrorFileSystemPort,
    target: &Path,
    snapshot_calls: &Cell<usize>,
    authorization_before: &str,
) {
    assert_eq!(filesystem.create_new_calls.get(), 1);
    assert_eq!(filesystem.observe_calls.get(), 1);
    assert_eq!(filesystem.attempted_path.borrow().as_deref(), Some(target));
    assert_eq!(snapshot_calls.get(), 0);
    let target_metadata = fs::metadata(target).unwrap();
    assert!(target_metadata.is_file());
    assert_eq!(target_metadata.len(), 0);
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(target)
            .unwrap(),
        None
    );
    assert!(ensure_authorized_write_file_inner(state, target).is_err());

    let authorization_after = state.file_authorization().state_fingerprint_for_test();
    assert_eq!(
        authorization_after.rsplit_once(";counters=").unwrap().0,
        authorization_before.rsplit_once(";counters=").unwrap().0,
    );
}

#[test]
fn create_file_post_attempt_error_with_empty_file_is_indeterminate() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let target = PathBuf::from(&opened.root).join("draft.md");
    let authorization_before = state.file_authorization().state_fingerprint_for_test();
    let snapshot_calls = Cell::new(0);
    let filesystem = EmptyThenErrorFileSystemPort {
        create_new_calls: Cell::new(0),
        observe_calls: Cell::new(0),
        attempted_path: RefCell::new(None),
    };

    let outcome = create_workspace_file_with_ports_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "draft.md",
        &filesystem,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run after an indeterminate create".to_string())
        },
    )
    .expect("post-attempt create errors must be mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "create",
            "paths": [target.to_string_lossy()],
            "recovery_message": "File creation may have committed before an error: Failed to create file: injected post-attempt create failure. Refresh and inspect the workspace before retrying.",
        })
    );
    assert_indeterminate_create_side_effects(
        &state,
        &filesystem,
        &target,
        &snapshot_calls,
        &authorization_before,
    );
}
