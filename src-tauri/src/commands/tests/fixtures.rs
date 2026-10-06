//! Shared test fixtures beyond the import prelude.
pub(crate) use super::prelude::*;

#[cfg(unix)]
pub(super) fn replace_directory_with_test_link(link: &Path, target: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
pub(super) fn replace_directory_with_test_link(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .unwrap();
    assert!(status.success(), "failed to create test junction");
}

pub(crate) use crate::{
    path_auth::{is_authorized_image_path, normalize_existing_path},
    workspace_index::{build_index, CancellationToken, IndexDocument, IndexLimits},
};

pub(super) fn publish_workspace_index(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &Path,
    operation_id: &str,
) -> crate::workspace_index_runtime::WorkspaceIndexLease {
    let lease = state
        .workspace_index()
        .begin_rebuild_without_watch_for_test(workspace_token, workspace_root, operation_id)
        .unwrap();
    let (index, _) = build_index(
        vec![IndexDocument {
            relative_path: "note.md".to_string(),
            content: "indexed content".to_string(),
        }],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();
    assert!(state
        .workspace_index()
        .publish_rebuild(&lease, index)
        .unwrap());
    lease
}

pub(super) fn assert_workspace_index_invalidated(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &Path,
    lease: &crate::workspace_index_runtime::WorkspaceIndexLease,
) {
    assert!(!state
        .workspace_index()
        .is_result_current(workspace_token, workspace_root, lease.generation)
        .unwrap());
}

#[derive(Clone, Copy)]
pub(super) enum ScriptedTrashMode {
    Rejected,
    Committed,
    PlacementMismatch,
    PostMoveWithReceipt,
    PostMoveWithoutReceipt,
}

pub(super) struct ScriptedTrashPort {
    pub(super) mode: ScriptedTrashMode,
    pub(super) recovery_path: PathBuf,
    pub(super) calls: usize,
}

impl TrashPort for ScriptedTrashPort {
    type RecoveryReceipt = PathBuf;
    type Error = &'static str;

    fn move_to_trash(
        &mut self,
        source: &Path,
        _kind: TrashEntryKind,
    ) -> crate::workspace_trash::MoveToTrash<Self::RecoveryReceipt, Self::Error> {
        self.calls += 1;
        match self.mode {
            ScriptedTrashMode::Rejected => {
                crate::workspace_trash::MoveToTrash::Rejected { error: "rejected" }
            }
            ScriptedTrashMode::Committed | ScriptedTrashMode::PlacementMismatch => {
                fs::rename(source, &self.recovery_path).unwrap();
                crate::workspace_trash::MoveToTrash::Placed {
                    recovery_receipt: self.recovery_path.clone(),
                }
            }
            ScriptedTrashMode::PostMoveWithReceipt => {
                fs::rename(source, &self.recovery_path).unwrap();
                crate::workspace_trash::MoveToTrash::PossiblyMoved {
                    recovery_receipt: Some(self.recovery_path.clone()),
                    error: "post-move failure",
                }
            }
            ScriptedTrashMode::PostMoveWithoutReceipt => {
                fs::rename(source, &self.recovery_path).unwrap();
                crate::workspace_trash::MoveToTrash::PossiblyMoved {
                    recovery_receipt: None,
                    error: "post-move failure",
                }
            }
        }
    }

    fn observe_source(
        &mut self,
        source: &Path,
    ) -> crate::workspace_trash::SourceObservation<Self::Error> {
        if source.exists() {
            crate::workspace_trash::SourceObservation::Present
        } else {
            crate::workspace_trash::SourceObservation::Missing
        }
    }

    fn verify_placement(
        &mut self,
        recovery_receipt: &Self::RecoveryReceipt,
    ) -> crate::workspace_trash::PlacementVerification<Self::Error> {
        match self.mode {
            ScriptedTrashMode::Committed | ScriptedTrashMode::PostMoveWithReceipt
                if recovery_receipt.exists() =>
            {
                crate::workspace_trash::PlacementVerification::Proven
            }
            _ => crate::workspace_trash::PlacementVerification::Mismatch,
        }
    }
}

#[derive(Default)]
pub(super) struct ScriptedFileSystemPort {
    pub(super) rename_calls: Cell<usize>,
    pub(super) write_calls: Cell<usize>,
}

impl FileSystemPort for ScriptedFileSystemPort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        self.write_calls.set(self.write_calls.get() + 1);
        Ok(())
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("scripted rename/write port must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("scripted rename/write port must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        self.rename_calls.set(self.rename_calls.get() + 1);
        Ok(())
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("scripted rename/write port must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("scripted rename/write port must not delete directories")
    }
}
