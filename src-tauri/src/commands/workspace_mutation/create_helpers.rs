//! Shared helpers for workspace file and directory creation outcomes: the
//! create adapter, observation-based indeterminate mapping and committed
//! response fallbacks.

use std::path::{Path, PathBuf};

use crate::models::{MutationOutcome, OpenFileResponse, WorkspaceMutation, WorkspaceSnapshot};

use super::super::FileSystemPort;

pub(super) fn create_file_adapter<'a>(
    filesystem: &'a impl FileSystemPort,
    initial_content: &'a str,
    attempted_target: &'a mut Option<PathBuf>,
    create_new_already_exists: &'a mut bool,
) -> impl FnOnce(&Path) -> Result<(), String> + 'a {
    move |target: &Path| {
        *attempted_target = Some(target.to_path_buf());
        let result = if initial_content.is_empty() {
            filesystem.create_new(target)
        } else {
            filesystem.create_new_with_contents(target, initial_content.as_bytes())
        };
        result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                *create_new_already_exists = true;
                "Workspace entry already exists".to_string()
            } else {
                format!("Failed to create file: {error}")
            }
        })
    }
}

pub(super) fn unobserved_create_file_outcome(
    message: String,
    target: Option<PathBuf>,
    initial_content: &str,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    let Some(target) = target else {
        return Err(message);
    };
    let observation_note = match filesystem.observe(&target, Some(initial_content.as_bytes())) {
        Ok(_) => String::new(),
        Err(error) => format!(" Outcome observation failed: {error}."),
    };
    Ok(MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Create,
        paths: vec![target.to_string_lossy().to_string()],
        recovery_message: format!(
            "File creation may have committed before an error: {message}. Refresh and inspect the workspace before retrying.{observation_note}"
        ),
    })
}

pub(super) fn unobservable_committed_file_outcome(
    committed_path: &Path,
    error: String,
) -> MutationOutcome<OpenFileResponse, WorkspaceSnapshot> {
    MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Create,
        paths: vec![committed_path.to_string_lossy().to_string()],
        recovery_message: format!(
            "The file was created, but its committed bytes could not be observed: {error}. Refresh the workspace before editing it."
        ),
    }
}

pub(super) fn unobserved_create_directory_outcome(
    message: String,
    target: Option<PathBuf>,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    let Some(target) = target else {
        return Ok(MutationOutcome::ConfirmedNotCommitted { message });
    };
    let observation_note = match filesystem.observe(&target, None) {
        Ok(_) => String::new(),
        Err(error) => format!(" Outcome observation failed: {error}."),
    };
    Ok(MutationOutcome::Indeterminate {
        operation: crate::models::MutationKind::Create,
        paths: vec![target.to_string_lossy().to_string()],
        recovery_message: format!(
            "Directory creation may have committed before an error: {message}. Refresh and inspect the workspace before retrying.{observation_note}"
        ),
    })
}
