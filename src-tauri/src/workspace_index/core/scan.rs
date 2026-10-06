//! Per-document admission, ranking, and result shaping helpers for the core index paths.
use std::collections::HashSet;

use super::super::cancellation::CancellationToken;
use super::super::helpers::{
    bounded_snippet, is_supported_markdown_path, normalize_content, normalize_relative_path,
    normalize_for_search, source_location_for_normalized_offset,
};
use super::super::{BuildReport, IndexDocument, IndexLimits, IndexedDocument};
use super::{QueryKind, QueryResult};

pub(super) fn compare_document_order(
    left: &IndexDocument,
    right: &IndexDocument,
) -> std::cmp::Ordering {
    let left_path = normalize_relative_path(&left.relative_path)
        .unwrap_or_else(|| left.relative_path.clone());
    let right_path = normalize_relative_path(&right.relative_path)
        .unwrap_or_else(|| right.relative_path.clone());
    normalize_for_search(&left_path)
        .cmp(&normalize_for_search(&right_path))
        .then_with(|| left_path.cmp(&right_path))
}

pub(super) enum DocumentOutcome {
    Skipped,
    Cancelled,
    Indexed(IndexedDocument),
}

pub(super) fn process_document(
    document: IndexDocument,
    limits: &IndexLimits,
    report: &mut BuildReport,
    eligible_files: &mut usize,
    seen_paths: &mut HashSet<String>,
    cancellation: &CancellationToken,
) -> DocumentOutcome {
    let Some(relative_path) = normalize_relative_path(&document.relative_path) else {
        report.skipped.invalid_relative_path += 1;
        return DocumentOutcome::Skipped;
    };
    if !is_supported_markdown_path(&relative_path) {
        report.skipped.unsupported += 1;
        return DocumentOutcome::Skipped;
    }
    let normalized_path = normalize_for_search(&relative_path);
    if !seen_paths.insert(relative_path.clone()) {
        report.skipped.duplicate_path += 1;
        return DocumentOutcome::Skipped;
    }
    if *eligible_files >= limits.max_files {
        report.skipped.file_count_limit += 1;
        return DocumentOutcome::Skipped;
    }
    *eligible_files += 1;
    let bytes = document.content.len();
    if bytes > limits.max_file_bytes {
        report.skipped.oversized += 1;
        return DocumentOutcome::Skipped;
    }
    if report.indexed_bytes.saturating_add(bytes) > limits.max_aggregate_bytes {
        report.skipped.aggregate_limit += 1;
        return DocumentOutcome::Skipped;
    }
    let Some(normalized_content) = normalize_content(&document.content, cancellation) else {
        return DocumentOutcome::Cancelled;
    };
    report.indexed_files += 1;
    report.indexed_bytes += bytes;
    report.estimated_index_bytes = report
        .estimated_index_bytes
        .saturating_add(relative_path.len())
        .saturating_add(normalized_path.len())
        .saturating_add(document.content.len())
        .saturating_add(normalized_content.len());
    DocumentOutcome::Indexed(IndexedDocument {
        relative_path,
        normalized_path,
        content: document.content,
        normalized_content,
    })
}

pub(super) fn match_document_rank(
    document: &IndexedDocument,
    kind: QueryKind,
    terms: &[&str],
    normalized_query: &str,
) -> Option<usize> {
    match kind {
        QueryKind::Filename => {
            let filename = document
                .normalized_path
                .rsplit('/')
                .next()
                .unwrap_or(&document.normalized_path);
            let stem = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
            let matched = terms
                .iter()
                .all(|term| document.normalized_path.contains(term));
            let rank = if stem == normalized_query {
                0usize
            } else if stem.starts_with(normalized_query) {
                1
            } else {
                2
            };
            if matched {
                Some(rank)
            } else {
                None
            }
        }
        QueryKind::FullText => {
            let matched = terms
                .iter()
                .all(|term| document.normalized_content.contains(term));
            if matched {
                Some(0)
            } else {
                None
            }
        }
    }
}

pub(super) fn query_result_for(
    document: &IndexedDocument,
    kind: QueryKind,
    terms: &[&str],
    limits: &IndexLimits,
) -> QueryResult {
    let (snippet, location) = match kind {
        QueryKind::Filename => (None, None),
        QueryKind::FullText => {
            let normalized_offset = document.normalized_content.find(terms[0]).unwrap_or(0);
            (
                Some(bounded_snippet(
                    &document.content,
                    &document.normalized_content,
                    terms[0],
                    limits.max_snippet_chars,
                )),
                Some(source_location_for_normalized_offset(
                    &document.content,
                    normalized_offset,
                ))
            )
        }
    };
    QueryResult {
        relative_path: document.relative_path.clone(),
        snippet,
        location,
    }
}
