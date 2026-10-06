use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use super::fs_paths::normalize_existing_path;
use super::{
    retire_preview_leases_inner, PreviewLeaseId, PreviewRetirementError, AuthorizedDeleteOutcome,
    AuthorizedRenameOutcome, CopyWorkspaceEntryOutcome,
    DeleteWorkspaceEntryAuthorizationOutcome, RenameErrorObservation,
    RenameWorkspaceEntryAuthorizationOutcome, RenamedWorkspaceEntry, TrashAuthorizationDisposition,
};
use crate::state::AppState;

pub(crate) fn invalidate_preview_leases_after_authorization(
    state: &AppState,
    invalidated_preview_leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    match state
        .html_preview_server
        .invalidate_preview_leases(invalidated_preview_leases)
    {
        Ok(()) => Ok(()),
        Err(recovery) => {
            let (error, drained_leases) = recovery.into_parts();
            retire_preview_leases_inner(state, &drained_leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}


mod delete;

pub(crate) use delete::trash_authorized_workspace_entry_inner;
#[cfg(test)]
pub(crate) use delete::delete_authorized_workspace_entry_inner;
#[cfg(test)]
mod test_write;

#[cfg(test)]
pub(crate) use test_write::{save_document_as_inner, write_authorized_document_inner};

fn reconcile_awaiting_rename_observation(
    state: &AppState,
    outcome: RenameWorkspaceEntryAuthorizationOutcome,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
) -> Result<RenameWorkspaceEntryAuthorizationOutcome, String> {
    Ok(match outcome {
        RenameWorkspaceEntryAuthorizationOutcome::AwaitingObservation {
            attempted,
            transitioned_grants,
            operation_error,
        } => {
            let observation = observe_after_error(&attempted);
            state.file_authorization().reconcile_rename_after_error(
                attempted,
                transitioned_grants,
                operation_error,
                observation,
            )?
        }
        outcome => outcome,
    })
}

fn indeterminate_rename_recovery_message(
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
    invalidated_preview_leases: &HashSet<PreviewLeaseId>,
    operation_error: &str,
    observation_message: &str,
) -> String {
    let mut recovery_message = format!(
        "Rename may have partially changed the workspace after an error: {operation_error}. Refresh and inspect both paths before retrying."
    );
    recovery_message.push_str(observation_message);
    if let Err(cleanup_error) = invalidate_preview(invalidated_preview_leases) {
        recovery_message.push_str(" Preview invalidation also failed: ");
        recovery_message.push_str(&cleanup_error);
    }
    recovery_message
}

fn finish_authorized_workspace_entry_relocation(
    state: &AppState,
    outcome: RenameWorkspaceEntryAuthorizationOutcome,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = reconcile_awaiting_rename_observation(
        state,
        outcome,
        observe_after_error,
    )?;
    match outcome {
        RenameWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            Ok(AuthorizedRenameOutcome::ConfirmedNotCommitted { message })
        }
        RenameWorkspaceEntryAuthorizationOutcome::Committed {
            renamed,
            invalidated_preview_leases,
        } => match invalidate_preview(&invalidated_preview_leases) {
            Ok(()) => Ok(AuthorizedRenameOutcome::Committed(renamed)),
            Err(recovery_message) => Ok(AuthorizedRenameOutcome::RecoveryRequired {
                renamed,
                recovery_message,
            }),
        },
        RenameWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
            observation_message,
        } => Ok(AuthorizedRenameOutcome::Indeterminate {
            attempted,
            recovery_message: indeterminate_rename_recovery_message(
                invalidate_preview,
                &invalidated_preview_leases,
                &operation_error,
                &observation_message,
            ),
        }),
        RenameWorkspaceEntryAuthorizationOutcome::AwaitingObservation { .. } => {
            unreachable!("rename observation must be reconciled before preview handling")
        }
    }
}

pub(crate) fn rename_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    new_name: impl FnOnce(&Path, bool) -> Result<String, String>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = state.file_authorization().rename_workspace_entry(
        workspace_token,
        source_path,
        new_name,
        rename,
    )?;
    finish_authorized_workspace_entry_relocation(
        state,
        outcome,
        observe_after_error,
        invalidate_preview,
    )
}

fn move_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = state.file_authorization().move_workspace_entry(
        workspace_token,
        source_path,
        destination_parent_path,
        rename,
    )?;
    finish_authorized_workspace_entry_relocation(
        state,
        outcome,
        observe_after_error,
        invalidate_preview,
    )
}

pub(crate) fn rename_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    new_name: impl FnOnce(&Path, bool) -> Result<String, String>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
) -> Result<AuthorizedRenameOutcome, String> {
    rename_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        new_name,
        rename,
        observe_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn move_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
) -> Result<AuthorizedRenameOutcome, String> {
    move_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        destination_parent_path,
        rename,
        observe_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn copy_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    copy: impl FnOnce(&Path, &Path, bool) -> Result<(), crate::workspace_copy::CopyEntryError>,
) -> Result<CopyWorkspaceEntryOutcome, String> {
    state
        .file_authorization()
        .copy_workspace_entry(workspace_token, source_path, destination_parent_path, copy)
}

/// Reveals an entry in the system file manager. The entry must already be
/// visible to the session: either a file with a current exact grant or any
/// file/directory covered by a current workspace directory grant.
pub(crate) fn reveal_authorized_workspace_entry_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    reveal: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let canonical = normalize_existing_path(path)?;
    let file_authorization = state.file_authorization();
    let authorized = match file_authorization.file_for_read(&canonical) {
        Ok(path) => path,
        Err(file_error) => match file_authorization.directory_for_read(&canonical) {
            Ok(path) => path,
            Err(_) => return Err(file_error),
        },
    };
    reveal(&authorized)?;
    Ok(authorized)
}
