//! Stage helpers for `group7_tests`: shared scenario state plus the act of
//! running the failing rename, extracted verbatim from the test body.
use super::fixtures3::*;

pub(super) struct RenameErrorWorkspace {
    pub(super) workspace: tempfile::TempDir,
    pub(super) source: PathBuf,
    pub(super) target: PathBuf,
    pub(super) unrelated: PathBuf,
    pub(super) old_document: PathBuf,
    pub(super) new_document: PathBuf,
    pub(super) unrelated_document: PathBuf,
}

pub(super) struct RenameErrorScenario {
    pub(super) _workspace: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) workspace_token: String,
    pub(super) canonical_workspace: PathBuf,
    pub(super) canonical_source: PathBuf,
    pub(super) canonical_target: PathBuf,
    pub(super) canonical_old_document: PathBuf,
    pub(super) canonical_new_document: PathBuf,
    pub(super) canonical_unrelated: PathBuf,
    pub(super) canonical_unrelated_document: PathBuf,
    pub(super) all_sites: HashSet<PathBuf>,
}

pub(super) struct RenameErrorAttempt {
    pub(super) outcome: MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>,
    pub(super) filesystem: RenameErrorFileSystemPort,
    pub(super) lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
    pub(super) snapshot_calls: usize,
}

pub(super) fn create_rename_error_workspace() -> RenameErrorWorkspace {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("drafts");
    let target = workspace.path().join("archive");
    let unrelated = workspace.path().join("unrelated");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    fs::create_dir(&unrelated).unwrap();
    let old_document = source.join("index.html");
    let new_document = target.join("index.html");
    let unrelated_document = unrelated.join("index.html");
    fs::write(&old_document, "old").unwrap();
    fs::write(&new_document, "new").unwrap();
    fs::write(&unrelated_document, "unrelated").unwrap();
    RenameErrorWorkspace {
        workspace,
        source,
        target,
        unrelated,
        old_document,
        new_document,
        unrelated_document,
    }
}

pub(super) fn open_rename_error_documents(state: &AppState, files: &RenameErrorWorkspace) {
    for document in [
        &files.old_document,
        &files.new_document,
        &files.unrelated_document,
    ] {
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

pub(super) fn canonicalize_rename_error_scenario(
    files: RenameErrorWorkspace,
    state: AppState,
    workspace_token: String,
) -> RenameErrorScenario {
    let canonical_workspace = files.workspace.path().canonicalize().unwrap();
    let canonical_source = files.source.canonicalize().unwrap();
    let canonical_target = files.target.canonicalize().unwrap();
    let canonical_old_document = files.old_document.canonicalize().unwrap();
    let canonical_new_document = files.new_document.canonicalize().unwrap();
    let canonical_unrelated = files.unrelated.canonicalize().unwrap();
    let canonical_unrelated_document = files.unrelated_document.canonicalize().unwrap();
    let all_sites = HashSet::from([
        canonical_old_document.clone(),
        canonical_new_document.clone(),
        canonical_unrelated_document.clone(),
    ]);
    RenameErrorScenario {
        _workspace: files.workspace,
        state,
        workspace_token,
        canonical_workspace,
        canonical_source,
        canonical_target,
        canonical_old_document,
        canonical_new_document,
        canonical_unrelated,
        canonical_unrelated_document,
        all_sites,
    }
}

pub(super) fn attempt_rename_error(
    layout: RenameErrorLayout,
    scenario: &RenameErrorScenario,
) -> RenameErrorAttempt {
    fs::remove_dir_all(&scenario.canonical_target).unwrap();
    assert!(scenario.canonical_source.is_dir(), "{layout:?}");
    assert!(!scenario.canonical_target.exists(), "{layout:?}");

    let filesystem = RenameErrorFileSystemPort {
        layout,
        rename_calls: Cell::new(0),
        renamed_paths: RefCell::new(Vec::new()),
        observed_paths: RefCell::new(Vec::new()),
    };
    let snapshot_calls = Cell::new(0);
    let (outcome, lock_events) = crate::path_auth::lock_order_test_probe::trace(|| {
        rename_workspace_entry_with_ports_inner(
            &scenario.state,
            &scenario.workspace_token,
            &scenario.canonical_source,
            "archive",
            &filesystem,
            |_source| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                Err("snapshot must not run after a rename error".to_string())
            },
        )
    });
    let outcome = outcome.expect("post-attempt rename errors must be mutation outcomes");
    RenameErrorAttempt {
        outcome,
        filesystem,
        lock_events,
        snapshot_calls: snapshot_calls.get(),
    }
}
