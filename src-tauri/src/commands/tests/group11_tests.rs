use super::fixtures2::*;

struct PartialWriteFileSystemPort {
    write_calls: Cell<usize>,
    observe_calls: Cell<usize>,
    observed_path: RefCell<Option<PathBuf>>,
    observed_expected_bytes: RefCell<Option<Vec<u8>>>,
}

impl FileSystemPort for PartialWriteFileSystemPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        self.write_calls.set(self.write_calls.get() + 1);
        fs::write(path, &bytes[..4])?;
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
        *self.observed_path.borrow_mut() = Some(path.to_path_buf());
        *self.observed_expected_bytes.borrow_mut() = expected_bytes.map(<[u8]>::to_vec);
        observe_path(path, expected_bytes)
    }
}

struct FullWriteThenErrorPort {
    write_calls: Cell<usize>,
    observe_calls: Cell<usize>,
}

impl FileSystemPort for FullWriteThenErrorPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        self.write_calls.set(self.write_calls.get() + 1);
        fs::write(path, bytes)?;
        Err(std::io::Error::other("injected post-commit write failure"))
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("write test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("write test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("write test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("write test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("write test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        crate::path_auth::lock_order_test_probe::assert_no_locks_held();
        self.observe_calls.set(self.observe_calls.get() + 1);
        observe_path(path, expected_bytes)
    }
}

struct PartialWriteScenario {
    workspace: tempfile::TempDir,
    state: AppState,
    canonical_document: PathBuf,
    filesystem: PartialWriteFileSystemPort,
}

struct PartialWriteAttempt {
    outcome: MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>,
    lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
}

fn arrange_partial_write_scenario() -> PartialWriteScenario {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    fs::write(&document, "<h1>before</h1>").unwrap();

    let state = AppState::default();
    open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &document, "<h1>preview</h1>")
        .unwrap();

    let canonical_document = document.canonicalize().unwrap();
    assert!(ensure_authorized_write_file_inner(&state, &canonical_document).is_ok());
    assert!(ensure_authorized_directory_inner(&state, workspace.path()).is_ok());
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&canonical_document));
    assert_eq!(
        state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        1
    );
    let filesystem = PartialWriteFileSystemPort {
        write_calls: Cell::new(0),
        observe_calls: Cell::new(0),
        observed_path: RefCell::new(None),
        observed_expected_bytes: RefCell::new(None),
    };
    PartialWriteScenario {
        workspace,
        state,
        canonical_document,
        filesystem,
    }
}

fn attempt_partial_existing_write(scenario: &PartialWriteScenario) -> PartialWriteAttempt {
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        write_file_with_ports_inner(
            &scenario.state,
            &scenario.canonical_document,
            "<h1>after</h1>",
            &scenario.filesystem,
        )
    });
    let outcome = outcome.expect("post-call write errors must be returned as mutation outcomes");
    PartialWriteAttempt {
        outcome,
        lock_events,
    }
}

fn assert_partial_write_observation(
    scenario: &PartialWriteScenario,
    attempt: &PartialWriteAttempt,
) {
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(&attempt.outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "write",
            "paths": [scenario.canonical_document.to_string_lossy()],
            "recovery_message": "Write may have partially changed the file after an error: Failed to write file: injected partial write failure. Reopen and inspect it before retrying.",
        })
    );
    assert_eq!(scenario.filesystem.write_calls.get(), 1);
    assert_eq!(scenario.filesystem.observe_calls.get(), 1);
    assert_eq!(
        scenario.filesystem.observed_path.borrow().as_deref(),
        Some(scenario.canonical_document.as_path())
    );
    assert_eq!(
        scenario
            .filesystem
            .observed_expected_bytes
            .borrow()
            .as_deref(),
        Some(b"<h1>after</h1>".as_slice())
    );
    assert_eq!(fs::read(&scenario.canonical_document).unwrap(), b"<h1>");
}

fn assert_partial_write_authority(scenario: &PartialWriteScenario) {
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_document)
            .unwrap(),
        Some((GrantStatus::Suspended, 1))
    );
    assert!(
        ensure_authorized_write_file_inner(&scenario.state, &scenario.canonical_document).is_err()
    );
    assert!(ensure_authorized_directory_inner(&scenario.state, scenario.workspace.path()).is_ok());
    assert!(scenario
        .state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(!scenario
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&scenario.canonical_document));
}

fn assert_partial_write_lock_order(attempt: &PartialWriteAttempt) {
    assert_eq!(
        attempt.lock_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
        ]
    );
}

#[test]
fn partial_existing_write_is_indeterminate() {
    let scenario = arrange_partial_write_scenario();
    let attempt = attempt_partial_existing_write(&scenario);
    assert_partial_write_observation(&scenario, &attempt);
    assert_partial_write_authority(&scenario);
    assert_partial_write_lock_order(&attempt);
}
#[test]
fn write_error_after_full_commit_is_confirmed_committed() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    fs::write(&document, "<h1>before</h1>").unwrap();
    let state = AppState::default();
    open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &document, "preview").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let filesystem = FullWriteThenErrorPort {
        write_calls: Cell::new(0),
        observe_calls: Cell::new(0),
    };

    let (outcome, _lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        write_file_with_ports_inner(&state, &canonical_document, "<h1>after</h1>", &filesystem)
    });
    let outcome = outcome.expect("observed complete write must be a mutation outcome");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-committed",
            "receipt": {
                "committed": {
                    "path": canonical_document.to_string_lossy(),
                },
                "workspace": {
                    "status": "not-applicable",
                },
            },
        }),
    );
    assert_eq!(filesystem.write_calls.get(), 1);
    assert_eq!(filesystem.observe_calls.get(), 1);
    assert_eq!(
        fs::read_to_string(&canonical_document).unwrap(),
        "<h1>after</h1>",
    );
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
    );
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&canonical_document));
}
