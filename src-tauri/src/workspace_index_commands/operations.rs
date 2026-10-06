use std::fs;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::{
    commands::prepare_workspace_file_inner,
    path_auth::{
        resolve_authorized_workspace_result_file_inner,
        resolve_authorized_workspace_root_for_token_inner, AuthorizedWorkspace,
    },
    state::AppState,
    workspace_index::{query_index, BuildOutcome, IndexLimits, IndexQuery},
    workspace_index_runtime::WorkspaceIndexLease,
};

use super::{
    WorkspaceIndexRebuildResponse, WorkspaceIndexQueryResponse, 
    WorkspaceIndexDiscardResponse, WorkspaceIndexStatus, collect_documents, scan_report,
    OperationGuard, build_collected_documents, merge_collection_report, rebuild_response,
};

pub(crate) fn rebuild_workspace_index_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    operation_id: &str,
) -> Result<WorkspaceIndexRebuildResponse, String> {
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(state, workspace_token, workspace_root)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Failed to canonicalize workspace root: {error}"))?;
    let lease =
        state
            .workspace_index()
            .begin_rebuild(workspace_token, &canonical_root, operation_id)?;
    let _guard = OperationGuard {
        state,
        operation_id,
    };
    rebuild_authorized_workspace_index(state, &workspace, &lease)
}

pub(crate) fn rebuild_authorized_workspace_index(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    lease: &WorkspaceIndexLease,
) -> Result<WorkspaceIndexRebuildResponse, String> {
    let limits = IndexLimits::default();
    let collected = collect_documents(state, workspace, &lease.cancellation, limits)?;
    // A bounded traversal can still finish after its operation deadline. Mark the
    // shared token before building so the completed data is never published.
    if lease.is_cancelled() {
        lease.cancellation.cancel();
    }
    let scan = scan_report(&collected);
    let outcome = if collected.cancelled {
        build_collected_documents(Vec::new(), limits, &lease.cancellation)
    } else {
        build_collected_documents(collected.documents, limits, &lease.cancellation)
    };
    match outcome {
        BuildOutcome::Cancelled { mut report } => {
            merge_collection_report(&mut report, collected.input_files, &collected.skipped);
            Ok(rebuild_response(
                WorkspaceIndexStatus::Cancelled,
                lease,
                report,
                scan,
            ))
        }
        BuildOutcome::Completed { index, mut report } => {
            merge_collection_report(&mut report, collected.input_files, &collected.skipped);
            state
                .file_authorization()
                .ensure_workspace_is_current(workspace)?;
            let status = if state.workspace_index().publish_rebuild(lease, index)? {
                WorkspaceIndexStatus::Ready
            } else {
                WorkspaceIndexStatus::Invalidated
            };
            Ok(rebuild_response(status, lease, report, scan))
        }
    }
}

pub(crate) fn query_workspace_index_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    operation_id: &str,
    query: IndexQuery,
) -> Result<WorkspaceIndexQueryResponse, String> {
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(state, workspace_token, workspace_root)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Failed to canonicalize workspace root: {error}"))?;
    let query_lease =
        state
            .workspace_index()
            .begin_query(workspace_token, &canonical_root, operation_id)?;
    let _guard = OperationGuard {
        state,
        operation_id,
    };
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    let response = query_index(&query_lease.index, query, &query_lease.lease.cancellation);
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    let status = if response.status == crate::workspace_index::OperationStatus::Cancelled
        || query_lease.lease.is_cancelled()
    {
        WorkspaceIndexStatus::Cancelled
    } else if !state.workspace_index().is_current(&query_lease.lease)? {
        WorkspaceIndexStatus::Invalidated
    } else {
        WorkspaceIndexStatus::Ready
    };
    Ok(WorkspaceIndexQueryResponse {
        status,
        workspace_token: query_lease.lease.workspace_token,
        index_generation: query_lease.lease.generation,
        implementation_id: response.implementation_id,
        schema_id: response.schema_id,
        truncated: response.truncated,
        results: if status == WorkspaceIndexStatus::Ready {
            response.results
        } else {
            Vec::new()
        },
    })
}


pub(crate) fn discard_workspace_index_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
) -> Result<WorkspaceIndexDiscardResponse, String> {
    resolve_authorized_workspace_root_for_token_inner(state, workspace_token, workspace_root)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Failed to canonicalize workspace root: {error}"))?;
    let discarded = state
        .workspace_index()
        .discard(workspace_token, &canonical_root)?;
    let index_generation = state
        .workspace_index()
        .current_generation(workspace_token, &canonical_root)?;
    Ok(WorkspaceIndexDiscardResponse {
        discarded,
        index_generation,
    })
}

pub(crate) fn open_workspace_index_result_inner(
    state: &AppState,
    owner_window: &str,
    workspace_token: &str,
    workspace_root: &str,
    index_generation: u64,
    relative_path: &str,
) -> Result<crate::models::PreparedOpenFileResponse, String> {
    if owner_window != "main" {
        return Err("Only the main window can open workspace search results".to_string());
    }
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Failed to canonicalize workspace root: {error}"))?;
    if !state.workspace_index().is_result_current(
        workspace_token,
        &canonical_root,
        index_generation,
    )? {
        return Err("Workspace search result is stale; refresh the search first".to_string());
    }
    let (workspace, path) = resolve_authorized_workspace_result_file_inner(
        state,
        workspace_token,
        workspace_root,
        relative_path,
    )?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    let prepared = prepare_workspace_file_inner(state, owner_window, &path)?;
    if state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)
        .is_err()
        || !state.workspace_index().is_result_current(
            workspace_token,
            &canonical_root,
            index_generation,
        )?
    {
        let _ = state
            .recent_files()?
            .discard(owner_window, &prepared.open_receipt);
        return Err("Workspace search result changed while opening".to_string());
    }
    Ok(prepared)
}

#[tauri::command]
pub(crate) async fn rebuild_workspace_index(
    workspace_token: String,
    workspace_root: String,
    operation_id: String,
    window: WebviewWindow,
    app: AppHandle,
) -> Result<WorkspaceIndexRebuildResponse, String> {
    if window.label() != "main" {
        return Err("Only the main window can rebuild the workspace index".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        rebuild_workspace_index_inner(&state, &workspace_token, &workspace_root, &operation_id)
    })
    .await
    .map_err(|error| format!("Workspace index rebuild task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn query_workspace_index(
    workspace_token: String,
    workspace_root: String,
    operation_id: String,
    query: IndexQuery,
    window: WebviewWindow,
    app: AppHandle,
) -> Result<WorkspaceIndexQueryResponse, String> {
    if window.label() != "main" {
        return Err("Only the main window can query the workspace index".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        query_workspace_index_inner(
            &state,
            &workspace_token,
            &workspace_root,
            &operation_id,
            query,
        )
    })
    .await
    .map_err(|error| format!("Workspace index query task failed: {error}"))?
}
