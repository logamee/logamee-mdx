//! Stage helpers for `group8_tests`: injected remove-file error port plus
//! the shared scenario/act plumbing, extracted verbatim from the test body.
use super::fixtures2::*;

#[derive(Clone, Copy, Debug)]
pub(super) enum RemoveFileErrorLayout {
    Present,
    Absent,
}

pub(super) struct RemoveFileErrorFileSystemPort {
    pub(super) layout: RemoveFileErrorLayout,
    pub(super) remove_file_calls: Cell<usize>,
    pub(super) removed_paths: RefCell<Vec<PathBuf>>,
    pub(super) observed_paths: RefCell<Vec<PathBuf>>,
}

impl FileSystemPort for RemoveFileErrorFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("remove-file error port must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("remove-file error port must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("remove-file error port must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("remove-file error port must not rename entries")
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        crate::path_auth::lock_order_test_probe::assert_authorization_held_without_html_sites();
        self.remove_file_calls.set(self.remove_file_calls.get() + 1);
        self.removed_paths.borrow_mut().push(path.to_path_buf());
        if matches!(self.layout, RemoveFileErrorLayout::Absent) {
            fs::remove_file(path)?;
        }
        Err(std::io::Error::other(
            "injected post-attempt file delete failure",
        ))
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("remove-file error port must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        crate::path_auth::lock_order_test_probe::assert_authorization_held_without_html_sites();
        assert!(expected_bytes.is_none());
        self.observed_paths.borrow_mut().push(path.to_path_buf());
        observe_path(path, None)
    }
}

pub(super) struct RemoveFileErrorScenario {
    pub(super) _outer: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) selected_token: String,
    pub(super) ancestor_token: String,
    pub(super) canonical_outer: PathBuf,
    pub(super) canonical_workspace: PathBuf,
    pub(super) canonical_shared: PathBuf,
    pub(super) canonical_affected: PathBuf,
    pub(super) canonical_unrelated: PathBuf,
    pub(super) authorization_before: String,
    pub(super) sites_before: HashSet<PathBuf>,
    pub(super) leases_before: HashSet<crate::path_auth::PreviewLeaseId>,
}

pub(super) struct RemoveFileErrorAttempt {
    pub(super) outcome:
        MutationOutcome<crate::models::DeleteWorkspaceEntryResponse, WorkspaceSnapshot>,
    pub(super) filesystem: RemoveFileErrorFileSystemPort,
    pub(super) lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
    pub(super) snapshot_calls: usize,
}

fn open_remove_file_error_documents(state: &AppState, affected: &Path, unrelated: &Path) {
    for document in [affected, unrelated] {
        open_standalone_file_with_ports_inner(
            state,
            document,
            |file| open_authorized_file_response(file.to_path_buf()),
            |_| Ok(()),
        )
        .unwrap();
        crate::html_preview_server::prepare_html_preview_inner(state, document, "preview").unwrap();
    }
}

pub(super) fn arrange_remove_file_error_scenario() -> RemoveFileErrorScenario {
    let outer = tempdir().unwrap();
    let workspace = outer.path().join("workspace");
    let shared = workspace.join("shared");
    fs::create_dir_all(&shared).unwrap();
    let affected = shared.join("affected.html");
    let unrelated = shared.join("unrelated.html");
    fs::write(&affected, "affected").unwrap();
    fs::write(&unrelated, "unrelated").unwrap();

    let state = AppState::default();
    let ancestor_opened = open_directory_inner(&state, outer.path()).unwrap();
    let opened = open_directory_inner(&state, &workspace).unwrap();
    open_remove_file_error_documents(&state, &affected, &unrelated);

    let canonical_outer = outer.path().canonicalize().unwrap();
    let canonical_workspace = workspace.canonicalize().unwrap();
    let canonical_shared = shared.canonicalize().unwrap();
    let canonical_affected = affected.canonicalize().unwrap();
    let canonical_unrelated = unrelated.canonicalize().unwrap();
    let authorization_before = state.file_authorization().state_fingerprint_for_test();
    let sites_before = state.html_preview_server.site_documents().unwrap();
    let leases_before = state.file_authorization().preview_lease_snapshot().unwrap();
    RemoveFileErrorScenario {
        _outer: outer,
        state,
        selected_token: opened.workspace_token,
        ancestor_token: ancestor_opened.workspace_token,
        canonical_outer,
        canonical_workspace,
        canonical_shared,
        canonical_affected,
        canonical_unrelated,
        authorization_before,
        sites_before,
        leases_before,
    }
}

pub(super) fn attempt_remove_file_error(
    layout: RemoveFileErrorLayout,
    scenario: &RemoveFileErrorScenario,
) -> RemoveFileErrorAttempt {
    let filesystem = RemoveFileErrorFileSystemPort {
        layout,
        remove_file_calls: Cell::new(0),
        removed_paths: RefCell::new(Vec::new()),
        observed_paths: RefCell::new(Vec::new()),
    };
    let snapshot_calls = Cell::new(0);
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        delete_workspace_entry_with_ports_inner(
            &scenario.state,
            &scenario.selected_token,
            &scenario.canonical_affected,
            &filesystem,
            |_source| {
                crate::path_auth::lock_order_test_probe::assert_no_locks_held();
                snapshot_calls.set(snapshot_calls.get() + 1);
                Err("injected post-commit snapshot failure".to_string())
            },
        )
    });
    let outcome = outcome.expect("post-attempt file delete errors must be mutation outcomes");
    RemoveFileErrorAttempt {
        outcome,
        filesystem,
        lock_events,
        snapshot_calls: snapshot_calls.get(),
    }
}
