use std::{
    fs::File,
    io::{Read, Take},
    path::PathBuf,
};



use crate::{
    models::MarkdownFileEntry,
    path_auth::AuthorizedWorkspace,
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
    workspace_index::{BuildOutcome, BuildReport, CancellationToken, IndexDocument, IndexLimits, SkipCounts, build_index},
    workspace_index_runtime::WorkspaceIndexLease,
    workspace_snapshot::{capture_workspace_index_snapshot, WorkspaceIndexSnapshotCapture},
};


use super::{WorkspaceIndexRebuildResponse, WorkspaceIndexScanReport, WorkspaceIndexStatus};
pub(crate) struct CollectedDocuments {
    pub(crate) documents: Vec<IndexDocument>,
    pub(crate) input_files: usize,
    pub(crate) collected_bytes: usize,
    pub(crate) read_errors: usize,
    pub(crate) skipped: SkipCounts,
    pub(crate) cancelled: bool,
}

pub(crate) fn collect_documents(
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

pub(crate) fn collect_snapshot_files_with_before_open(
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
        if !snapshot_entry_is_admissible(&entry, eligible_files, &limits, &mut skipped) {
            continue;
        }
        eligible_files += 1;
        match read_entry_content(workspace, &entry, &mut before_open, &limits, aggregate_bytes) {
            EntryContent::Content(content) => {
                aggregate_bytes = aggregate_bytes.saturating_add(content.len());
                documents.push(IndexDocument {
                    relative_path: entry.relative_path,
                    content,
                });
            }
            EntryContent::ReadError => read_errors = read_errors.saturating_add(1),
            EntryContent::Oversized => skipped.oversized += 1,
            EntryContent::AggregateLimit => skipped.aggregate_limit += 1,
            EntryContent::Unsupported => skipped.unsupported += 1,
        }
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

fn snapshot_entry_is_admissible(
    entry: &MarkdownFileEntry,
    eligible_files: usize,
    limits: &IndexLimits,
    skipped: &mut SkipCounts,
) -> bool {
    if entry.kind != WorkspaceFileKind::Markdown {
        skipped.unsupported += 1;
        return false;
    }
    if eligible_files >= limits.max_files {
        skipped.file_count_limit += 1;
        return false;
    }
    true
}

enum EntryContent {
    ReadError,
    Oversized,
    AggregateLimit,
    Unsupported,
    Content(String),
}

fn read_entry_content(
    workspace: &AuthorizedWorkspace,
    entry: &MarkdownFileEntry,
    before_open: &mut impl FnMut(&PathBuf),
    limits: &IndexLimits,
    aggregate_bytes: usize,
) -> EntryContent {
    let snapshot_path = PathBuf::from(&entry.path);
    before_open(&snapshot_path);
    let file = match workspace.open_regular_file(&snapshot_path) {
        Ok(file) => file,
        Err(_) => return EntryContent::ReadError,
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return EntryContent::ReadError,
    };
    let file_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if file_bytes > limits.max_file_bytes {
        return EntryContent::Oversized;
    }
    if aggregate_bytes.saturating_add(file_bytes) > limits.max_aggregate_bytes {
        return EntryContent::AggregateLimit;
    }
    let mut bytes = Vec::with_capacity(file_bytes.min(limits.max_file_bytes));
    let mut bounded: Take<File> = file.take((limits.max_file_bytes as u64).saturating_add(1));
    if bounded.read_to_end(&mut bytes).is_err() {
        return EntryContent::ReadError;
    }
    if bytes.len() > limits.max_file_bytes {
        return EntryContent::Oversized;
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => return EntryContent::Unsupported,
    };
    if aggregate_bytes.saturating_add(content.len()) > limits.max_aggregate_bytes {
        return EntryContent::AggregateLimit;
    }
    EntryContent::Content(content)
}

pub(crate) fn merge_collection_report(report: &mut BuildReport, input_files: usize, skipped: &SkipCounts) {
    report.input_files = input_files;
    report.skipped.unsupported += skipped.unsupported;
    report.skipped.oversized += skipped.oversized;
    report.skipped.aggregate_limit += skipped.aggregate_limit;
    report.skipped.file_count_limit += skipped.file_count_limit;
}

pub(crate) fn build_collected_documents(
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

pub(crate) fn scan_report(collected: &CollectedDocuments) -> WorkspaceIndexScanReport {
    WorkspaceIndexScanReport {
        scanned_files: collected.input_files,
        collected_files: collected.documents.len(),
        collected_bytes: collected.collected_bytes,
        read_errors: collected.read_errors,
        skipped: collected.skipped.clone(),
    }
}

pub(crate) fn rebuild_response(
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
