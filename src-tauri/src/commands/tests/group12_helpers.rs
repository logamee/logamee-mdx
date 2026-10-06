//! Stage helpers for `group12_tests`: injected partial write/save-as ports
//! plus the poisoning-preview scenario plumbing, extracted verbatim from the
//! test bodies.
use super::fixtures2::*;

pub(super) struct PoisoningPartialWriteFileSystemPort<'a> {
    pub(super) state: &'a AppState,
    pub(super) write_calls: Cell<usize>,
    pub(super) observe_calls: Cell<usize>,
}

impl FileSystemPort for PoisoningPartialWriteFileSystemPort<'_> {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        self.write_calls.set(self.write_calls.get() + 1);
        fs::write(path, &bytes[..4])?;
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = self.state.file_authorization().open_standalone_file(
                path,
                |_| Ok(()),
                |_| panic!("injected post-write authorization poison"),
            );
        }));
        assert!(poison.is_err());
        Err(std::io::Error::other("injected partial write failure"))
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial write test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial write test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("partial write test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial write test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial write test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        self.observe_calls.set(self.observe_calls.get() + 1);
        observe_path(path, expected_bytes)
    }
}

pub(super) struct PartialSaveAsFileSystemPort {
    pub(super) write_calls: Cell<usize>,
    pub(super) observe_calls: Cell<usize>,
    pub(super) observed_path: RefCell<Option<PathBuf>>,
    pub(super) observed_expected_bytes: RefCell<Option<Vec<u8>>>,
}

impl FileSystemPort for PartialSaveAsFileSystemPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        self.write_calls.set(self.write_calls.get() + 1);
        fs::write(path, &bytes[..4])?;
        Err(std::io::Error::other("injected partial save-as failure"))
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial save-as test must not create workspace files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial save-as test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("partial save-as test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial save-as test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial save-as test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        self.observe_calls.set(self.observe_calls.get() + 1);
        *self.observed_path.borrow_mut() = Some(path.to_path_buf());
        *self.observed_expected_bytes.borrow_mut() = expected_bytes.map(<[u8]>::to_vec);
        observe_path(path, expected_bytes)
    }
}

pub(super) struct PoisonedPreviewScenario {
    pub(super) _workspace: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) canonical_document: PathBuf,
}

pub(super) struct PoisoningWriteAttempt<'a> {
    pub(super) outcome: MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>,
    pub(super) filesystem: PoisoningPartialWriteFileSystemPort<'a>,
    pub(super) lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
}

pub(super) fn arrange_poisoned_preview_scenario() -> PoisonedPreviewScenario {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    let unrelated = workspace.path().join("unrelated.html");
    fs::write(&document, "<h1>before</h1>").unwrap();
    fs::write(&unrelated, "<h1>unrelated</h1>").unwrap();

    let state = AppState::default();
    open_directory_inner(&state, workspace.path()).unwrap();
    for path in [&document, &unrelated] {
        open_workspace_file_inner(&state, path).unwrap();
        crate::html_preview_server::prepare_html_preview_inner(&state, path, "<h1>preview</h1>")
            .unwrap();
    }

    let canonical_document = document.canonicalize().unwrap();
    let canonical_unrelated = unrelated.canonicalize().unwrap();
    assert_eq!(
        state.html_preview_server.site_documents().unwrap(),
        HashSet::from([canonical_document.clone(), canonical_unrelated])
    );
    PoisonedPreviewScenario {
        _workspace: workspace,
        state,
        canonical_document,
    }
}

pub(super) fn attempt_poisoning_partial_write<'a>(
    scenario: &'a PoisonedPreviewScenario,
) -> PoisoningWriteAttempt<'a> {
    let filesystem = PoisoningPartialWriteFileSystemPort {
        state: &scenario.state,
        write_calls: Cell::new(0),
        observe_calls: Cell::new(0),
    };
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        write_file_with_ports_inner(
            &scenario.state,
            &scenario.canonical_document,
            "<h1>after</h1>",
            &filesystem,
        )
    });
    let outcome = outcome.expect("post-call cleanup failures must remain mutation outcomes");
    PoisoningWriteAttempt {
        outcome,
        filesystem,
        lock_events,
    }
}
