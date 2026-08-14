use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Instant;

use crate::workspace_file_kind::WorkspaceFileKind;

pub const INDEX_IMPLEMENTATION_ID: &str = "mmd-memory-substring-v1";
pub const INDEX_SCHEMA_ID: &str = "mmd-workspace-index-v1";
const MAX_BENCHMARK_WARMUPS: usize = 20;
const MAX_BENCHMARK_SAMPLES: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexLimits {
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_aggregate_bytes: usize,
    pub max_results: usize,
    pub max_query_chars: usize,
    pub max_snippet_chars: usize,
}

impl Default for IndexLimits {
    fn default() -> Self {
        Self {
            max_files: 100_000,
            max_file_bytes: 1_048_576,
            max_aggregate_bytes: 268_435_456,
            max_results: 100,
            max_query_chars: 256,
            max_snippet_chars: 240,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDocument {
    /// A display/navigation hint only. Callers must authorize before opening it.
    pub relative_path: String,
    pub content: String,
}

#[derive(Clone, Debug)]
struct IndexedDocument {
    relative_path: String,
    normalized_path: String,
    content: String,
    normalized_content: String,
}

#[derive(Debug)]
pub struct WorkspaceIndex {
    documents: Vec<IndexedDocument>,
    limits: IndexLimits,
}

impl WorkspaceIndex {
    pub fn discard(&mut self) {
        self.documents.clear();
        self.documents.shrink_to_fit();
    }

    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }

    pub fn normalized_documents(&self) -> Vec<IndexDocument> {
        self.documents
            .iter()
            .map(|document| IndexDocument {
                relative_path: document.relative_path.clone(),
                content: document.content.clone(),
            })
            .collect()
    }

    pub(crate) fn exact_content_for_relative_path(&self, relative_path: &str) -> Option<&str> {
        let normalized_path = normalize_for_search(relative_path);
        self.documents
            .binary_search_by(|document| {
                document
                    .normalized_path
                    .cmp(&normalized_path)
                    .then_with(|| document.relative_path.as_str().cmp(relative_path))
            })
            .ok()
            .and_then(|index| {
                let document = &self.documents[index];
                (document.relative_path == relative_path).then_some(document.content.as_str())
            })
    }

    pub(crate) fn has_same_exact_documents(&self, other: &Self) -> bool {
        self.documents.len() == other.documents.len()
            && self
                .documents
                .iter()
                .zip(&other.documents)
                .all(|(left, right)| {
                    left.relative_path == right.relative_path && left.content == right.content
                })
    }

    pub(crate) fn limits(&self) -> IndexLimits {
        self.limits
    }

    pub(crate) fn max_file_bytes(&self) -> usize {
        self.limits.max_file_bytes
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipCounts {
    pub unsupported: usize,
    pub invalid_relative_path: usize,
    pub duplicate_path: usize,
    pub oversized: usize,
    pub aggregate_limit: usize,
    pub file_count_limit: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub implementation_id: String,
    pub schema_id: String,
    pub corpus_digest: String,
    pub limits: IndexLimits,
    pub input_files: usize,
    pub indexed_files: usize,
    pub indexed_bytes: usize,
    pub estimated_index_bytes: usize,
    pub skipped: SkipCounts,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationStatus {
    Completed,
    Cancelled,
}

#[derive(Debug)]
pub enum BuildOutcome {
    Completed {
        index: WorkspaceIndex,
        report: BuildReport,
    },
    Cancelled {
        report: BuildReport,
    },
}

impl BuildOutcome {
    pub fn completed(self) -> Option<(WorkspaceIndex, BuildReport)> {
        match self {
            Self::Completed { index, report } => Some((index, report)),
            Self::Cancelled { .. } => None,
        }
    }

    pub fn report(&self) -> &BuildReport {
        match self {
            Self::Completed { report, .. } | Self::Cancelled { report } => report,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }
}

#[derive(Debug)]
struct CancellationState {
    cancelled: AtomicBool,
    checks_before_cancel: AtomicUsize,
    deadline: Option<Instant>,
}

#[derive(Clone, Debug)]
pub struct CancellationToken(Arc<CancellationState>);

impl Default for CancellationToken {
    fn default() -> Self {
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            checks_before_cancel: AtomicUsize::new(usize::MAX),
            deadline: None,
        }))
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_deadline(deadline: Instant) -> Self {
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            checks_before_cancel: AtomicUsize::new(usize::MAX),
            deadline: Some(deadline),
        }))
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }

    /// Deterministic cancellation hook for benchmarks and tests. Production callers
    /// normally clone the token and call `cancel` from their request-stop path.
    pub fn cancel_after_checks(&self, checks: usize) {
        self.0.checks_before_cancel.store(checks, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        if self
            .0
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.cancel();
        }
        if self.0.cancelled.load(Ordering::Acquire) {
            return true;
        }
        let reached_zero = self
            .0
            .checks_before_cancel
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                if remaining != usize::MAX && remaining > 0 {
                    Some(remaining - 1)
                } else {
                    None
                }
            })
            .is_err();
        if reached_zero && self.0.checks_before_cancel.load(Ordering::Acquire) == 0 {
            self.cancel();
            return true;
        }
        false
    }
}

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
    documents.sort_by(|left, right| {
        let left_path = normalize_relative_path(&left.relative_path)
            .unwrap_or_else(|| left.relative_path.clone());
        let right_path = normalize_relative_path(&right.relative_path)
            .unwrap_or_else(|| right.relative_path.clone());
        normalize_for_search(&left_path)
            .cmp(&normalize_for_search(&right_path))
            .then_with(|| left_path.cmp(&right_path))
    });
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
        let Some(relative_path) = normalize_relative_path(&document.relative_path) else {
            report.skipped.invalid_relative_path += 1;
            continue;
        };
        if !is_supported_markdown_path(&relative_path) {
            report.skipped.unsupported += 1;
            continue;
        }
        let normalized_path = normalize_for_search(&relative_path);
        if !seen_paths.insert(relative_path.clone()) {
            report.skipped.duplicate_path += 1;
            continue;
        }
        if eligible_files >= limits.max_files {
            report.skipped.file_count_limit += 1;
            continue;
        }
        eligible_files += 1;
        let bytes = document.content.len();
        if bytes > limits.max_file_bytes {
            report.skipped.oversized += 1;
            continue;
        }
        if report.indexed_bytes.saturating_add(bytes) > limits.max_aggregate_bytes {
            report.skipped.aggregate_limit += 1;
            continue;
        }
        let Some(normalized_content) = normalize_content(&document.content, cancellation) else {
            return BuildOutcome::Cancelled { report };
        };
        report.indexed_files += 1;
        report.indexed_bytes += bytes;
        report.estimated_index_bytes = report
            .estimated_index_bytes
            .saturating_add(relative_path.len())
            .saturating_add(normalized_path.len())
            .saturating_add(document.content.len())
            .saturating_add(normalized_content.len());
        indexed.push(IndexedDocument {
            relative_path,
            normalized_path,
            content: document.content,
            normalized_content,
        });
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
        let (matched, rank) = match query.kind {
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
                } else if stem.starts_with(&normalized_query) {
                    1
                } else {
                    2
                };
                (matched, rank)
            }
            QueryKind::FullText => {
                let matched = terms
                    .iter()
                    .all(|term| document.normalized_content.contains(term));
                (matched, 0usize)
            }
        };
        if matched {
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
        .map(|document| {
            let (snippet, location) = match query.kind {
                QueryKind::Filename => (None, None),
                QueryKind::FullText => {
                    let normalized_offset = document.normalized_content.find(terms[0]).unwrap_or(0);
                    (
                        Some(bounded_snippet(
                            &document.content,
                            &document.normalized_content,
                            terms[0],
                            index.limits.max_snippet_chars,
                        )),
                        Some(source_location_for_normalized_offset(
                            &document.content,
                            normalized_offset,
                        )),
                    )
                }
            };
            QueryResult {
                relative_path: document.relative_path.clone(),
                snippet,
                location,
            }
        })
        .collect();
    response
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRequest {
    pub documents: Vec<IndexDocument>,
    #[serde(default)]
    pub limits: IndexLimits,
    #[serde(default)]
    pub queries: Vec<IndexQuery>,
    #[serde(default)]
    pub cancel_before_build: bool,
    #[serde(default)]
    pub cancel_before_query: bool,
    #[serde(default)]
    pub cancel_build_after_checks: Option<usize>,
    #[serde(default)]
    pub cancel_query_after_checks: Option<usize>,
    #[serde(default)]
    pub warmup_count: usize,
    #[serde(default = "default_sample_count")]
    pub sample_count: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResponse {
    pub implementation_id: String,
    pub schema_id: String,
    pub status: OperationStatus,
    pub corpus_digest: String,
    pub limits: IndexLimits,
    pub build_report: Option<BuildReport>,
    pub queries: Vec<QueryResponse>,
    pub timing: BenchmarkTiming,
    pub memory: MemoryMeasurement,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkTiming {
    pub clock: String,
    pub warmup_count: usize,
    pub sample_count: usize,
    pub build_micros: Vec<u64>,
    pub query_micros: Vec<Vec<u64>>,
    pub cancellation_micros: Vec<u64>,
    pub error_count: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMeasurement {
    pub measurement_kind: String,
    pub peak_rss_before_bytes: Option<u64>,
    pub peak_rss_after_bytes: Option<u64>,
    pub peak_incremental_bytes: Option<u64>,
    pub estimated_index_bytes: usize,
}

pub fn run_benchmark_request(request: BenchmarkRequest) -> BenchmarkResponse {
    let warmup_count = request.warmup_count.min(MAX_BENCHMARK_WARMUPS);
    let sample_count = request.sample_count.clamp(1, MAX_BENCHMARK_SAMPLES);
    let mut timing = BenchmarkTiming {
        clock: "std::time::Instant".to_owned(),
        warmup_count,
        sample_count,
        build_micros: Vec::with_capacity(sample_count),
        query_micros: vec![Vec::with_capacity(sample_count); request.queries.len()],
        cancellation_micros: Vec::new(),
        error_count: 0,
    };
    let rss_before = process_peak_rss_bytes();
    let mut final_report = None;
    let mut final_queries = Vec::new();
    let mut final_status = OperationStatus::Completed;

    for iteration in 0..warmup_count.saturating_add(sample_count) {
        let measured = iteration >= warmup_count;
        let build_cancellation = CancellationToken::new();
        if request.cancel_before_build {
            build_cancellation.cancel();
        }
        if let Some(checks) = request.cancel_build_after_checks {
            build_cancellation.cancel_after_checks(checks);
        }
        let started = Instant::now();
        let outcome = build_index(
            request.documents.clone(),
            request.limits,
            &build_cancellation,
        );
        let elapsed = elapsed_micros(started);
        if measured {
            timing.build_micros.push(elapsed);
            if outcome.is_cancelled() {
                timing.cancellation_micros.push(elapsed);
            }
        }
        final_report = Some(outcome.report().clone());
        let Some((index, _)) = outcome.completed() else {
            final_status = OperationStatus::Cancelled;
            final_queries.clear();
            continue;
        };

        let mut iteration_queries = Vec::with_capacity(request.queries.len());
        for (query_index_number, query) in request.queries.iter().cloned().enumerate() {
            let query_cancellation = CancellationToken::new();
            if request.cancel_before_query {
                query_cancellation.cancel();
            }
            if let Some(checks) = request.cancel_query_after_checks {
                query_cancellation.cancel_after_checks(checks);
            }
            let started = Instant::now();
            let response = query_index(&index, query, &query_cancellation);
            let elapsed = elapsed_micros(started);
            if measured {
                timing.query_micros[query_index_number].push(elapsed);
                if response.status == OperationStatus::Cancelled {
                    timing.cancellation_micros.push(elapsed);
                }
            }
            if response.status == OperationStatus::Cancelled {
                final_status = OperationStatus::Cancelled;
            }
            iteration_queries.push(response);
        }
        final_queries = iteration_queries;
    }

    let report = final_report.expect("sample count is clamped to at least one");
    let estimated_index_bytes = report.estimated_index_bytes;
    let rss_after = process_peak_rss_bytes();
    let peak_incremental_bytes = rss_before
        .zip(rss_after)
        .map(|(before, after)| after.saturating_sub(before));
    BenchmarkResponse {
        implementation_id: INDEX_IMPLEMENTATION_ID.to_owned(),
        schema_id: INDEX_SCHEMA_ID.to_owned(),
        status: final_status,
        corpus_digest: report.corpus_digest.clone(),
        limits: report.limits,
        build_report: Some(report),
        queries: final_queries,
        timing,
        memory: MemoryMeasurement {
            measurement_kind: if rss_before.is_some() && rss_after.is_some() {
                "processPeakRssDelta".to_owned()
            } else {
                "unavailable".to_owned()
            },
            peak_rss_before_bytes: rss_before,
            peak_rss_after_bytes: rss_after,
            peak_incremental_bytes,
            estimated_index_bytes,
        },
    }
}

fn default_sample_count() -> usize {
    1
}

fn elapsed_micros(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

#[cfg(unix)]
fn process_peak_rss_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `usage` points to writable storage for `getrusage`, and is read only
    // after the OS reports success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let peak = unsafe { usage.assume_init() }.ru_maxrss;
    let peak = u64::try_from(peak).ok()?;
    #[cfg(target_os = "macos")]
    {
        Some(peak)
    }
    #[cfg(not(target_os = "macos"))]
    {
        peak.checked_mul(1024)
    }
}

#[cfg(not(unix))]
fn process_peak_rss_bytes() -> Option<u64> {
    None
}

fn normalize_relative_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.ends_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || normalized.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    Some(normalized)
}

fn is_supported_markdown_path(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        let normalized = extension.to_ascii_lowercase();
        WorkspaceFileKind::Markdown
            .extensions()
            .contains(&normalized.as_str())
    })
}

fn normalize_for_search(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        append_casefolded(&mut normalized, character);
    }
    normalized
}

fn normalize_content(value: &str, cancellation: &CancellationToken) -> Option<String> {
    let mut normalized = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if index % 4096 == 0 && cancellation.is_cancelled() {
            return None;
        }
        append_casefolded(&mut normalized, character);
    }
    Some(normalized)
}

fn bounded_snippet(
    content: &str,
    normalized_content: &str,
    first_term: &str,
    max_chars: usize,
) -> String {
    if max_chars == 0 {
        return String::new();
    }
    // Lowercasing can change byte lengths, so use the match only as an approximate
    // character anchor and slice the original exclusively at character boundaries.
    let byte_anchor = normalized_content.find(first_term).unwrap_or(0);
    let anchor_chars = normalized_content[..byte_anchor].chars().count();
    let total_chars = content.chars().count();
    let start = anchor_chars.saturating_sub(max_chars / 3).min(total_chars);
    content.chars().skip(start).take(max_chars).collect()
}

fn source_location_for_normalized_offset(content: &str, normalized_offset: usize) -> QueryLocation {
    let mut line = 1usize;
    let mut original_offset = 0usize;
    let mut normalized_cursor = 0usize;

    for character in content.chars() {
        let mut folded = String::new();
        append_casefolded(&mut folded, character);
        let next_normalized_cursor = normalized_cursor.saturating_add(folded.len());
        if normalized_offset < next_normalized_cursor {
            return QueryLocation {
                line,
                utf8_byte_offset: original_offset,
            };
        }
        normalized_cursor = next_normalized_cursor;
        original_offset = original_offset.saturating_add(character.len_utf8());
        if character == '\n' {
            line = line.saturating_add(1);
        }
    }

    QueryLocation {
        line,
        utf8_byte_offset: original_offset,
    }
}

fn corpus_digest(documents: &[IndexDocument]) -> String {
    let mut digest = Sha256::new();
    for document in documents {
        let path_length = (document.relative_path.len() as u64).to_le_bytes();
        let content_length = (document.content.len() as u64).to_le_bytes();
        for bytes in [
            path_length.as_slice(),
            document.relative_path.as_bytes(),
            content_length.as_slice(),
            document.content.as_bytes(),
        ] {
            digest.update(bytes);
        }
    }
    format!("sha256-v1:{:x}", digest.finalize())
}

fn append_casefolded(output: &mut String, character: char) {
    // Full case folding differs from lowercasing for these common multi/special
    // mappings. Other characters use Unicode lowercase supplied by the standard
    // library; the schema ID versions this tokenizer contract.
    match character {
        '\u{00df}' | '\u{1e9e}' => output.push_str("ss"),
        '\u{03c2}' => output.push('\u{03c3}'),
        _ => output.extend(character.to_lowercase()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(path: &str, content: &str) -> IndexDocument {
        IndexDocument {
            relative_path: path.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn builds_deterministically_and_reports_identity_digest_and_limits() {
        let documents = vec![
            document("zeta.md", "Shared needle"),
            document("alpha.md", "Shared needle"),
        ];
        let limits = IndexLimits::default();

        let first = build_index(documents.clone(), limits, &CancellationToken::new());
        let second = build_index(documents, limits, &CancellationToken::new());
        let (first_index, first_report) = first.completed().unwrap();
        let (second_index, second_report) = second.completed().unwrap();

        assert_eq!(first_report, second_report);
        assert_eq!(first_report.implementation_id, INDEX_IMPLEMENTATION_ID);
        assert_eq!(first_report.schema_id, INDEX_SCHEMA_ID);
        assert!(first_report.corpus_digest.starts_with("sha256-v1:"));
        assert_eq!(first_report.limits, limits);
        assert_eq!(
            first_index.normalized_documents(),
            second_index.normalized_documents()
        );
    }

    #[test]
    fn keeps_case_distinct_paths_as_separate_filesystem_identities() {
        let (index, report) = build_index(
            vec![
                document("A/note.md", "upper"),
                document("a/note.md", "lower"),
            ],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();

        assert_eq!(report.indexed_files, 2);
        assert_eq!(report.skipped.duplicate_path, 0);
        assert_eq!(
            index.exact_content_for_relative_path("A/note.md"),
            Some("upper")
        );
        assert_eq!(
            index.exact_content_for_relative_path("a/note.md"),
            Some("lower")
        );
    }

    #[test]
    fn enforces_file_count_per_file_and_aggregate_limits_with_skip_counts() {
        let limits = IndexLimits {
            max_files: 3,
            max_file_bytes: 8,
            max_aggregate_bytes: 10,
            ..IndexLimits::default()
        };
        let outcome = build_index(
            vec![
                document("a.md", "123456"),
                document("b.md", "123456789"),
                document("c.md", "123456"),
                document("d.txt", "ok"),
                document("e.md", "ok"),
            ],
            limits,
            &CancellationToken::new(),
        );
        let (_, report) = outcome.completed().unwrap();

        assert_eq!(report.indexed_files, 1);
        assert_eq!(report.indexed_bytes, 6);
        assert_eq!(report.skipped.oversized, 1);
        assert_eq!(report.skipped.aggregate_limit, 1);
        assert_eq!(report.skipped.file_count_limit, 1);
        assert_eq!(report.skipped.unsupported, 1);
    }

    #[test]
    fn indexes_the_same_markdown_extensions_as_the_workspace_file_policy() {
        let (index, report) = build_index(
            vec![
                document("notes/readme.mdx", "mdx"),
                document("notes/readme.mkd", "mkd"),
                document("notes/legacy.mkdn", "legacy"),
            ],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();

        assert_eq!(report.indexed_files, 2);
        assert_eq!(
            query_index(
                &index,
                IndexQuery::full_text("mdx"),
                &CancellationToken::new()
            )
            .results[0]
                .relative_path,
            "notes/readme.mdx",
        );
        assert!(query_index(
            &index,
            IndexQuery::full_text("legacy"),
            &CancellationToken::new(),
        )
        .results
        .is_empty());
    }

    #[test]
    fn filename_and_full_text_queries_have_stable_normalized_order_and_bounded_snippets() {
        let limits = IndexLimits {
            max_results: 2,
            max_snippet_chars: 12,
            ..IndexLimits::default()
        };
        let (index, _) = build_index(
            vec![
                document("notes/Zebra.md", "prefix searchable suffix"),
                document("notes/searchable-guide.md", "other"),
                document("Searchable.md", "last"),
            ],
            limits,
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();

        let filenames = query_index(
            &index,
            IndexQuery::filename("searchable"),
            &CancellationToken::new(),
        );
        assert_eq!(
            filenames
                .results
                .iter()
                .map(|result| result.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["Searchable.md", "notes/searchable-guide.md"]
        );

        let content = query_index(
            &index,
            IndexQuery::full_text("searchable"),
            &CancellationToken::new(),
        );
        assert_eq!(content.results[0].relative_path, "notes/Zebra.md");
        assert!(content.results[0].snippet.as_ref().unwrap().chars().count() <= 12);
    }

    #[test]
    fn full_text_query_supports_unicode_cjk_and_full_case_folding() {
        let (index, _) = build_index(
            vec![document("unicode.md", "Rust Straße; 中文搜索; ος σ")],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();

        let cjk = query_index(
            &index,
            IndexQuery::full_text("中文"),
            &CancellationToken::new(),
        );
        let latin = query_index(
            &index,
            IndexQuery::full_text("STRASSE"),
            &CancellationToken::new(),
        );
        let sigma = query_index(
            &index,
            IndexQuery::full_text("οσ"),
            &CancellationToken::new(),
        );
        assert_eq!(cjk.results.len(), 1);
        assert_eq!(latin.results.len(), 1);
        assert_eq!(sigma.results.len(), 1);
    }

    #[test]
    fn full_text_results_report_the_original_utf8_match_location() {
        let content = "前缀\r\nStraße\nCafe\u{301} needle";
        let (index, _) = build_index(
            vec![document("unicode.md", content)],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();

        let response = query_index(
            &index,
            IndexQuery::full_text("ss"),
            &CancellationToken::new(),
        );

        assert_eq!(response.results.len(), 1);
        assert_eq!(
            response.results[0].location,
            Some(QueryLocation {
                line: 2,
                utf8_byte_offset: "前缀\r\nStra".len(),
            }),
        );
    }

    #[test]
    fn cancellation_is_observed_by_build_and_query() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let build = build_index(
            vec![document("a.md", "needle")],
            IndexLimits::default(),
            &cancelled,
        );
        assert!(build.is_cancelled());

        let (index, _) = build_index(
            vec![document("a.md", "needle")],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();
        let query = query_index(&index, IndexQuery::full_text("needle"), &cancelled);
        assert_eq!(query.status, OperationStatus::Cancelled);
        assert!(query.results.is_empty());
    }

    #[test]
    fn deadline_bound_token_cancels_without_an_external_watchdog() {
        let token = CancellationToken::with_deadline(Instant::now());

        assert!(token.is_cancelled());
    }

    #[test]
    fn cooperative_cancellation_stops_during_build_and_query() {
        let build_cancellation = CancellationToken::new();
        build_cancellation.cancel_after_checks(2);
        let build = build_index(
            vec![document("a.md", "first"), document("b.md", "second")],
            IndexLimits::default(),
            &build_cancellation,
        );
        assert!(build.is_cancelled());
        assert_eq!(build.report().indexed_files, 1);

        let (index, _) = build_index(
            vec![document("a.md", "needle"), document("b.md", "needle")],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap();
        let query_cancellation = CancellationToken::new();
        query_cancellation.cancel_after_checks(2);
        let query = query_index(&index, IndexQuery::full_text("needle"), &query_cancellation);
        assert_eq!(query.status, OperationStatus::Cancelled);
        assert!(query.results.is_empty());
    }

    #[test]
    fn benchmark_request_can_stop_in_progress_work() {
        let response = run_benchmark_request(BenchmarkRequest {
            documents: vec![document("a.md", "first"), document("b.md", "second")],
            limits: IndexLimits::default(),
            queries: Vec::new(),
            cancel_before_build: false,
            cancel_before_query: false,
            cancel_build_after_checks: Some(2),
            cancel_query_after_checks: None,
            warmup_count: 1,
            sample_count: 2,
        });
        assert_eq!(response.status, OperationStatus::Cancelled);
        assert_eq!(response.build_report.unwrap().indexed_files, 1);
        assert_eq!(response.timing.build_micros.len(), 2);
        assert_eq!(response.timing.cancellation_micros.len(), 2);
    }

    #[test]
    fn discard_and_rebuild_produce_equivalent_results_without_path_authority() {
        let documents = vec![document("nested/a.md", "needle")];
        let limits = IndexLimits::default();
        let (mut index, _) = build_index(documents.clone(), limits, &CancellationToken::new())
            .completed()
            .unwrap();
        let before = query_index(
            &index,
            IndexQuery::full_text("needle"),
            &CancellationToken::new(),
        );
        index.discard();
        assert!(index.is_empty());

        let (rebuilt, _) = build_index(documents, limits, &CancellationToken::new())
            .completed()
            .unwrap();
        let after = query_index(
            &rebuilt,
            IndexQuery::full_text("needle"),
            &CancellationToken::new(),
        );
        assert_eq!(before, after);
        assert_eq!(before.results[0].relative_path, "nested/a.md");
    }

    #[test]
    fn json_runner_is_equivalent_to_direct_production_calls() {
        let request = BenchmarkRequest {
            documents: vec![document("a.md", "needle")],
            limits: IndexLimits::default(),
            queries: vec![IndexQuery::full_text("needle")],
            cancel_before_build: false,
            cancel_before_query: false,
            cancel_build_after_checks: None,
            cancel_query_after_checks: None,
            warmup_count: 2,
            sample_count: 3,
        };
        let response = run_benchmark_request(request.clone());
        let (index, report) =
            build_index(request.documents, request.limits, &CancellationToken::new())
                .completed()
                .unwrap();
        let direct = query_index(
            &index,
            request.queries[0].clone(),
            &CancellationToken::new(),
        );

        assert_eq!(response.implementation_id, INDEX_IMPLEMENTATION_ID);
        assert_eq!(response.schema_id, INDEX_SCHEMA_ID);
        assert_eq!(response.build_report.unwrap(), report);
        assert_eq!(response.queries, vec![direct]);
        assert_eq!(response.timing.warmup_count, 2);
        assert_eq!(response.timing.sample_count, 3);
        assert_eq!(response.timing.build_micros.len(), 3);
        assert_eq!(response.timing.query_micros.len(), 1);
        assert_eq!(response.timing.query_micros[0].len(), 3);
    }
}
