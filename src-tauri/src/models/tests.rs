use serde_json::{json, Value};

use super::fixtures::*;

mod watch_wire_shapes;
mod wire_shapes;

#[test]
fn rust_serde_and_watch_wire_shapes_match_shared_json_fixtures() {
    let canonical: Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/tauri-wire/canonical.json"
    ))
    .unwrap();
    let malformed: Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/tauri-wire/malformed.json"
    ))
    .unwrap();

    let actual = json!({
        "open_file_responses": open_file_responses(),
        "snapshot_receipts": wire_shapes::snapshot_receipts(),
        "mutation_outcomes": wire_shapes::mutation_outcomes(),
        "prepared_open_file_response": wire_shapes::prepared_open_file_response(),
        "recent_files_snapshot": wire_shapes::recent_files_snapshot(),
        "open_commit_results": wire_shapes::open_commit_results(),
        "open_commit_statuses": wire_shapes::open_commit_statuses(),
        "active_document_watch": watch_wire_shapes::active_document_watch(),
    });

    assert_eq!(actual, canonical);
    assert_ne!(
        actual["snapshot_receipts"]["fresh"],
        malformed["externally_tagged_snapshot_receipt"]
    );
    assert_ne!(
        actual["mutation_outcomes"]["confirmed_committed"],
        malformed["tuple_mutation_outcome"]
    );
}
