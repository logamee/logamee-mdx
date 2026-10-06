use serde::Serialize;

use super::OpenFileResponse;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum ActiveDocumentDiskSnapshot {
    Present {
        file: OpenFileResponse,
        preview_revision: u64,
    },
    Missing {
        path: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActiveDocumentWatchReason {
    Changed,
    Renamed,
    Resync,
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ActiveDocumentWatchRegistration {
    pub(crate) protocol_version: u8,
    pub(crate) watch_id: String,
    pub(crate) document_id: String,
    pub(crate) document_generation: u64,
    pub(crate) sequence: u64,
    pub(crate) snapshot: ActiveDocumentDiskSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ActiveDocumentWatchSnapshotEnvelope {
    pub(crate) protocol_version: u8,
    pub(crate) watch_id: String,
    pub(crate) document_id: String,
    pub(crate) document_generation: u64,
    pub(crate) sequence: u64,
    pub(crate) reason: ActiveDocumentWatchReason,
    pub(crate) previous_path: Option<String>,
    pub(crate) snapshot: ActiveDocumentDiskSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActiveDocumentWatchHealthStatus {
    Degraded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ActiveDocumentWatchEventPayload {
    State {
        reason: ActiveDocumentWatchReason,
        previous_path: Option<String>,
        snapshot: ActiveDocumentDiskSnapshot,
    },
    Health {
        status: ActiveDocumentWatchHealthStatus,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ActiveDocumentWatchEvent {
    pub(crate) protocol_version: u8,
    pub(crate) watch_id: String,
    pub(crate) document_id: String,
    pub(crate) document_generation: u64,
    pub(crate) sequence: u64,
    pub(crate) event: ActiveDocumentWatchEventPayload,
}
