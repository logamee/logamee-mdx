use std::path::Path;

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::document_save::{DocumentSaveDisposition, MAIN_SAVE_OWNER};
use crate::models::DocumentSaveResponse;
use crate::path_auth::{normalize_file_for_write, PendingSaveAuthority};
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

use super::read::validate_editable_content;
use super::write::document_save_response;
use super::super::committed_document_version;
#[cfg(test)]
use super::super::{
    AuthorizedWriteOutcome, FileSystemPort, SystemFileSystemPort,
};
#[cfg(test)]
use crate::models::{
    MutationCommitReceipt, MutationOutcome, SnapshotReceipt, WorkspaceMutation,
    WorkspaceSnapshot,
};
#[cfg(test)]
use crate::path_auth::save_document_as_inner;
#[cfg(test)]
use super::write::write_with_observation;

#[cfg(test)]
pub(crate) fn save_as_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: String,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    save_as_with_ports_inner(state, path, &content, &SystemFileSystemPort)
}

#[cfg(test)]
pub(crate) fn save_as_for_kind_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: String,
    file_kind: Option<WorkspaceFileKind>,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    save_as_with_kind_and_ports_inner(state, path, &content, file_kind, &SystemFileSystemPort)
}

#[cfg(test)]
pub(crate) fn save_as_with_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    save_as_with_kind_and_ports_inner(state, path, content, None, filesystem)
}

#[cfg(test)]
fn save_as_with_kind_and_ports_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    file_kind: Option<WorkspaceFileKind>,
    filesystem: &impl FileSystemPort,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    let outcome = match save_document_as_inner(
        state,
        path,
        |path| validate_save_as_content(path, content, file_kind),
        |path| write_with_observation(path, content, filesystem),
    ) {
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

fn validate_save_as_content(
    path: &Path,
    content: &str,
    file_kind: Option<WorkspaceFileKind>,
) -> Result<(), String> {
    if file_kind == Some(WorkspaceFileKind::Excalidraw)
        && WorkspaceFileKind::classify(path) != Some(WorkspaceFileKind::Excalidraw)
    {
        return Err("Excalidraw scenes must be saved with the .excalidraw extension".to_string());
    }
    validate_editable_content(path, content, "saved")
}

pub(crate) fn save_as_coordinated_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    file_kind: Option<WorkspaceFileKind>,
    operation_id: &str,
    owner: &str,
) -> Result<DocumentSaveResponse, String> {
    if owner != MAIN_SAVE_OWNER {
        return Err("Document saves are owned by the main window".to_string());
    }
    let path = normalize_file_for_write(path)?;
    validate_save_as_content(&path, content, file_kind)?;
    let destination_existed_when_accepted = path.is_file();
    let pending = state
        .file_authorization()
        .reserve_pending_save_authority(&path)?;

    let disposition = match coordinated_save_disposition(
        state,
        &path,
        content,
        operation_id,
        owner,
        &pending,
        destination_existed_when_accepted,
    ) {
        Ok(disposition) => disposition,
        Err(error) => {
            let _ = state
                .file_authorization()
                .cancel_pending_save_authority(&pending);
            return Err(error);
        }
    };
    if !matches!(
        disposition,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
            | DocumentSaveDisposition::Conflict {
                overwrite_token: Some(_),
                ..
            }
    ) {
        state
            .file_authorization()
            .cancel_pending_save_authority(&pending)?;
    }
    let response = document_save_response(&path, disposition);
    if matches!(response, DocumentSaveResponse::ConfirmedCommitted { .. }) {
        state.workspace_index().discard_all();
    }
    Ok(response)
}

fn coordinated_save_disposition(
    state: &AppState,
    path: &Path,
    content: &str,
    operation_id: &str,
    owner: &str,
    pending: &PendingSaveAuthority,
    destination_existed_when_accepted: bool,
) -> Result<DocumentSaveDisposition, String> {
    if destination_existed_when_accepted {
        let token = match state
            .document_save()
            .issue_overwrite_token(
                state.file_authorization(),
                path,
                content.as_bytes(),
                operation_id,
                owner,
                Some(pending),
            ) {
            Ok(token) => token,
            Err(error) => return Err(error),
        };
        state.document_save().retry_with_token(
            state.file_authorization(),
            &token,
            path,
            content.as_bytes(),
            operation_id,
            owner,
            |_| Ok(()),
        )
    } else {
        state.document_save().save_as_expected(
            state.file_authorization(),
            pending,
            path,
            content.as_bytes(),
            operation_id,
            owner,
        )
    }
}


#[tauri::command]
pub(crate) async fn save_as_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
    content: String,
    default_name: Option<String>,
    file_kind: Option<WorkspaceFileKind>,
    operation_id: String,
    window: WebviewWindow,
) -> Result<Option<DocumentSaveResponse>, String> {
    let (filter_name, extensions) = if file_kind == Some(WorkspaceFileKind::Excalidraw) {
        ("Excalidraw", vec!["excalidraw"])
    } else {
        (
            "Markdown, HTML, and Excalidraw",
            WorkspaceFileKind::editable_extensions(),
        )
    };
    let mut dialog = app.dialog().file().add_filter(filter_name, &extensions);
    if let Some(default_name) = default_name.filter(|name| !name.trim().is_empty()) {
        dialog = dialog.set_file_name(default_name);
    }
    let Some(selected) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|err| format!("Invalid save path: {err}"))?;
    let write_token = normalize_file_for_write(&path).ok().and_then(|normalized| {
        state
            .active_document_watch()
            .begin_app_write(&normalized, content.as_bytes().to_vec())
    });
    let result = save_as_coordinated_inner(
        &state,
        path,
        &content,
        file_kind,
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
    result.map(Some)
}
