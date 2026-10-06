use std::path::Path;

use tauri::{AppHandle, State, WebviewWindow};

use crate::document_save::OverwriteToken;
use crate::models::{DocumentSaveResponse, OverwriteTokenResponse};
use crate::path_auth::normalize_file_for_write;
use crate::state::AppState;

use super::read::validate_editable_content;
use super::write::document_save_response;
use super::super::committed_document_version;

#[tauri::command]
pub(crate) fn issue_document_overwrite_token(
    path: String,
    content: String,
    operation_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<OverwriteTokenResponse, String> {
    issue_document_overwrite_token_inner(&state, path, &content, &operation_id, window.label())
}

pub(crate) fn issue_document_overwrite_token_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    operation_id: &str,
    owner: &str,
) -> Result<OverwriteTokenResponse, String> {
    let path = normalize_file_for_write(path)?;
    validate_editable_content(&path, content, "edited")?;
    let token = state.document_save().issue_overwrite_token(
        state.file_authorization(),
        &path,
        content.as_bytes(),
        operation_id,
        owner,
        None,
    )?;
    Ok(OverwriteTokenResponse {
        overwrite_token: token.as_str().to_string(),
    })
}

#[tauri::command]
pub(crate) fn retry_document_save_with_token(
    path: String,
    content: String,
    operation_id: String,
    overwrite_token: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<DocumentSaveResponse, String> {
    let write_token = normalize_file_for_write(&path).ok().and_then(|normalized| {
        state
            .active_document_watch()
            .begin_app_write(&normalized, content.as_bytes().to_vec())
    });
    let result = retry_document_save_with_token_inner(
        &state,
        &path,
        &content,
        &operation_id,
        &overwrite_token,
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

pub(crate) fn retry_document_save_with_token_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
    operation_id: &str,
    overwrite_token: &str,
    owner: &str,
) -> Result<DocumentSaveResponse, String> {
    let token = OverwriteToken::from_wire(overwrite_token)?;
    let (path, disposition) = state.document_save().retry_with_token_and_path(
        state.file_authorization(),
        &token,
        path.as_ref(),
        content.as_bytes(),
        operation_id,
        owner,
        |path| validate_editable_content(path, content, "edited"),
    )?;
    let response = document_save_response(&path, disposition);
    if matches!(response, DocumentSaveResponse::ConfirmedCommitted { .. }) {
        state.workspace_index().discard_all();
    }
    Ok(response)
}

#[tauri::command]
pub(crate) fn cancel_document_overwrite_token(
    path: String,
    overwrite_token: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    cancel_document_overwrite_token_inner(&state, path, &overwrite_token, window.label())
}

fn cancel_document_overwrite_token_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    overwrite_token: &str,
    owner: &str,
) -> Result<(), String> {
    let token = OverwriteToken::from_wire(overwrite_token)?;
    state
        .document_save()
        .cancel_overwrite_token(state.file_authorization(), &token, path, owner)
}

