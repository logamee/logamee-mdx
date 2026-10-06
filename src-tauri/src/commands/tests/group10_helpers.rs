//! Stage helpers for `group10_tests`: injected delete ports plus the
//! complete-delete scenario/act plumbing, extracted verbatim from the tests.
use super::fixtures2::*;

pub(super) struct RemoveDirAllThenErrorPort {
    pub(super) remove_dir_all_calls: Cell<usize>,
    pub(super) observe_calls: Cell<usize>,
}

impl FileSystemPort for RemoveDirAllThenErrorPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("directory delete test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory delete test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory delete test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("directory delete test must not rename entries")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("directory delete test must not delete a single file")
    }

    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        crate::path_auth::lock_order_test_probe::assert_authorization_held_without_html_sites();
        self.remove_dir_all_calls
            .set(self.remove_dir_all_calls.get() + 1);
        fs::remove_dir_all(path)?;
        Err(std::io::Error::other(
            "injected post-commit directory delete failure",
        ))
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        crate::path_auth::lock_order_test_probe::assert_no_locks_held();
        assert!(expected_bytes.is_none());
        self.observe_calls.set(self.observe_calls.get() + 1);
        observe_path(path, None)
    }
}

pub(super) struct DeleteObservationFailurePort {
    pub(super) remove_file_calls: Cell<usize>,
    pub(super) observe_calls: Cell<usize>,
}

impl FileSystemPort for DeleteObservationFailurePort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("delete observation test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("delete observation test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("delete observation test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("delete observation test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        self.remove_file_calls.set(self.remove_file_calls.get() + 1);
        Err(std::io::Error::other("injected delete failure"))
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("delete observation test must not delete directories")
    }

    fn observe(
        &self,
        _path: &Path,
        _expected_bytes: Option<&[u8]>,
    ) -> std::io::Result<ObservedPath> {
        self.observe_calls.set(self.observe_calls.get() + 1);
        Err(std::io::Error::other("injected observation failure"))
    }
}

pub(super) struct CompleteDeleteScenario {
    pub(super) _workspace: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) opened: WorkspaceSnapshot,
    pub(super) canonical_target: PathBuf,
    pub(super) canonical_document: PathBuf,
    pub(super) filesystem: RemoveDirAllThenErrorPort,
}

pub(super) struct CompleteDeleteOutcome {
    pub(super) receipt: crate::models::MutationCommitReceipt<
        crate::models::DeleteWorkspaceEntryResponse,
        WorkspaceSnapshot,
    >,
    pub(super) lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
}

pub(super) fn arrange_complete_delete_scenario() -> CompleteDeleteScenario {
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("target");
    let document = target.join("index.html");
    fs::create_dir(&target).unwrap();
    fs::write(&document, "<h1>target</h1>").unwrap();

    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &document, "preview").unwrap();
    let canonical_target = target.canonicalize().unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let filesystem = RemoveDirAllThenErrorPort {
        remove_dir_all_calls: Cell::new(0),
        observe_calls: Cell::new(0),
    };
    CompleteDeleteScenario {
        _workspace: workspace,
        state,
        opened,
        canonical_target,
        canonical_document,
        filesystem,
    }
}

pub(super) fn delete_target_with_complete_delete_port(
    scenario: &CompleteDeleteScenario,
) -> CompleteDeleteOutcome {
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        delete_workspace_entry_with_ports_inner(
            &scenario.state,
            &scenario.opened.workspace_token,
            &scenario.canonical_target,
            &scenario.filesystem,
            capture_workspace_snapshot,
        )
    });
    let outcome = outcome.expect("observed complete delete must be a mutation outcome");
    let receipt = match outcome {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed delete outcome"),
    };
    CompleteDeleteOutcome {
        receipt,
        lock_events,
    }
}
