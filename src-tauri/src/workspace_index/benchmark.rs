//! Benchmark harness for index build and query operations.
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::cancellation::CancellationToken;
use super::core::{build_index, query_index, IndexQuery, QueryResponse};
use super::helpers::{default_sample_count, elapsed_micros, process_peak_rss_bytes};
use super::{
    BuildReport, IndexDocument, IndexLimits, OperationStatus, WorkspaceIndex,
    INDEX_IMPLEMENTATION_ID, INDEX_SCHEMA_ID, MAX_BENCHMARK_SAMPLES, MAX_BENCHMARK_WARMUPS,
};

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
        let build_cancellation = requested_cancellation(
            request.cancel_before_build,
            request.cancel_build_after_checks,
        );
        let started = Instant::now();
        let outcome = build_index(
            request.documents.clone(),
            request.limits,
            &build_cancellation,
        );
        let elapsed = elapsed_micros(started);
        record_build_sample(&mut timing, measured, elapsed, outcome.is_cancelled());
        final_report = Some(outcome.report().clone());
        let Some((index, _)) = outcome.completed() else {
            final_status = OperationStatus::Cancelled;
            final_queries.clear();
            continue;
        };

        let (iteration_queries, iteration_status) =
            run_iteration_queries(&request, &index, measured, &mut timing);
        if iteration_status == OperationStatus::Cancelled {
            final_status = OperationStatus::Cancelled;
        }
        final_queries = iteration_queries;
    }

    let report = final_report.expect("sample count is clamped to at least one");
    let rss_after = process_peak_rss_bytes();
    benchmark_response(
        report,
        final_status,
        final_queries,
        timing,
        rss_before,
        rss_after,
    )
}

fn requested_cancellation(
    cancel_before: bool,
    cancel_after_checks: Option<usize>,
) -> CancellationToken {
    let token = CancellationToken::new();
    if cancel_before {
        token.cancel();
    }
    if let Some(checks) = cancel_after_checks {
        token.cancel_after_checks(checks);
    }
    token
}

fn record_build_sample(
    timing: &mut BenchmarkTiming,
    measured: bool,
    elapsed: u64,
    cancelled: bool,
) {
    if measured {
        timing.build_micros.push(elapsed);
        if cancelled {
            timing.cancellation_micros.push(elapsed);
        }
    }
}

fn run_iteration_queries(
    request: &BenchmarkRequest,
    index: &WorkspaceIndex,
    measured: bool,
    timing: &mut BenchmarkTiming,
) -> (Vec<QueryResponse>, OperationStatus) {
    let mut iteration_queries = Vec::with_capacity(request.queries.len());
    let mut iteration_status = OperationStatus::Completed;
    for (query_index_number, query) in request.queries.iter().cloned().enumerate() {
        let query_cancellation = requested_cancellation(
            request.cancel_before_query,
            request.cancel_query_after_checks,
        );
        let started = Instant::now();
        let response = query_index(index, query, &query_cancellation);
        let elapsed = elapsed_micros(started);
        if measured {
            timing.query_micros[query_index_number].push(elapsed);
            if response.status == OperationStatus::Cancelled {
                timing.cancellation_micros.push(elapsed);
            }
        }
        if response.status == OperationStatus::Cancelled {
            iteration_status = OperationStatus::Cancelled;
        }
        iteration_queries.push(response);
    }
    (iteration_queries, iteration_status)
}

fn benchmark_response(
    report: BuildReport,
    status: OperationStatus,
    queries: Vec<QueryResponse>,
    timing: BenchmarkTiming,
    rss_before: Option<u64>,
    rss_after: Option<u64>,
) -> BenchmarkResponse {
    let estimated_index_bytes = report.estimated_index_bytes;
    let peak_incremental_bytes = rss_before
        .zip(rss_after)
        .map(|(before, after)| after.saturating_sub(before));
    BenchmarkResponse {
        implementation_id: INDEX_IMPLEMENTATION_ID.to_owned(),
        schema_id: INDEX_SCHEMA_ID.to_owned(),
        status,
        corpus_digest: report.corpus_digest.clone(),
        limits: report.limits,
        build_report: Some(report),
        queries,
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
