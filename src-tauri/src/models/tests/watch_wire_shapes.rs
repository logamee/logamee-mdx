//! Stage helpers that build the active document watch wire-shape values
//! (registrations, snapshot envelopes, state and health events) compared
//! against the shared JSON fixtures.

use serde_json::{json, Value};

use super::super::fixtures::*;
use super::super::*;

pub(super) fn active_document_watch() -> Value {
    json!({
        "registration_present_text": registration_present_text(),
        "registration_present_pdf": registration_present_pdf(),
        "registration_missing": registration_missing(),
        "snapshot_resync": snapshot_resync_envelope(),
        "state_changed": state_changed_event(),
        "state_renamed": state_renamed_event(),
        "state_missing": state_missing_event(),
        "health_degraded": health_degraded_event(),
        "health_failed": health_failed_event(),
    })
}

fn watch_registration(
    watch_id: &str,
    document_id: &str,
    document_generation: u64,
    snapshot: ActiveDocumentDiskSnapshot,
) -> ActiveDocumentWatchRegistration {
    ActiveDocumentWatchRegistration {
        protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
        watch_id: watch_id.to_string(),
        document_id: document_id.to_string(),
        document_generation,
        sequence: 1,
        snapshot,
    }
}

fn watch_envelope(
    sequence: u64,
    reason: ActiveDocumentWatchReason,
    snapshot: ActiveDocumentDiskSnapshot,
) -> ActiveDocumentWatchSnapshotEnvelope {
    ActiveDocumentWatchSnapshotEnvelope {
        protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
        watch_id: "watch-1".to_string(),
        document_id: "pane-document-1".to_string(),
        document_generation: 7,
        sequence,
        reason,
        previous_path: None,
        snapshot,
    }
}

fn watch_event(sequence: u64, event: ActiveDocumentWatchEventPayload) -> ActiveDocumentWatchEvent {
    ActiveDocumentWatchEvent {
        protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
        watch_id: "watch-1".to_string(),
        document_id: "pane-document-1".to_string(),
        document_generation: 7,
        sequence,
        event,
    }
}

fn state_event_payload(
    reason: ActiveDocumentWatchReason,
    previous_path: Option<String>,
    snapshot: ActiveDocumentDiskSnapshot,
) -> ActiveDocumentWatchEventPayload {
    ActiveDocumentWatchEventPayload::State {
        reason,
        previous_path,
        snapshot,
    }
}

fn present_notes_snapshot(
    length: &str,
    modified_nanos: &str,
    sha256_letter: char,
    content: &str,
    preview_revision: u64,
) -> ActiveDocumentDiskSnapshot {
    ActiveDocumentDiskSnapshot::Present {
        file: markdown_open_file_response(
            "/workspace/notes.md",
            length,
            modified_nanos,
            sha256_letter,
            content,
        ),
        preview_revision,
    }
}

fn registration_present_text() -> ActiveDocumentWatchRegistration {
    watch_registration(
        "watch-1",
        "pane-document-1",
        7,
        present_notes_snapshot("10", "3", 'c', "# External", 1),
    )
}

fn registration_present_pdf() -> ActiveDocumentWatchRegistration {
    watch_registration(
        "watch-2",
        "pane-document-2",
        8,
        ActiveDocumentDiskSnapshot::Present {
            file: OpenFileResponse {
                kind: WorkspaceFileKind::Pdf,
                path: "/workspace/document.pdf".to_string(),
                content_mode: ContentMode::Binary,
                file_version: None,
                content: None,
                mime_type: Some("application/pdf".to_string()),
                bytes_base64: Some("AQ==".to_string()),
            },
            preview_revision: 1,
        },
    )
}

fn registration_missing() -> ActiveDocumentWatchRegistration {
    watch_registration(
        "watch-3",
        "pane-document-3",
        9,
        ActiveDocumentDiskSnapshot::Missing {
            path: "/workspace/missing.md".to_string(),
        },
    )
}

fn snapshot_resync_envelope() -> ActiveDocumentWatchSnapshotEnvelope {
    watch_envelope(
        2,
        ActiveDocumentWatchReason::Resync,
        present_notes_snapshot("10", "4", 'd', "# Resynced", 2),
    )
}

fn state_changed_event() -> ActiveDocumentWatchEvent {
    watch_event(
        3,
        state_event_payload(
            ActiveDocumentWatchReason::Changed,
            None,
            present_notes_snapshot("9", "5", 'e', "# Changed", 3),
        ),
    )
}

fn state_renamed_event() -> ActiveDocumentWatchEvent {
    watch_event(
        4,
        state_event_payload(
            ActiveDocumentWatchReason::Renamed,
            Some("/workspace/notes.md".to_string()),
            ActiveDocumentDiskSnapshot::Present {
                file: markdown_open_file_response(
                    "/workspace/renamed.md",
                    "9",
                    "6",
                    'f',
                    "# Renamed",
                ),
                preview_revision: 4,
            },
        ),
    )
}

fn state_missing_event() -> ActiveDocumentWatchEvent {
    watch_event(
        5,
        state_event_payload(
            ActiveDocumentWatchReason::Missing,
            None,
            ActiveDocumentDiskSnapshot::Missing {
                path: "/workspace/renamed.md".to_string(),
            },
        ),
    )
}

fn health_degraded_event() -> ActiveDocumentWatchEvent {
    watch_event(
        6,
        ActiveDocumentWatchEventPayload::Health {
            status: ActiveDocumentWatchHealthStatus::Degraded,
            message: "Monitoring is temporarily retrying.".to_string(),
        },
    )
}

fn health_failed_event() -> ActiveDocumentWatchEvent {
    watch_event(
        7,
        ActiveDocumentWatchEventPayload::Health {
            status: ActiveDocumentWatchHealthStatus::Failed,
            message: "Monitoring stopped. Reopen the file to retry.".to_string(),
        },
    )
}
