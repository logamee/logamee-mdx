//! Stage helpers that build the non-watch wire-shape values compared against
//! the shared JSON fixtures in
//! `rust_serde_and_watch_wire_shapes_match_shared_json_fixtures`.

use serde_json::{json, Value};

use super::super::fixtures::*;
use super::super::*;

pub(super) fn snapshot_receipts() -> Value {
    json!({
        "fresh": SnapshotReceipt::Fresh {
            snapshot: fixture_snapshot(),
        },
        "stale": SnapshotReceipt::<FixtureWorkspaceSnapshot>::Stale {
            workspace_token: "workspace-7".to_string(),
            repair_reason: "workspace refresh failed".to_string(),
        },
        "not_applicable": SnapshotReceipt::<FixtureWorkspaceSnapshot>::NotApplicable,
    })
}

pub(super) fn mutation_outcomes() -> Value {
    json!({
        "confirmed_not_committed":
            MutationOutcome::<Value, FixtureWorkspaceSnapshot>::ConfirmedNotCommitted {
                message: "target already exists".to_string(),
            },
        "confirmed_committed": MutationOutcome::ConfirmedCommitted {
            receipt: MutationCommitReceipt {
                committed: json!({ "path": "/workspace/notes.md" }),
                workspace: SnapshotReceipt::Fresh {
                    snapshot: fixture_snapshot(),
                },
            },
        },
        "indeterminate": MutationOutcome::<Value, FixtureWorkspaceSnapshot>::Indeterminate {
            operation: MutationKind::Rename,
            paths: vec![
                "/workspace/old.md".to_string(),
                "/workspace/new.md".to_string(),
            ],
            recovery_message: "reopen the workspace before retrying".to_string(),
        },
    })
}

pub(super) fn prepared_open_file_response() -> PreparedOpenFileResponse {
    PreparedOpenFileResponse {
        file: markdown_open_file_response("/workspace/notes.md", "7", "1", 'a', "# Notes"),
        open_receipt: "11111111111111111111111111111111".to_string(),
        commit_operation_id: "22222222222222222222222222222222".to_string(),
    }
}

pub(super) fn recent_files_snapshot() -> RecentFilesSnapshot {
    RecentFilesSnapshot {
        entries: vec![
            recent_file_summary("33333333333333333333333333333333", "notes.md"),
            recent_file_summary("44444444444444444444444444444444", "page.xhtml"),
        ],
    }
}

pub(super) fn open_commit_results() -> Value {
    json!({
        "committed": OpenCommitResult::Committed {
            recent_files: notes_recent_files(),
        },
        "not_committed": OpenCommitResult::NotCommitted {
            message: "The file could not be finalized. Please try again.".to_string(),
        },
    })
}

pub(super) fn open_commit_statuses() -> Value {
    json!({
        "pending": OpenCommitStatus::Pending,
        "committed": OpenCommitStatus::Committed {
            recent_files: notes_recent_files(),
        },
        "not_committed": OpenCommitStatus::NotCommitted {
            message: "The file could not be finalized. Please try again.".to_string(),
        },
        "unknown": OpenCommitStatus::Unknown,
    })
}

fn recent_file_summary(id: &str, display_name: &str) -> RecentFileSummary {
    RecentFileSummary {
        id: id.to_string(),
        display_name: display_name.to_string(),
    }
}

fn notes_recent_files() -> RecentFilesSnapshot {
    RecentFilesSnapshot {
        entries: vec![recent_file_summary(
            "33333333333333333333333333333333",
            "notes.md",
        )],
    }
}
