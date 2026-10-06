use std::time::Instant;

use super::*;

fn document(path: &str, content: &str) -> IndexDocument {
    IndexDocument {
        relative_path: path.to_owned(),
        content: content.to_owned(),
    }
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
