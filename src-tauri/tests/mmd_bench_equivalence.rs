#![cfg(feature = "bench-cli")]

use mmd_lib::workspace_index::{
    run_benchmark_request, BenchmarkRequest, BenchmarkResponse, IndexDocument, IndexLimits,
    IndexQuery, INDEX_IMPLEMENTATION_ID, INDEX_SCHEMA_ID,
};
use std::{fs, process::Command};

#[test]
fn subprocess_matches_direct_production_core_results_and_identity() {
    let directory = tempfile::tempdir().unwrap();
    let request_path = directory.path().join("request.json");
    let output_path = directory.path().join("response.json");
    let request = BenchmarkRequest {
        documents: vec![
            IndexDocument {
                relative_path: "z.md".to_owned(),
                content: "needle".to_owned(),
            },
            IndexDocument {
                relative_path: "a.md".to_owned(),
                content: "needle".to_owned(),
            },
        ],
        limits: IndexLimits::default(),
        queries: vec![IndexQuery::filename("a"), IndexQuery::full_text("needle")],
        cancel_before_build: false,
        cancel_before_query: false,
        cancel_build_after_checks: None,
        cancel_query_after_checks: None,
        warmup_count: 1,
        sample_count: 2,
    };
    fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_mmd_bench"))
        .args(["--request", request_path.to_str().unwrap()])
        .args(["--output", output_path.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(status.success());

    let subprocess: BenchmarkResponse =
        serde_json::from_slice(&fs::read(output_path).unwrap()).unwrap();
    let direct = run_benchmark_request(request);
    assert_eq!(subprocess.implementation_id, direct.implementation_id);
    assert_eq!(subprocess.schema_id, direct.schema_id);
    assert_eq!(subprocess.status, direct.status);
    assert_eq!(subprocess.corpus_digest, direct.corpus_digest);
    assert_eq!(subprocess.limits, direct.limits);
    assert_eq!(subprocess.build_report, direct.build_report);
    assert_eq!(subprocess.queries, direct.queries);
    assert_eq!(subprocess.implementation_id, INDEX_IMPLEMENTATION_ID);
    assert_eq!(subprocess.schema_id, INDEX_SCHEMA_ID);
    assert_eq!(subprocess.timing.build_micros.len(), 2);
    assert!(subprocess
        .timing
        .query_micros
        .iter()
        .all(|samples| samples.len() == 2));
    assert_ne!(subprocess.memory.measurement_kind, "");
}
