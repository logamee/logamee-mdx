//! Test-only helpers for the ports-based delete flow: filesystem adapters,
//! call-error mapping and indeterminate reconciliation.

use std::path::Path;

use crate::models::{DeleteWorkspaceEntryResponse, MutationOutcome, WorkspaceSnapshot};
use crate::path_auth::{commit_indeterminate_delete_inner, WorkspaceSnapshotSource};
use crate::state::AppState;
use crate::workspace_snapshot::CapturedWorkspaceSnapshot;

use super::committed_workspace_outcome;
use super::super::{DeleteFileObservation, FileSystemPort, ObservedPath};

pub(super) fn filesystem_delete_adapters<'a>(
    filesystem: &'a impl FileSystemPort,
    filesystem_called: &'a std::cell::Cell<bool>,
) -> (
    impl FnOnce(&Path, bool) -> Result<(), String> + 'a,
    impl FnOnce(&Path) -> Result<DeleteFileObservation, String> + 'a,
) {
    (
        |entry: &Path, is_file: bool| {
            filesystem_called.set(true);
            if is_file {
                filesystem
                    .remove_file(entry)
                    .map_err(|err| format!("Failed to delete file: {err}"))
            } else {
                filesystem
                    .remove_dir_all(entry)
                    .map_err(|err| format!("Failed to delete directory: {err}"))
            }
        },
        |entry: &Path| {
            filesystem
                .observe(entry, None)
                .map(|observed| match observed {
                    ObservedPath::Missing => DeleteFileObservation::Missing,
                    ObservedPath::Present { .. } => DeleteFileObservation::Present,
                })
                .map_err(|error| format!("Failed to inspect delete outcome: {error}"))
        },
    )
}

pub(super) fn confirmed_or_indeterminate_call_error(
    message: String,
    filesystem_called: bool,
    requested_path: &Path,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    if !filesystem_called {
        return Ok(MutationOutcome::ConfirmedNotCommitted { message });
    }
    let path = requested_path.to_string_lossy().to_string();
    Ok(MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Delete,
        paths: vec![path],
        recovery_message: format!(
            "Delete may have partially changed the workspace after an error: {message}. Refresh and inspect the entry before retrying."
        ),
    })
}

pub(super) fn reconcile_indeterminate_file_delete(
    state: &AppState,
    attempted: crate::path_auth::DeletedWorkspaceEntry,
    mut recovery_message: String,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let deleted_path = attempted.deleted_path().to_path_buf();
    if !attempted.is_file() {
        match filesystem.observe(&deleted_path, None) {
            Ok(ObservedPath::Missing) => {
                if let Err(error) = commit_indeterminate_delete_inner(state, &deleted_path) {
                    recovery_message.push_str(&format!(
                        " Authorization reconciliation after observing a committed delete failed: {error}."
                    ));
                } else {
                    let committed = DeleteWorkspaceEntryResponse {
                        deleted_path: deleted_path.to_string_lossy().to_string(),
                    };
                    return Ok(committed_workspace_outcome(
                        state,
                        attempted.workspace(),
                        committed,
                        snapshot,
                    ));
                }
            }
            Ok(ObservedPath::Present { .. }) => {}
            Err(error) => recovery_message
                .push_str(&format!(" Delete outcome observation failed: {error}.")),
        }
    }
    Ok(MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Delete,
        paths: vec![deleted_path.to_string_lossy().to_string()],
        recovery_message,
    })
}
