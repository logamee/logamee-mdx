use serde::{Deserialize, Serialize};

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


mod benchmark;
mod cancellation;
mod core;
mod helpers;
#[cfg(test)]
mod cancellation_tests;
#[cfg(test)]
mod tests;

pub use benchmark::{run_benchmark_request, BenchmarkRequest, BenchmarkResponse, BenchmarkTiming, MemoryMeasurement};
pub use cancellation::CancellationToken;
pub use core::{build_index, query_index, IndexQuery, QueryKind, QueryLocation, QueryResult, QueryResponse};
use helpers::normalize_for_search;
