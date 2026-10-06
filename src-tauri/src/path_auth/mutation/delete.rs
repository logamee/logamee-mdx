//! Deletion and trash authorization with preview-lease reconciliation.
use std::path::Path;

#[cfg(test)]
use std::collections::HashSet;

#[cfg(test)]
use super::super::PreviewLeaseId;
#[cfg(test)]
use super::super::DeleteFileObservation;
use super::{invalidate_preview_leases_after_authorization, AuthorizedDeleteOutcome, DeleteWorkspaceEntryAuthorizationOutcome, TrashAuthorizationDisposition};
use crate::state::AppState;

#[cfg(test)]
fn delete_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    delete: impl FnOnce(&Path, bool) -> Result<(), String>,
    observe_file_after_error: impl FnOnce(&Path) -> Result<DeleteFileObservation, String>,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedDeleteOutcome, String> {
    let outcome = state.file_authorization().delete_workspace_entry(
        workspace_token,
        source_path,
        delete,
        observe_file_after_error,
    )?;
    let (deleted, invalidated_preview_leases) = match outcome {
        DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            return Ok(AuthorizedDeleteOutcome::ConfirmedNotCommitted { message });
        }
        DeleteWorkspaceEntryAuthorizationOutcome::Committed {
            deleted,
            invalidated_preview_leases,
        } => (deleted, invalidated_preview_leases),
        DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
        } => {
            let (subject, location) = if attempted.is_file() {
                ("File", "file")
            } else {
                ("Directory", "directory")
            };
            let mut recovery_message = format!(
                "{subject} deletion may have partially changed the workspace after an error: {operation_error}. Refresh and inspect the {location} before retrying."
            );
            if let Err(cleanup_error) = invalidate_preview(&invalidated_preview_leases) {
                recovery_message.push_str(" Preview invalidation also failed: ");
                recovery_message.push_str(&cleanup_error);
            }
            return Ok(AuthorizedDeleteOutcome::Indeterminate {
                attempted,
                recovery_message,
            });
        }
    };
    match invalidate_preview(&invalidated_preview_leases) {
        Ok(()) => Ok(AuthorizedDeleteOutcome::Committed(deleted)),
        Err(recovery_message) => Ok(AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message,
        }),
    }
}

#[cfg(test)]
pub(crate) fn delete_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    delete: impl FnOnce(&Path, bool) -> Result<(), String>,
    observe_file_after_error: impl FnOnce(&Path) -> Result<DeleteFileObservation, String>,
) -> Result<AuthorizedDeleteOutcome, String> {
    delete_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        delete,
        observe_file_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn trash_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    trash: impl FnOnce(&Path, bool) -> TrashAuthorizationDisposition,
) -> Result<AuthorizedDeleteOutcome, String> {
    let outcome =
        state
            .file_authorization()
            .trash_workspace_entry(workspace_token, source_path, trash)?;
    let (deleted, invalidated_preview_leases) = match outcome {
        DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            return Ok(AuthorizedDeleteOutcome::ConfirmedNotCommitted { message });
        }
        DeleteWorkspaceEntryAuthorizationOutcome::Committed {
            deleted,
            invalidated_preview_leases,
        } => (deleted, invalidated_preview_leases),
        DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
        } => {
            let mut recovery_message = operation_error;
            if invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
                .is_err()
            {
                recovery_message.push_str(
                    " Active previews also could not be retired; close preview windows before retrying.",
                );
            }
            return Ok(AuthorizedDeleteOutcome::Indeterminate {
                attempted,
                recovery_message,
            });
        }
    };
    match invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases) {
        Ok(()) => Ok(AuthorizedDeleteOutcome::Committed(deleted)),
        Err(_) => Ok(AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message:
                "The entry was moved to Trash, but active previews could not be retired. Close preview windows and refresh the workspace."
                    .to_string(),
        }),
    }
}
