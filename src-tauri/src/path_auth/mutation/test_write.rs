//! Test-only write/save paths exercising the authorization state machine.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use super::super::{AuthorizedWriteOutcome, PreviewLeaseId};
use super::invalidate_preview_leases_after_authorization;
use crate::state::AppState;

#[cfg(test)]
fn reconcile_indeterminate_write_with_preview_inner(
    state: &AppState,
    path: PathBuf,
    mut recovery_message: String,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> AuthorizedWriteOutcome {
    match state.file_authorization().suspend_write_file(&path) {
        Ok(invalidated_preview_leases) => {
            if let Err(cleanup_error) = invalidate_preview(&invalidated_preview_leases) {
                recovery_message.push_str(" Preview invalidation also failed: ");
                recovery_message.push_str(&cleanup_error);
            }
        }
        Err(authorization_error) => {
            let preview_shutdown = state.html_preview_server.stop_all_sites();
            recovery_message.push_str(" Authorization suspension also failed: ");
            recovery_message.push_str(&authorization_error);
            recovery_message.push_str(". All HTML preview sites were stopped.");
            if let Err(shutdown_error) = preview_shutdown {
                recovery_message.push_str(" Preview shutdown reported: ");
                recovery_message.push_str(&shutdown_error);
            }
        }
    }
    AuthorizedWriteOutcome::Indeterminate {
        path,
        recovery_message,
    }
}

#[cfg(test)]
fn write_authorized_document_with_preview_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    let path = state.file_authorization().write_document(path, preflight)?;
    match write(&path) {
        Ok(()) => Ok(AuthorizedWriteOutcome::Committed(path)),
        Err(recovery_message) => Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            recovery_message,
            invalidate_preview,
        )),
    }
}

#[cfg(test)]
pub(crate) fn write_authorized_document_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    write_authorized_document_with_preview_inner(
        state,
        path,
        preflight,
        write,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

#[cfg(test)]
pub(crate) fn save_document_as_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    let path = state
        .file_authorization()
        .prepare_save_destination(path, preflight)?;
    if let Err(recovery_message) = write(&path) {
        return Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            recovery_message,
            |invalidated_preview_leases| {
                invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
            },
        ));
    }

    match state
        .file_authorization()
        .publish_save_destination(path.clone())
    {
        Ok(authorized) => Ok(AuthorizedWriteOutcome::Committed(authorized.into_path())),
        Err(error) => Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            format!(
                "File contents were written, but save-as authorization could not be committed: {error}. Reopen and inspect the file before retrying."
            ),
            |invalidated_preview_leases| {
                invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
            },
        )),
    }
}
