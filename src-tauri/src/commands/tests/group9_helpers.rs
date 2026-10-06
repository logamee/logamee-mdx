//! Stage helpers for `group9_tests`: injected partial directory delete port
//! plus the shared scenario/act plumbing, extracted verbatim from the test.
use super::fixtures2::*;

pub(super) struct PartialRemoveDirAllFileSystemPort {
    pub(super) remove_dir_all_calls: Cell<usize>,
    pub(super) removed_paths: RefCell<Vec<PathBuf>>,
    pub(super) observed_paths: RefCell<Vec<PathBuf>>,
}

impl FileSystemPort for PartialRemoveDirAllFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("partial directory delete port must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial directory delete port must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial directory delete port must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("partial directory delete port must not rename entries")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial directory delete port must not delete a single file")
    }

    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        crate::path_auth::lock_order_test_probe::assert_authorization_held_without_html_sites();
        self.remove_dir_all_calls
            .set(self.remove_dir_all_calls.get() + 1);
        self.removed_paths.borrow_mut().push(path.to_path_buf());
        fs::remove_file(path.join("removed.html"))?;
        fs::remove_file(path.join("removed.png"))?;
        Err(std::io::Error::other(
            "injected partial directory delete failure",
        ))
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        crate::path_auth::lock_order_test_probe::assert_no_locks_held();
        assert!(expected_bytes.is_none());
        self.observed_paths.borrow_mut().push(path.to_path_buf());
        observe_path(path, None)
    }
}

pub(super) struct PartialRemoveWorkspace {
    pub(super) outer: tempfile::TempDir,
    pub(super) workspace: PathBuf,
    pub(super) target: PathBuf,
    pub(super) unrelated: PathBuf,
    pub(super) removed_document: PathBuf,
    pub(super) removed_image: PathBuf,
    pub(super) retained_document: PathBuf,
    pub(super) unrelated_document: PathBuf,
}

pub(super) struct PartialRemoveScenario {
    pub(super) _outer: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) selected_token: String,
    pub(super) ancestor_token: String,
    pub(super) canonical_outer: PathBuf,
    pub(super) canonical_workspace: PathBuf,
    pub(super) canonical_target: PathBuf,
    pub(super) canonical_unrelated: PathBuf,
    pub(super) canonical_removed_document: PathBuf,
    pub(super) canonical_removed_image: PathBuf,
    pub(super) canonical_retained_document: PathBuf,
    pub(super) canonical_unrelated_document: PathBuf,
    pub(super) unrelated_leases: HashSet<crate::path_auth::PreviewLeaseId>,
}

pub(super) struct PartialRemoveAttempt {
    pub(super) outcome:
        MutationOutcome<crate::models::DeleteWorkspaceEntryResponse, WorkspaceSnapshot>,
    pub(super) filesystem: PartialRemoveDirAllFileSystemPort,
    pub(super) lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
    pub(super) snapshot_calls: usize,
}

pub(super) fn create_partial_remove_workspace() -> PartialRemoveWorkspace {
    let outer = tempdir().unwrap();
    let workspace = outer.path().join("workspace");
    let target = workspace.join("target");
    let unrelated = workspace.join("unrelated");
    fs::create_dir_all(&target).unwrap();
    fs::create_dir_all(&unrelated).unwrap();
    let removed_document = target.join("removed.html");
    let removed_image = target.join("removed.png");
    let retained_document = target.join("retained.html");
    let unrelated_document = unrelated.join("index.html");
    fs::write(&removed_document, "removed").unwrap();
    fs::write(&removed_image, b"removed-image").unwrap();
    fs::write(&retained_document, "retained").unwrap();
    fs::write(&unrelated_document, "unrelated").unwrap();
    PartialRemoveWorkspace {
        outer,
        workspace,
        target,
        unrelated,
        removed_document,
        removed_image,
        retained_document,
        unrelated_document,
    }
}

fn open_partial_remove_document(state: &AppState, document: &Path, preview: &str) {
    open_standalone_file_with_ports_inner(
        state,
        document,
        |file| open_authorized_file_response(file.to_path_buf()),
        |_| Ok(()),
    )
    .unwrap();
    crate::html_preview_server::prepare_html_preview_inner(state, document, preview).unwrap();
}

pub(super) fn open_partial_remove_documents(
    state: &AppState,
    files: &PartialRemoveWorkspace,
) -> HashSet<crate::path_auth::PreviewLeaseId> {
    open_partial_remove_document(state, &files.unrelated_document, "unrelated preview");
    let unrelated_leases = state.file_authorization().preview_lease_snapshot().unwrap();
    assert_eq!(unrelated_leases.len(), 1);
    for document in [&files.removed_document, &files.retained_document] {
        open_partial_remove_document(state, document, "affected preview");
    }
    unrelated_leases
}

pub(super) fn canonicalize_partial_remove_scenario(
    files: PartialRemoveWorkspace,
    state: AppState,
    selected_token: String,
    ancestor_token: String,
    unrelated_leases: HashSet<crate::path_auth::PreviewLeaseId>,
) -> PartialRemoveScenario {
    let canonical_outer = files.outer.path().canonicalize().unwrap();
    let canonical_workspace = files.workspace.canonicalize().unwrap();
    let canonical_target = files.target.canonicalize().unwrap();
    let canonical_unrelated = files.unrelated.canonicalize().unwrap();
    let canonical_removed_document = files.removed_document.canonicalize().unwrap();
    let canonical_removed_image = files.removed_image.canonicalize().unwrap();
    let canonical_retained_document = files.retained_document.canonicalize().unwrap();
    let canonical_unrelated_document = files.unrelated_document.canonicalize().unwrap();
    PartialRemoveScenario {
        _outer: files.outer,
        state,
        selected_token,
        ancestor_token,
        canonical_outer,
        canonical_workspace,
        canonical_target,
        canonical_unrelated,
        canonical_removed_document,
        canonical_removed_image,
        canonical_retained_document,
        canonical_unrelated_document,
        unrelated_leases,
    }
}

pub(super) fn attempt_partial_remove(scenario: &PartialRemoveScenario) -> PartialRemoveAttempt {
    let filesystem = PartialRemoveDirAllFileSystemPort {
        remove_dir_all_calls: Cell::new(0),
        removed_paths: RefCell::new(Vec::new()),
        observed_paths: RefCell::new(Vec::new()),
    };
    let snapshot_calls = Cell::new(0);
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        delete_workspace_entry_with_ports_inner(
            &scenario.state,
            &scenario.selected_token,
            &scenario.canonical_target,
            &filesystem,
            |_source| {
                crate::path_auth::lock_order_test_probe::assert_no_locks_held();
                snapshot_calls.set(snapshot_calls.get() + 1);
                Err("snapshot must not run after a partial directory delete".to_string())
            },
        )
    });
    let outcome = outcome.expect("partial directory delete errors must be mutation outcomes");
    PartialRemoveAttempt {
        outcome,
        filesystem,
        lock_events,
        snapshot_calls: snapshot_calls.get(),
    }
}
