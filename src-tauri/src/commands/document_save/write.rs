use std::{fs, io, path::Path};
use crate::private_fs::lowercase_hex;

use sha2::{Digest, Sha256};

use tauri::{AppHandle, State, WebviewWindow};

use crate::document_save::{DocumentSaveDisposition, MAIN_SAVE_OWNER};
use crate::durable_write::FileVersion;
use crate::models::DocumentSaveResponse;
use crate::path_auth::normalize_file_for_write;
use crate::state::AppState;

use super::read::{validate_editable_content};
#[cfg(test)]
use super::super::{
    AuthorizedWriteOutcome, FileSystemPort, ObservedContentEvidence, ObservedPath,
    ObservedPathKind, SystemFileSystemPort,
};
#[cfg(test)]
use crate::models::{
    MutationCommitReceipt, MutationOutcome, SnapshotReceipt, WorkspaceMutation, WorkspaceSnapshot,
};
#[cfg(test)]
use crate::path_auth::write_authorized_document_inner;
use super::super::committed_document_version;

pub(crate) fn document_save_response(
    path: &Path,
    disposition: DocumentSaveDisposition,
) -> DocumentSaveResponse {
    document_save_response_with_cleanup(path, disposition, |displaced| fs::remove_file(displaced))
}

pub(crate) fn document_save_response_with_cleanup(
    path: &Path,
    disposition: DocumentSaveDisposition,
    cleanup: impl FnOnce(&Path) -> io::Result<()>,
) -> DocumentSaveResponse {
    let path = path.to_string_lossy().to_string();
    match disposition {
        DocumentSaveDisposition::ConfirmedCommitted {
            version,
            displaced_path,
        } => {
            let cleanup_repair_receipt =
                displaced_path.and_then(|displaced_path| match cleanup(&displaced_path) {
                    Ok(()) => None,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(_) => Some(format!(
                        "cleanup-{}",
                        lowercase_hex(&Sha256::digest(
                            displaced_path.to_string_lossy().as_bytes()
                        ))
                    )),
                });
            DocumentSaveResponse::ConfirmedCommitted {
                path,
                version,
                cleanup_repair_receipt,
            }
        }
        DocumentSaveDisposition::ConfirmedNotCommitted {
            current_version,
            message,
            ..
        } => DocumentSaveResponse::ConfirmedNotCommitted {
            path,
            current_version,
            message,
        },
        DocumentSaveDisposition::Conflict {
            current_version,
            overwrite_token,
            ..
        } => DocumentSaveResponse::Conflict {
            path,
            current_version,
            overwrite_token: overwrite_token.map(|token| token.as_str().to_string()),
            message: "The file changed on disk. Review the newer version before overwriting."
                .to_string(),
        },
        DocumentSaveDisposition::Indeterminate { message, .. } => {
            DocumentSaveResponse::Indeterminate { path, message }
        }
    }
}


pub(crate) fn save_expected_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    expected_version: FileVersion,
    operation_id: &str,
    owner: &str,
) -> Result<DocumentSaveResponse, String> {
    if owner != MAIN_SAVE_OWNER {
        return Err("Document saves are owned by the main window".to_string());
    }
    let path = normalize_file_for_write(path)?;
    validate_editable_content(&path, content, "edited")?;
    let disposition = state.document_save().save_expected(
        state.file_authorization(),
        &path,
        content.as_bytes(),
        expected_version,
        operation_id,
        owner,
    )?;
    let response = document_save_response(&path, disposition);
    if matches!(response, DocumentSaveResponse::ConfirmedCommitted { .. }) {
        // Document saves do not carry a workspace scope. Discarding the active
        // index avoids retaining stale full-text content after a confirmed write.
        state.workspace_index().discard_all();
    }
    Ok(response)
}

#[cfg(test)]
pub(crate) fn write_with_observation(
    path: &Path,
    content: &str,
    filesystem: &impl FileSystemPort,
) -> Result<(), String> {
    match filesystem.write(path, content.as_bytes()) {
        Ok(()) => Ok(()),
        Err(write_error) => {
            let confirmed_commit = matches!(
                filesystem.observe(path, Some(content.as_bytes())),
                Ok(ObservedPath::Present {
                    canonical_path: Some(observed_path),
                    kind: ObservedPathKind::File,
                    content: ObservedContentEvidence::Compared {
                        matches_expected: true,
                        bytes_read,
                    },
                }) if observed_path == path && bytes_read == content.len()
            );
            if confirmed_commit {
                return Ok(());
            }
            Err(format!(
                "Write may have partially changed the file after an error: Failed to write file: {write_error}. Reopen and inspect it before retrying."
            ))
        }
    }
}

#[cfg(test)]
pub(crate) fn write_file_with_preflight_and_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    let outcome = match write_authorized_document_inner(state, path, preflight, |path| {
        write_with_observation(path, content, filesystem)
    }) {
        Ok(outcome) => outcome,
        Err(message) => return Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    };

    Ok(match outcome {
        AuthorizedWriteOutcome::Committed(path) => MutationOutcome::ConfirmedCommitted {
            receipt: MutationCommitReceipt {
                committed: WorkspaceMutation {
                    path: path.to_string_lossy().to_string(),
                },
                workspace: SnapshotReceipt::NotApplicable,
            },
        },
        AuthorizedWriteOutcome::Indeterminate {
            path,
            recovery_message,
        } => MutationOutcome::Indeterminate {
            operation: crate::models::MutationKind::Write,
            paths: vec![path.to_string_lossy().to_string()],
            recovery_message,
        },
    })
}

#[cfg(test)]
pub(crate) fn write_file_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    write_file_with_preflight_and_ports_inner(
        state,
        path,
        content,
        |path| validate_editable_content(path, content, "edited"),
        filesystem,
    )
}

#[cfg(test)]
pub(crate) fn write_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    write_file_with_ports_inner(state, path, content, &SystemFileSystemPort)
}

#[tauri::command]
pub(crate) fn write_file(
    path: String,
    content: String,
    expected_version: FileVersion,
    operation_id: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<DocumentSaveResponse, String> {
    let write_token = normalize_file_for_write(&path).ok().and_then(|normalized| {
        state
            .active_document_watch()
            .begin_app_write(&normalized, content.as_bytes().to_vec())
    });
    let result = save_expected_inner(
        &state,
        path,
        &content,
        expected_version,
        &operation_id,
        window.label(),
    );
    if let Some(write_token) = write_token {
        state.active_document_watch().settle_app_write_and_schedule(
            &app,
            write_token,
            committed_document_version(&result),
        );
    }
    result
}

