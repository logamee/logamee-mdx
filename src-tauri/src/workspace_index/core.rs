//! Core index build and query over collected documents.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::cancellation::CancellationToken;
use super::helpers::corpus_digest;
use super::helpers::normalize_for_search;
use super::{IndexedDocument, IndexDocument, IndexLimits, SkipCounts, BuildReport, OperationStatus, BuildOutcome, WorkspaceIndex, INDEX_IMPLEMENTATION_ID, INDEX_SCHEMA_ID};

mod scan;

use scan::{
    compare_document_order, match_document_rank, process_document, query_result_for,
    DocumentOutcome,
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryKind {
    Filename,
    FullText,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexQuery {
    pub kind: QueryKind,
    pub text: String,
}

impl IndexQuery {
    pub fn filename(text: impl Into<String>) -> Self {
        Self {
            kind: QueryKind::Filename,
            text: text.into(),
        }
    }

    pub fn full_text(text: impl Into<String>) -> Self {
        Self {
            kind: QueryKind::FullText,
            text: text.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryLocation {
    /// One-based source line for the first full-text match.
    pub line: usize,
    /// Zero-based byte offset in the original UTF-8 source.
    pub utf8_byte_offset: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub relative_path: String,
    pub snippet: Option<String>,
    pub location: Option<QueryLocation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub implementation_id: String,
    pub schema_id: String,
    pub status: OperationStatus,
    pub truncated: bool,
    pub results: Vec<QueryResult>,
}

pub fn build_index(
    mut documents: Vec<IndexDocument>,
    limits: IndexLimits,
    cancellation: &CancellationToken,
) -> BuildOutcome {
    documents.sort_by(compare_document_order);
    let corpus_digest = corpus_digest(&documents);
    let input_files = documents.len();
    let mut report = BuildReport {
        implementation_id: INDEX_IMPLEMENTATION_ID.to_owned(),
        schema_id: INDEX_SCHEMA_ID.to_owned(),
        corpus_digest,
        limits,
        input_files,
        indexed_files: 0,
        indexed_bytes: 0,
        estimated_index_bytes: 0,
        skipped: SkipCounts::default(),
    };
    let mut indexed = Vec::with_capacity(input_files.min(limits.max_files));
    let mut eligible_files = 0usize;
    let mut seen_paths = HashSet::with_capacity(input_files.min(limits.max_files));

    for document in documents {
        if cancellation.is_cancelled() {
            return BuildOutcome::Cancelled { report };
        }
        match process_document(
            document,
            &limits,
            &mut report,
            &mut eligible_files,
            &mut seen_paths,
            cancellation,
        ) {
            DocumentOutcome::Skipped => {}
            DocumentOutcome::Cancelled => return BuildOutcome::Cancelled { report },
            DocumentOutcome::Indexed(indexed_document) => indexed.push(indexed_document),
        }
    }

    BuildOutcome::Completed {
        index: WorkspaceIndex {
            documents: indexed,
            limits,
        },
        report,
    }
}

pub fn query_index(
    index: &WorkspaceIndex,
    query: IndexQuery,
    cancellation: &CancellationToken,
) -> QueryResponse {
    let mut response = QueryResponse {
        implementation_id: INDEX_IMPLEMENTATION_ID.to_owned(),
        schema_id: INDEX_SCHEMA_ID.to_owned(),
        status: OperationStatus::Completed,
        truncated: false,
        results: Vec::new(),
    };
    if cancellation.is_cancelled() {
        response.status = OperationStatus::Cancelled;
        return response;
    }
    let query_text: String = query
        .text
        .chars()
        .take(index.limits.max_query_chars)
        .collect();
    let normalized_query = normalize_for_search(query_text.trim());
    if normalized_query.is_empty() {
        return response;
    }
    let terms: Vec<&str> = normalized_query.split_whitespace().collect();
    let max_results = index.limits.max_results;
    let mut matched_count = 0usize;
    let mut ranked_matches: [Vec<&IndexedDocument>; 3] =
        std::array::from_fn(|_| Vec::with_capacity(max_results.min(index.documents.len())));

    for document in &index.documents {
        if cancellation.is_cancelled() {
            response.status = OperationStatus::Cancelled;
            response.results.clear();
            return response;
        }
        if let Some(rank) = match_document_rank(document, query.kind, &terms, &normalized_query) {
            matched_count = matched_count.saturating_add(1);
            let bucket = &mut ranked_matches[rank];
            if bucket.len() < max_results {
                bucket.push(document);
            }
        }
    }

    // build_index stores documents in normalized-path order. Keeping only the bounded prefix of
    // each rank preserves the same ordering while avoiding snippets and location scans for results
    // that will be discarded. The scan itself remains complete so cancellation stays observable.
    response.truncated = matched_count > max_results;
    response.results = ranked_matches
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|document| query_result_for(document, query.kind, &terms, &index.limits))
        .collect();
    response
}
