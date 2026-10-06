use std::path::Path;

use crate::models::{MutationOutcome, WorkspaceSnapshot};
use crate::state::AppState;
#[allow(unused_imports)]
use crate::models::{DeleteWorkspaceEntryResponse, MutationCommitReceipt};
#[cfg(test)]
use crate::path_auth::delete_authorized_workspace_entry_inner;
use crate::path_auth::{
    trash_authorized_workspace_entry_inner, AuthorizedDeleteOutcome, DeletedWorkspaceEntry,
    TrashAuthorizationDisposition, WorkspaceSnapshotSource,
};
#[cfg(test)]
use super::delete_test_helpers::{
    confirmed_or_indeterminate_call_error, filesystem_delete_adapters,
    reconcile_indeterminate_file_delete,
};
#[cfg(test)]
use super::super::SystemFileSystemPort;
#[cfg(test)]
use super::super::FileSystemPort;
use crate::workspace_snapshot::CapturedWorkspaceSnapshot;
use crate::workspace_trash::{classify_trash, TrashClassification, TrashEntryKind, TrashPort};
use crate::workspace_snapshot::capture_workspace_snapshot;
#[allow(unused_imports)]
use crate::workspace_trash_native::NativeTrashPort;
#[allow(unused_imports)]
use super::{capture_post_commit_workspace_receipt, committed_workspace_outcome, discard_workspace_index_after_workspace_mutation};

#[cfg(test)]
#[cfg(test)]
pub(crate) fn delete_workspace_entry_with_ports_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let filesystem_called = std::cell::Cell::new(false);
    let requested_path = path.as_ref().to_path_buf();
    let (remove_entry, observe_entry) =
        filesystem_delete_adapters(filesystem, &filesystem_called);
    let outcome = delete_authorized_workspace_entry_inner(
        state,
        workspace_token,
        path,
        remove_entry,
        observe_entry,
    );
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(message) => {
            return confirmed_or_indeterminate_call_error(
                message,
                filesystem_called.get(),
                &requested_path,
            );
        }
    };

    match outcome {
        AuthorizedDeleteOutcome::ConfirmedNotCommitted { message } => {
            Ok(MutationOutcome::ConfirmedNotCommitted { message })
        }
        AuthorizedDeleteOutcome::Committed(deleted) => {
            let committed = DeleteWorkspaceEntryResponse {
                deleted_path: deleted.deleted_path().to_string_lossy().to_string(),
            };
            Ok(committed_workspace_outcome(state, deleted.workspace(), committed, snapshot))
        }
        AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message,
        } => Ok(delete_recovery_required_outcome(deleted, recovery_message)),
        AuthorizedDeleteOutcome::Indeterminate {
            attempted,
            recovery_message,
        } => reconcile_indeterminate_file_delete(
            state,
            attempted,
            recovery_message,
            filesystem,
            snapshot,
        ),
    }
}

#[cfg(test)]
pub(crate) fn delete_workspace_entry_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    delete_workspace_entry_with_ports_inner(
        state,
        workspace_token,
        path,
        &SystemFileSystemPort,
        snapshot,
    )
}

#[cfg(test)]
pub(crate) fn delete_workspace_entry_legacy_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    delete_workspace_entry_with_snapshot_inner(
        state,
        workspace_token,
        path,
        capture_workspace_snapshot,
    )
}

pub(crate) fn friendly_trash_disposition<R, E>(
    classification: TrashClassification<R, E>,
) -> TrashAuthorizationDisposition {
    match classification {
        TrashClassification::ConfirmedCommitted { .. } => {
            TrashAuthorizationDisposition::ConfirmedCommitted
        }
        TrashClassification::ConfirmedNotCommitted { .. } => {
            TrashAuthorizationDisposition::ConfirmedNotCommitted {
                message: "The entry could not be moved to Trash. Check Trash availability and filesystem permissions, then retry."
                    .to_string(),
            }
        }
        TrashClassification::Indeterminate { .. } => {
            TrashAuthorizationDisposition::Indeterminate {
                message: "The Trash operation could not be verified. Refresh the workspace and inspect both the entry and system Trash before retrying."
                    .to_string(),
            }
        }
    }
}

pub(crate) fn delete_workspace_entry_with_trash_port_inner<P: TrashPort>(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    trash_port: &mut P,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let requested_path = path.as_ref().to_path_buf();
    let trash_called = std::cell::Cell::new(false);
    let outcome =
        trash_authorized_workspace_entry_inner(state, workspace_token, path, |entry, is_file| {
            trash_called.set(true);
            let kind = if is_file {
                TrashEntryKind::File
            } else {
                TrashEntryKind::Directory
            };
            friendly_trash_disposition(classify_trash(trash_port, entry, kind))
        });
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(message) if !trash_called.get() => {
            return Ok(MutationOutcome::ConfirmedNotCommitted { message });
        }
        Err(_) => {
            return Ok(MutationOutcome::Indeterminate {
                operation: crate::models::MutationKind::Delete,
                paths: vec![requested_path.to_string_lossy().to_string()],
                recovery_message: "The entry may have moved to Trash, but application authorization could not be reconciled. Refresh the workspace before retrying."
                    .to_string(),
            });
        }
    };

    match outcome {
        AuthorizedDeleteOutcome::ConfirmedNotCommitted { message } => {
            Ok(MutationOutcome::ConfirmedNotCommitted { message })
        }
        AuthorizedDeleteOutcome::Committed(deleted) => {
            let committed = DeleteWorkspaceEntryResponse {
                deleted_path: deleted.deleted_path().to_string_lossy().to_string(),
            };
            Ok(committed_workspace_outcome(state, deleted.workspace(), committed, snapshot))
        }
        AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message,
        } => Ok(delete_recovery_required_outcome(deleted, recovery_message)),
        AuthorizedDeleteOutcome::Indeterminate {
            attempted,
            recovery_message,
        } => Ok(delete_recovery_required_outcome(attempted, recovery_message)),
    }
}

fn delete_recovery_required_outcome(
    deleted: DeletedWorkspaceEntry,
    recovery_message: String,
) -> MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot> {
    MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Delete,
        paths: vec![deleted.deleted_path().to_string_lossy().to_string()],
        recovery_message,
    }
}

pub(crate) fn delete_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    delete_workspace_entry_with_trash_port_inner(
        state,
        workspace_token,
        path,
        &mut NativeTrashPort::default(),
        capture_workspace_snapshot,
    )
}
