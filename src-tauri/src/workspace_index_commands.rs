use std::{
    fs::{self, File},
    io::{Read, Take},
    path::PathBuf,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::{
    commands::prepare_workspace_file_inner,
    models::MarkdownFileEntry,
    path_auth::{
        resolve_authorized_workspace_result_file_inner,
        resolve_authorized_workspace_root_for_token_inner, AuthorizedWorkspace,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
    workspace_index::{
        build_index, query_index, BuildOutcome, BuildReport, CancellationToken, IndexDocument,
        IndexLimits, IndexQuery, SkipCounts,
    },
    workspace_index_runtime::WorkspaceIndexLease,
    workspace_snapshot::{capture_workspace_index_snapshot, WorkspaceIndexSnapshotCapture},
};

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

struct CollectedDocuments {
    documents: Vec<IndexDocument>,
    input_files: usize,
    collected_bytes: usize,
    read_errors: usize,
    skipped: SkipCounts,
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

fn collect_documents(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    cancellation: &CancellationToken,
    limits: IndexLimits,
) -> Result<CollectedDocuments, String> {
    let files = match capture_workspace_index_snapshot(workspace, cancellation)? {
        WorkspaceIndexSnapshotCapture::Completed(snapshot) => {
            snapshot.into_index_files(workspace)?
        }
        WorkspaceIndexSnapshotCapture::Cancelled => {
            return Ok(CollectedDocuments {
                documents: Vec::new(),
                input_files: 0,
                collected_bytes: 0,
                read_errors: 0,
                skipped: SkipCounts::default(),
                cancelled: true,
            });
        }
    };
    collect_snapshot_files(state, workspace, files, cancellation, limits)
}

fn collect_snapshot_files(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    files: Vec<MarkdownFileEntry>,
    cancellation: &CancellationToken,
    limits: IndexLimits,
) -> Result<CollectedDocuments, String> {
    collect_snapshot_files_with_before_open(state, workspace, files, cancellation, limits, |_| {})
}

fn collect_snapshot_files_with_before_open(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    mut files: Vec<MarkdownFileEntry>,
    cancellation: &CancellationToken,
    limits: IndexLimits,
    mut before_open: impl FnMut(&PathBuf),
) -> Result<CollectedDocuments, String> {
    state
        .file_authorization()
        .ensure_workspace_is_current(workspace)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let input_files = files.len();
    let mut documents = Vec::new();
    let mut skipped = SkipCounts::default();
    let mut eligible_files = 0usize;
    let mut aggregate_bytes = 0usize;
    let mut read_errors = 0usize;

    for entry in files {
        if cancellation.is_cancelled() {
            return Ok(CollectedDocuments {
                documents,
                input_files,
                collected_bytes: aggregate_bytes,
                read_errors,
                skipped,
                cancelled: true,
            });
        }
        if entry.kind != WorkspaceFileKind::Markdown {
            skipped.unsupported += 1;
            continue;
        }
        if eligible_files >= limits.max_files {
            skipped.file_count_limit += 1;
            continue;
        }
        eligible_files += 1;
        let snapshot_path = PathBuf::from(&entry.path);
        before_open(&snapshot_path);
        let file = match workspace.open_regular_file(&snapshot_path) {
            Ok(file) => file,
            Err(_) => {
                read_errors = read_errors.saturating_add(1);
                continue;
            }
        };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                read_errors = read_errors.saturating_add(1);
                continue;
            }
        };
        let file_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if file_bytes > limits.max_file_bytes {
            skipped.oversized += 1;
            continue;
        }
        if aggregate_bytes.saturating_add(file_bytes) > limits.max_aggregate_bytes {
            skipped.aggregate_limit += 1;
            continue;
        }
        let mut bytes = Vec::with_capacity(file_bytes.min(limits.max_file_bytes));
        let mut bounded: Take<File> = file.take((limits.max_file_bytes as u64).saturating_add(1));
        if bounded.read_to_end(&mut bytes).is_err() {
            read_errors = read_errors.saturating_add(1);
            continue;
        }
        if bytes.len() > limits.max_file_bytes {
            skipped.oversized += 1;
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                skipped.unsupported += 1;
                continue;
            }
        };
        if aggregate_bytes.saturating_add(content.len()) > limits.max_aggregate_bytes {
            skipped.aggregate_limit += 1;
            continue;
        }
        aggregate_bytes = aggregate_bytes.saturating_add(content.len());
        documents.push(IndexDocument {
            relative_path: entry.relative_path,
            content,
        });
    }

    Ok(CollectedDocuments {
        documents,
        input_files,
        collected_bytes: aggregate_bytes,
        read_errors,
        skipped,
        cancelled: false,
    })
}

fn merge_collection_report(report: &mut BuildReport, input_files: usize, skipped: &SkipCounts) {
    report.input_files = input_files;
    report.skipped.unsupported += skipped.unsupported;
    report.skipped.oversized += skipped.oversized;
    report.skipped.aggregate_limit += skipped.aggregate_limit;
    report.skipped.file_count_limit += skipped.file_count_limit;
}

fn build_collected_documents(
    documents: Vec<IndexDocument>,
    limits: IndexLimits,
    cancellation: &CancellationToken,
) -> BuildOutcome {
    if cancellation.is_cancelled() && documents.is_empty() {
        let report = build_index(Vec::new(), limits, &CancellationToken::new())
            .report()
            .clone();
        return BuildOutcome::Cancelled { report };
    }
    build_index(documents, limits, cancellation)
}

fn scan_report(collected: &CollectedDocuments) -> WorkspaceIndexScanReport {
    WorkspaceIndexScanReport {
        scanned_files: collected.input_files,
        collected_files: collected.documents.len(),
        collected_bytes: collected.collected_bytes,
        read_errors: collected.read_errors,
        skipped: collected.skipped.clone(),
    }
}

fn rebuild_response(
    status: WorkspaceIndexStatus,
    lease: &WorkspaceIndexLease,
    report: BuildReport,
    scan_report: WorkspaceIndexScanReport,
) -> WorkspaceIndexRebuildResponse {
    WorkspaceIndexRebuildResponse {
        status,
        workspace_token: lease.workspace_token.clone(),
        index_generation: lease.generation,
        implementation_id: report.implementation_id.clone(),
        schema_id: report.schema_id.clone(),
        report,
        scan_report,
    }
}

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

fn rebuild_authorized_workspace_index(
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
mod tests {
    use std::{fs, path::Path};

    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::process::Command;

    use tempfile::tempdir;

    use super::*;
    use crate::{
        commands::open_directory_inner, path_auth::revoke_authorized_path_prefix_inner,
        workspace_index::QueryKind,
    };

    fn open_workspace(state: &AppState, root: &Path) -> (String, String) {
        let snapshot = open_directory_inner(state, root).unwrap();
        (snapshot.workspace_token, snapshot.root)
    }

    fn rebuild_without_watch(
        state: &AppState,
        workspace_token: &str,
        workspace_root: &str,
    ) -> WorkspaceIndexRebuildResponse {
        let workspace = resolve_authorized_workspace_root_for_token_inner(
            state,
            workspace_token,
            workspace_root,
        )
        .unwrap();
        let canonical_root = fs::canonicalize(workspace_root).unwrap();
        let lease = state
            .workspace_index()
            .begin_rebuild_without_watch_for_test(workspace_token, &canonical_root, "build-1")
            .unwrap();
        let _guard = OperationGuard {
            state,
            operation_id: "build-1",
        };
        rebuild_authorized_workspace_index(state, &workspace, &lease).unwrap()
    }

    #[cfg(unix)]
    fn replace_directory_with_link(link: &Path, target: &Path) {
        symlink(target, link).unwrap();
    }

    #[cfg(windows)]
    fn replace_directory_with_link(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "failed to create test junction");
    }

    #[test]
    fn rebuild_and_query_are_bound_to_the_authorized_token_and_root() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("alpha.md"), "search needle").unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());

        let rebuilt = rebuild_without_watch(&state, &token, &root);
        assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);
        let response = query_workspace_index_inner(
            &state,
            &token,
            &root,
            "query-1",
            IndexQuery::full_text("needle"),
        )
        .unwrap();
        assert_eq!(response.status, WorkspaceIndexStatus::Ready);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].relative_path, "alpha.md");
        assert!(!Path::new(&response.results[0].relative_path).is_absolute());

        let other = tempdir().unwrap();
        let (_, other_root) = open_workspace(&state, other.path());
        assert!(query_workspace_index_inner(
            &state,
            &token,
            &other_root,
            "query-2",
            IndexQuery::filename("alpha"),
        )
        .is_err());
    }

    #[test]
    fn replacement_workspace_token_cannot_read_an_existing_index() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("alpha.md"), "needle").unwrap();
        let state = AppState::default();
        let (first_token, root) = open_workspace(&state, directory.path());
        rebuild_workspace_index_inner(&state, &first_token, &root, "build-1").unwrap();
        let (replacement_token, replacement_root) = open_workspace(&state, directory.path());

        assert!(query_workspace_index_inner(
            &state,
            &replacement_token,
            &replacement_root,
            "query-1",
            IndexQuery::filename("alpha"),
        )
        .is_err());
    }

    #[test]
    fn revoked_workspace_authority_rejects_queries_without_using_stale_paths() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("alpha.md"), "needle").unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());
        rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        revoke_authorized_path_prefix_inner(&state, Path::new(&root)).unwrap();

        assert!(query_workspace_index_inner(
            &state,
            &token,
            &root,
            "query-1",
            IndexQuery::filename("alpha"),
        )
        .is_err());
        assert!(discard_workspace_index_inner(&state, &token, &root).is_err());
    }

    #[test]
    fn discard_removes_all_results_and_rebuild_is_equivalent() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("alpha.md"), "needle").unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());
        let first = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        assert!(
            discard_workspace_index_inner(&state, &token, &root)
                .unwrap()
                .discarded
        );
        assert!(query_workspace_index_inner(
            &state,
            &token,
            &root,
            "query-1",
            IndexQuery::filename("alpha"),
        )
        .is_err());
        let second = rebuild_workspace_index_inner(&state, &token, &root, "build-2").unwrap();
        assert_eq!(first.report.corpus_digest, second.report.corpus_digest);
        assert_eq!(first.report.indexed_files, second.report.indexed_files);
    }

    #[test]
    fn cancelled_rebuild_leaves_the_new_generation_without_a_cache() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("alpha.md"), "old needle").unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());
        rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        fs::write(directory.path().join("alpha.md"), "new content").unwrap();
        let workspace =
            resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let lease = state
            .workspace_index()
            .begin_rebuild(&token, &canonical_root, "build-2")
            .unwrap();
        lease.cancellation.cancel();
        let cancelled = rebuild_authorized_workspace_index(&state, &workspace, &lease).unwrap();
        assert_eq!(cancelled.status, WorkspaceIndexStatus::Cancelled);
        state.workspace_index().end_operation("build-2");

        assert!(query_workspace_index_inner(
            &state,
            &token,
            &root,
            "query-1",
            IndexQuery::full_text("old needle"),
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rebuild_skips_unsupported_oversized_and_symlink_sources() {
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(directory.path().join("valid.md"), "needle").unwrap();
        fs::write(directory.path().join("unsupported.html"), "needle").unwrap();
        fs::write(
            directory.path().join("oversized.md"),
            vec![b'x'; IndexLimits::default().max_file_bytes + 1],
        )
        .unwrap();
        fs::write(outside.path().join("escaped.md"), "secret needle").unwrap();
        symlink(
            outside.path().join("escaped.md"),
            directory.path().join("linked.md"),
        )
        .unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());

        let response = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        assert_eq!(response.report.indexed_files, 1);
        assert_eq!(response.report.skipped.unsupported, 1);
        assert_eq!(response.report.skipped.oversized, 1);
        assert_eq!(response.report.input_files, 3);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn collection_refuses_a_parent_link_swap_after_authorization() {
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let nested = directory.path().join("nested");
        let moved = directory.path().join("nested-original");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("note.md"), "authorized content").unwrap();
        fs::write(outside.path().join("note.md"), "external secret needle").unwrap();
        let state = AppState::default();
        let (token, root) = open_workspace(&state, directory.path());
        let workspace =
            resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
        let files = match capture_workspace_index_snapshot(&workspace, &CancellationToken::new())
            .unwrap()
        {
            WorkspaceIndexSnapshotCapture::Completed(snapshot) => {
                snapshot.into_index_files(&workspace).unwrap()
            }
            WorkspaceIndexSnapshotCapture::Cancelled => panic!("snapshot must complete"),
        };
        let mut swapped = false;

        let collected = collect_snapshot_files_with_before_open(
            &state,
            &workspace,
            files,
            &CancellationToken::new(),
            IndexLimits::default(),
            |_| {
                if !swapped {
                    fs::rename(&nested, &moved).unwrap();
                    replace_directory_with_link(&nested, outside.path());
                    swapped = true;
                }
            },
        )
        .unwrap();

        assert!(swapped);
        assert_eq!(collected.read_errors, 1);
        assert!(collected.documents.is_empty());
    }

    #[test]
    fn collection_remains_bound_to_the_authorized_root_object_after_replacement() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let displaced = directory.path().join("workspace-original");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("note.md"), "authorized content").unwrap();
        let state = AppState::default();
        let (token, canonical_root) = open_workspace(&state, &root);
        let canonical_root_path = PathBuf::from(&canonical_root);
        let workspace =
            resolve_authorized_workspace_root_for_token_inner(&state, &token, &canonical_root)
                .unwrap();
        let files = match capture_workspace_index_snapshot(&workspace, &CancellationToken::new())
            .unwrap()
        {
            WorkspaceIndexSnapshotCapture::Completed(snapshot) => {
                snapshot.into_index_files(&workspace).unwrap()
            }
            WorkspaceIndexSnapshotCapture::Cancelled => panic!("snapshot must complete"),
        };
        let mut replaced = false;

        let result = collect_snapshot_files_with_before_open(
            &state,
            &workspace,
            files,
            &CancellationToken::new(),
            IndexLimits::default(),
            |_| {
                if !replaced {
                    fs::rename(&canonical_root_path, &displaced).unwrap();
                    fs::create_dir(&canonical_root_path).unwrap();
                    fs::write(
                        canonical_root_path.join("note.md"),
                        "external secret needle",
                    )
                    .unwrap();
                    replaced = true;
                }
            },
        );

        assert!(replaced);
        let collected = result.unwrap();
        assert_eq!(collected.documents.len(), 1);
        assert_eq!(collected.documents[0].content, "authorized content");
    }

    #[test]
    fn operation_cancellation_and_result_limits_are_bounded() {
        let state = AppState::default();
        let cancellation_root = tempdir().unwrap();
        fs::write(cancellation_root.path().join("cancel.md"), "needle").unwrap();
        let (cancellation_token, cancellation_root) =
            open_workspace(&state, cancellation_root.path());
        let cancellation = state
            .workspace_index()
            .begin_rebuild(
                &cancellation_token,
                &fs::canonicalize(&cancellation_root).unwrap(),
                "cancel-me",
            )
            .unwrap();
        assert!(state
            .workspace_index()
            .cancel_operation("cancel-me")
            .unwrap());
        assert!(cancellation.cancellation.is_cancelled());
        state.workspace_index().end_operation("cancel-me");
        assert!(!state
            .workspace_index()
            .cancel_operation("cancel-me")
            .unwrap());
        assert!(state
            .workspace_index()
            .begin_rebuild(
                &cancellation_token,
                &fs::canonicalize(&cancellation_root).unwrap(),
                "",
            )
            .is_err());

        let cancelled_directory = tempdir().unwrap();
        fs::write(cancelled_directory.path().join("cancelled.md"), "needle").unwrap();
        let (cancelled_token, cancelled_root) = open_workspace(&state, cancelled_directory.path());
        let cancelled_workspace = resolve_authorized_workspace_root_for_token_inner(
            &state,
            &cancelled_token,
            &cancelled_root,
        )
        .unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let collected = collect_documents(
            &state,
            &cancelled_workspace,
            &cancelled,
            IndexLimits::default(),
        )
        .unwrap();
        assert!(collected.cancelled);
        assert!(
            build_collected_documents(collected.documents, IndexLimits::default(), &cancelled)
                .is_cancelled()
        );

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let outcome = build_collected_documents(
            vec![IndexDocument {
                relative_path: "should-not-index.md".to_string(),
                content: "needle".repeat(10_000),
            }],
            IndexLimits::default(),
            &cancelled,
        );
        assert!(outcome.is_cancelled());
        assert_eq!(outcome.report().indexed_files, 0);
        assert_eq!(outcome.report().indexed_bytes, 0);

        let directory = tempdir().unwrap();
        for index in 0..105 {
            fs::write(directory.path().join(format!("note-{index}.md")), "needle").unwrap();
        }
        let (token, root) = open_workspace(&state, directory.path());
        let rebuilt = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);
        let response = query_workspace_index_inner(
            &state,
            &token,
            &root,
            "query-1",
            IndexQuery {
                kind: QueryKind::FullText,
                text: "needle".to_string(),
            },
        )
        .unwrap();
        assert_eq!(response.results.len(), IndexLimits::default().max_results);
        assert!(response.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn search_result_open_rechecks_the_exact_workspace_scope() {
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let document = nested.join("note.md");
        fs::write(&document, "needle").unwrap();
        let outside_document = outside.path().join("outside.md");
        fs::write(&outside_document, "outside").unwrap();
        symlink(&outside_document, directory.path().join("escaped.md")).unwrap();
        let state = AppState::default();
        let app_data = tempdir().unwrap();
        state
            .initialize_recent_files(app_data.path().to_path_buf())
            .unwrap();
        let (token, root) = open_workspace(&state, directory.path());
        let rebuilt = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
        assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);

        let prepared = open_workspace_index_result_inner(
            &state,
            "main",
            &token,
            &root,
            rebuilt.index_generation,
            "nested/note.md",
        )
        .unwrap();
        assert_eq!(
            prepared.file.path,
            fs::canonicalize(document).unwrap().to_string_lossy()
        );

        for relative_path in ["../outside.md", "/tmp/outside.md", "escaped.md"] {
            assert!(open_workspace_index_result_inner(
                &state,
                "main",
                &token,
                &root,
                rebuilt.index_generation,
                relative_path,
            )
            .is_err());
        }

        let other = tempdir().unwrap();
        let (_, other_root) = open_workspace(&state, other.path());
        assert!(open_workspace_index_result_inner(
            &state,
            "main",
            &token,
            &other_root,
            rebuilt.index_generation,
            "nested/note.md",
        )
        .is_err());
    }
}
