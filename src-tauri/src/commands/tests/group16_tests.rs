use super::fixtures2::*;

#[derive(Clone, Copy, Debug)]
enum Layout {
    OldOnly,
    NewOnly,
}

struct PartialWriteThenErrorPort;

impl FileSystemPort for PartialWriteThenErrorPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        fs::write(path, &bytes[..1])?;
        Err(std::io::Error::other("injected partial write"))
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial-write setup must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial-write setup must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("partial-write setup must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial-write setup must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("partial-write setup must not delete directories")
    }
}

struct RenameThenErrorPort {
    layout: Layout,
}

impl FileSystemPort for RenameThenErrorPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("rename test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename test must not create directories")
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        if matches!(self.layout, Layout::NewOnly) {
            fs::rename(from, to)?;
        }
        Err(std::io::Error::other("injected rename failure"))
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename test must not delete directories")
    }
}

struct RenameReconciliationFixture {
    _workspace: tempfile::TempDir,
    state: AppState,
    opened: WorkspaceSnapshot,
    canonical_source: PathBuf,
    canonical_target: PathBuf,
    canonical_source_document: PathBuf,
    canonical_stale_target_document: PathBuf,
}

fn rename_reconciliation_fixture() -> RenameReconciliationFixture {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("drafts");
    let target = workspace.path().join("archive");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    let source_document = source.join("index.html");
    let stale_target_document = target.join("stale.html");
    fs::write(&source_document, "source").unwrap();
    fs::write(&stale_target_document, "stale").unwrap();

    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    for document in [&source_document, &stale_target_document] {
        open_standalone_file_with_ports_inner(
            &state,
            document,
            |file| open_authorized_file_response(file.to_path_buf()),
            |_| Ok(()),
        )
        .unwrap();
        crate::html_preview_server::prepare_html_preview_inner(&state, document, "preview")
            .unwrap();
    }

    RenameReconciliationFixture {
        canonical_source: source.canonicalize().unwrap(),
        canonical_target: target.canonicalize().unwrap(),
        canonical_source_document: source_document.canonicalize().unwrap(),
        canonical_stale_target_document: stale_target_document.canonicalize().unwrap(),
        _workspace: workspace,
        state,
        opened,
    }
}

fn suspend_stale_target_document(fixture: &RenameReconciliationFixture) {
    let partial = write_file_with_ports_inner(
        &fixture.state,
        &fixture.canonical_stale_target_document,
        "changed",
        &PartialWriteThenErrorPort,
    )
    .unwrap();
    assert!(matches!(partial, MutationOutcome::Indeterminate { .. }));
    assert_eq!(
        fixture
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&fixture.canonical_stale_target_document)
            .unwrap()
            .map(|(status, _)| status),
        Some(GrantStatus::Suspended),
    );
}

fn assert_old_only_rename_error_kept_previews(
    fixture: &RenameReconciliationFixture,
    outcome: MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>,
    sites_before: HashSet<PathBuf>,
    leases_before: HashSet<crate::path_auth::PreviewLeaseId>,
) {
    assert!(matches!(
        outcome,
        MutationOutcome::ConfirmedNotCommitted { .. }
    ));
    assert_eq!(
        fixture.state.html_preview_server.site_documents().unwrap(),
        sites_before,
    );
    assert_eq!(
        fixture
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap(),
        leases_before,
    );
    assert_eq!(
        fixture
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&fixture.canonical_source_document)
            .unwrap()
            .map(|(status, _)| status),
        Some(GrantStatus::Active),
    );
}

fn assert_new_only_rename_error_relocated_grants(
    fixture: &RenameReconciliationFixture,
    outcome: MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>,
) {
    assert!(matches!(
        outcome,
        MutationOutcome::ConfirmedCommitted { .. }
    ));
    let relocated_source_document = fixture.canonical_target.join("index.html");
    assert_eq!(
        fixture
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&relocated_source_document)
            .unwrap()
            .map(|(status, _)| status),
        Some(GrantStatus::Active),
    );
    assert!(fixture
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
}

fn assert_stale_target_grant_stays_suspended(
    layout: Layout,
    fixture: &RenameReconciliationFixture,
) {
    assert_eq!(
        fixture
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&fixture.canonical_stale_target_document)
            .unwrap()
            .map(|(status, _)| status),
        Some(GrantStatus::Suspended),
        "{layout:?}",
    );
}

#[test]
fn rename_error_reconciliation_preserves_prior_suspension_and_old_only_previews() {
    for layout in [Layout::OldOnly, Layout::NewOnly] {
        let fixture = rename_reconciliation_fixture();
        suspend_stale_target_document(&fixture);

        let sites_before = fixture.state.html_preview_server.site_documents().unwrap();
        let leases_before = fixture
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap();
        assert_eq!(
            sites_before,
            HashSet::from([fixture.canonical_source_document.clone()]),
            "{layout:?}",
        );
        assert_eq!(leases_before.len(), 1, "{layout:?}");

        fs::remove_dir_all(&fixture.canonical_target).unwrap();
        let outcome = rename_workspace_entry_with_ports_inner(
            &fixture.state,
            &fixture.opened.workspace_token,
            &fixture.canonical_source,
            "archive",
            &RenameThenErrorPort { layout },
            crate::workspace_snapshot::capture_workspace_snapshot,
        )
        .unwrap();

        match layout {
            Layout::OldOnly => assert_old_only_rename_error_kept_previews(
                &fixture,
                outcome,
                sites_before,
                leases_before,
            ),
            Layout::NewOnly => assert_new_only_rename_error_relocated_grants(&fixture, outcome),
        }
        assert_stale_target_grant_stays_suspended(layout, &fixture);
    }
}
