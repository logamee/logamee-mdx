use mmd_lib::workspace_index::{run_benchmark_request, BenchmarkRequest};
use std::{env, fs, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    match run(env::args().skip(1)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mmd_bench: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: impl IntoIterator<Item = String>) -> Result<(), String> {
    let (request_path, output_path) = parse_paths(arguments)?;
    let bytes = fs::read(&request_path)
        .map_err(|error| format!("cannot read request {}: {error}", request_path.display()))?;
    let request: BenchmarkRequest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid request {}: {error}", request_path.display()))?;
    let response = run_benchmark_request(request);
    let output = serde_json::to_vec_pretty(&response)
        .map_err(|error| format!("cannot serialize response: {error}"))?;
    fs::write(&output_path, output)
        .map_err(|error| format!("cannot write output {}: {error}", output_path.display()))
}

fn parse_paths(arguments: impl IntoIterator<Item = String>) -> Result<(PathBuf, PathBuf), String> {
    let mut arguments = arguments.into_iter();
    let mut request = None;
    let mut output = None;
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {argument}"))?;
        match argument.as_str() {
            "--request" => request = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {argument}")),
        }
    }
    Ok((
        request.ok_or_else(|| "--request is required".to_owned())?,
        output.ok_or_else(|| "--output is required".to_owned())?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mmd_lib::workspace_index::{
        IndexDocument, IndexLimits, IndexQuery, INDEX_IMPLEMENTATION_ID, INDEX_SCHEMA_ID,
    };

    #[test]
    fn cli_reports_the_same_production_identity_and_results() {
        let directory = tempfile::tempdir().unwrap();
        let request_path = directory.path().join("request.json");
        let output_path = directory.path().join("response.json");
        let request = BenchmarkRequest {
            documents: vec![IndexDocument {
                relative_path: "a.md".to_owned(),
                content: "needle".to_owned(),
            }],
            limits: IndexLimits::default(),
            queries: vec![IndexQuery::full_text("needle")],
            cancel_before_build: false,
            cancel_before_query: false,
            cancel_build_after_checks: None,
            cancel_query_after_checks: None,
            warmup_count: 1,
            sample_count: 2,
        };
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

        run([
            "--request".to_owned(),
            request_path.to_string_lossy().into_owned(),
            "--output".to_owned(),
            output_path.to_string_lossy().into_owned(),
        ])
        .unwrap();

        let cli_response: mmd_lib::workspace_index::BenchmarkResponse =
            serde_json::from_slice(&fs::read(output_path).unwrap()).unwrap();
        let direct_response = run_benchmark_request(request);
        assert_eq!(
            cli_response.implementation_id,
            direct_response.implementation_id
        );
        assert_eq!(cli_response.schema_id, direct_response.schema_id);
        assert_eq!(cli_response.status, direct_response.status);
        assert_eq!(cli_response.corpus_digest, direct_response.corpus_digest);
        assert_eq!(cli_response.limits, direct_response.limits);
        assert_eq!(cli_response.build_report, direct_response.build_report);
        assert_eq!(cli_response.queries, direct_response.queries);
        assert_eq!(cli_response.implementation_id, INDEX_IMPLEMENTATION_ID);
        assert_eq!(cli_response.schema_id, INDEX_SCHEMA_ID);
        assert_eq!(cli_response.timing.build_micros.len(), 2);
        assert_eq!(cli_response.timing.query_micros[0].len(), 2);
        assert_ne!(cli_response.memory.measurement_kind, "");
    }
}
