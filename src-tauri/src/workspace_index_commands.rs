use serde::Serialize;
use tauri::{State, WebviewWindow};

use crate::state::AppState;
use crate::workspace_index::{BuildReport, SkipCounts};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceIndexStatus {
    Ready,
    Cancelled,
    Invalidated,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceIndexScanReport {
    scanned_files: usize,
    collected_files: usize,
    collected_bytes: usize,
    read_errors: usize,
    skipped: SkipCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceIndexRebuildResponse {
    status: WorkspaceIndexStatus,
    workspace_token: String,
    index_generation: u64,
    implementation_id: String,
    schema_id: String,
    report: BuildReport,
    scan_report: WorkspaceIndexScanReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceIndexQueryResponse {
    status: WorkspaceIndexStatus,
    workspace_token: String,
    index_generation: u64,
    implementation_id: String,
    schema_id: String,
    truncated: bool,
    results: Vec<crate::workspace_index::QueryResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceIndexDiscardResponse {
    discarded: bool,
    index_generation: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceIndexCancelResponse {
    cancelled: bool,
}


struct OperationGuard<'a> {
    state: &'a AppState,
    operation_id: &'a str,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.state
            .workspace_index()
            .end_operation(self.operation_id);
    }
}


mod collection;

pub(crate) use collection::*;

mod operations;

pub(crate) use operations::{discard_workspace_index_inner, open_workspace_index_result_inner};
#[cfg(test)]
pub(crate) use operations::{rebuild_workspace_index_inner, query_workspace_index_inner};
pub(crate) use operations::{rebuild_workspace_index, query_workspace_index};

#[tauri::command]
pub(crate) fn discard_workspace_index(
    workspace_token: String,
    workspace_root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<WorkspaceIndexDiscardResponse, String> {
    if window.label() != "main" {
        return Err("Only the main window can discard the workspace index".to_string());
    }
    discard_workspace_index_inner(&state, &workspace_token, &workspace_root)
}

#[tauri::command]
pub(crate) fn cancel_workspace_index_operation(
    operation_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<WorkspaceIndexCancelResponse, String> {
    if window.label() != "main" {
        return Err("Only the main window can cancel workspace index operations".to_string());
    }
    let cancelled = state.workspace_index().cancel_operation(&operation_id)?;
    Ok(WorkspaceIndexCancelResponse { cancelled })
}

#[tauri::command]
pub(crate) fn open_workspace_index_result(
    workspace_token: String,
    workspace_root: String,
    index_generation: u64,
    relative_path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<crate::models::PreparedOpenFileResponse, String> {
    open_workspace_index_result_inner(
        &state,
        window.label(),
        &workspace_token,
        &workspace_root,
        index_generation,
        &relative_path,
    )
}


#[cfg(test)]
mod bounds_tests;
#[cfg(test)]
mod tests;
