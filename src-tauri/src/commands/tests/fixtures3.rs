//! Third fixture slice.
use serde_json::json;

pub(crate) use super::fixtures::*;

pub(super) fn committed_rename_response(
    outcome: Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String>,
) -> RenameWorkspaceEntryResponse {
    match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt.committed,
        _ => panic!("expected confirmed committed rename outcome"),
    }
}

pub(super) fn committed_open_file_response(
    outcome: Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String>,
) -> OpenFileResponse {
    match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt.committed,
        _ => panic!("expected confirmed committed file creation outcome"),
    }
}

pub(super) fn committed_workspace_mutation(
    outcome: Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String>,
) -> WorkspaceMutation {
    match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt.committed,
        _ => panic!("expected confirmed committed workspace mutation outcome"),
    }
}

pub(super) fn assert_confirmed_not_committed<T>(
    outcome: Result<MutationOutcome<T, WorkspaceSnapshot>, String>,
) {
    assert!(matches!(
        outcome.unwrap(),
        MutationOutcome::ConfirmedNotCommitted { .. }
    ));
}

pub(super) const P2_PDF_SOURCE_LIMIT: u64 = 64 * 1024 * 1024;
pub(super) const P2_DOCX_SOURCE_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub(crate) enum RenameErrorLayout {
    OldOnly,
    NewOnly,
    Both,
    Neither,
}

pub(crate) struct RenameErrorFileSystemPort {
    pub(crate) layout: RenameErrorLayout,
    pub(crate) rename_calls: Cell<usize>,
    pub(crate) renamed_paths: RefCell<Vec<(PathBuf, PathBuf)>>,
    pub(crate) observed_paths: RefCell<Vec<PathBuf>>,
}

impl FileSystemPort for RenameErrorFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("rename error port must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename error port must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename error port must not create directories")
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.rename_calls.set(self.rename_calls.get() + 1);
        self.renamed_paths
            .borrow_mut()
            .push((from.to_path_buf(), to.to_path_buf()));
        match self.layout {
            RenameErrorLayout::OldOnly => {}
            RenameErrorLayout::NewOnly => fs::rename(from, to)?,
            RenameErrorLayout::Both => {
                fs::create_dir(to)?;
                fs::copy(from.join("index.html"), to.join("index.html"))?;
            }
            RenameErrorLayout::Neither => fs::remove_dir_all(from)?,
        }
        Err(std::io::Error::other(
            "injected post-attempt rename failure",
        ))
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename error port must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename error port must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        crate::path_auth::lock_order_test_probe::assert_no_locks_held();
        assert!(expected_bytes.is_none());
        self.observed_paths.borrow_mut().push(path.to_path_buf());
        observe_path(path, None)
    }
}

pub(crate) fn expected_rename_error_outcome(
    layout: RenameErrorLayout,
    canonical_source: &std::path::Path,
    canonical_target: &std::path::Path,
    workspace_token: &str,
) -> serde_json::Value {
    match layout {
        RenameErrorLayout::OldOnly => json!({
            "status": "confirmed-not-committed",
            "message": "Failed to rename entry: injected post-attempt rename failure",
        }),
        RenameErrorLayout::NewOnly => json!({
            "status": "confirmed-committed",
            "receipt": {
                "committed": {
                    "entry_kind": "directory",
                    "old_path": canonical_source.to_string_lossy(),
                    "new_path": canonical_target.to_string_lossy(),
                },
                "workspace": {
                    "status": "stale",
                    "workspace_token": workspace_token,
                    "repair_reason": "snapshot must not run after a rename error",
                },
            },
        }),
        RenameErrorLayout::Both => json!({
            "status": "indeterminate",
            "operation": "rename",
            "paths": [
                canonical_source.to_string_lossy(),
                canonical_target.to_string_lossy(),
            ],
            "recovery_message": "Rename may have partially changed the workspace after an error: Failed to rename entry: injected post-attempt rename failure. Refresh and inspect both paths before retrying. Outcome observation found both old and new paths; the rename remains indeterminate.",
        }),
        RenameErrorLayout::Neither => json!({
            "status": "indeterminate",
            "operation": "rename",
            "paths": [
                canonical_source.to_string_lossy(),
                canonical_target.to_string_lossy(),
            ],
            "recovery_message": "Rename may have partially changed the workspace after an error: Failed to rename entry: injected post-attempt rename failure. Refresh and inspect both paths before retrying. Outcome observation found neither old nor new path; the rename remains indeterminate.",
        }),
    }
}

pub(crate) fn assert_rename_error_filesystem(
    layout: RenameErrorLayout,
    canonical_source: &std::path::Path,
    canonical_target: &std::path::Path,
    canonical_old_document: &std::path::Path,
    canonical_new_document: &std::path::Path,
    state: &crate::state::AppState,
) {
    assert_rename_error_layout_paths(layout, canonical_source, canonical_target);
    assert_rename_error_layout_grants(
        layout,
        canonical_source,
        canonical_target,
        canonical_old_document,
        canonical_new_document,
        state,
    );
}

fn assert_rename_error_layout_paths(
    layout: RenameErrorLayout,
    canonical_source: &std::path::Path,
    canonical_target: &std::path::Path,
) {
    let (expect_old, expect_new) = match layout {
        RenameErrorLayout::OldOnly => (true, false),
        RenameErrorLayout::NewOnly => (false, true),
        RenameErrorLayout::Both => (true, true),
        RenameErrorLayout::Neither => (false, false),
    };
    for (path, expected) in [
        (canonical_source, expect_old),
        (canonical_target, expect_new),
    ] {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                assert!(
                    expected,
                    "unexpected path for {layout:?}: {}",
                    path.display()
                );
                assert!(
                    metadata.file_type().is_dir(),
                    "present path is not a real directory for {layout:?}: {}",
                    path.display(),
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                assert!(!expected, "missing path for {layout:?}: {}", path.display());
            }
            Err(error) => panic!(
                "cannot inspect path for {layout:?}: {}: {error}",
                path.display(),
            ),
        }
    }
}

fn assert_rename_error_layout_grants(
    layout: RenameErrorLayout,
    canonical_source: &std::path::Path,
    canonical_target: &std::path::Path,
    canonical_old_document: &std::path::Path,
    canonical_new_document: &std::path::Path,
    state: &crate::state::AppState,
) {
    const ACTIVE_1: Option<(GrantStatus, usize)> = Some((GrantStatus::Active, 1));
    const ACTIVE_2: Option<(GrantStatus, usize)> = Some((GrantStatus::Active, 2));
    const SUSPENDED_1: Option<(GrantStatus, usize)> = Some((GrantStatus::Suspended, 1));
    let old_and_new_documents = [canonical_old_document, canonical_new_document];
    let source_and_target = [canonical_source, canonical_target];

    match layout {
        RenameErrorLayout::OldOnly => {
            assert_write_grants(layout, state, &old_and_new_documents, ACTIVE_1);
            assert_asset_grants(layout, state, &source_and_target, ACTIVE_2);
        }
        RenameErrorLayout::NewOnly => {
            assert_write_grants(layout, state, &[canonical_old_document], None);
            assert_write_grants(layout, state, &[canonical_new_document], ACTIVE_2);
            assert_asset_grants(layout, state, &[canonical_source], None);
            assert_asset_grants(layout, state, &[canonical_target], ACTIVE_2);
        }
        RenameErrorLayout::Both | RenameErrorLayout::Neither => {
            assert_write_grants(layout, state, &old_and_new_documents, SUSPENDED_1);
            assert_asset_grants(layout, state, &source_and_target, SUSPENDED_1);
        }
    }
}

fn assert_write_grants(
    layout: RenameErrorLayout,
    state: &crate::state::AppState,
    documents: &[&std::path::Path],
    expected: Option<(GrantStatus, usize)>,
) {
    for document in documents {
        assert_eq!(
            state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(document)
                .unwrap(),
            expected,
            "{layout:?}",
        );
    }
}

fn assert_asset_grants(
    layout: RenameErrorLayout,
    state: &crate::state::AppState,
    directories: &[&std::path::Path],
    expected: Option<(GrantStatus, usize)>,
) {
    for directory in directories {
        assert_eq!(
            state
                .file_authorization()
                .internal_asset_grant_snapshot_for_test(directory)
                .unwrap(),
            expected,
            "{layout:?}",
        );
    }
}
