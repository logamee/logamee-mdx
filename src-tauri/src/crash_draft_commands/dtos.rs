use serde::{Deserialize, Serialize};

use crate::crash_drafts::CrashDraftFileKind;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteCrashDraftRequest {
    pub(crate) document_id: String,
    pub(crate) file_kind: CrashDraftFileKind,
    pub(crate) draft_revision: u64,
    pub(crate) path_hint: Option<String>,
    pub(crate) base_version_token: Option<String>,
    pub(crate) content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftLimitsDto {
    pub(crate) max_draft_bytes: u64,
    pub(crate) max_drafts: u64,
    pub(crate) max_store_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CrashDraftEntryDto {
    Recoverable {
        document_id: String,
        draft_revision: u64,
        updated_at_unix_ms: u64,
        content_bytes: u64,
        path_hint: Option<String>,
        base_version_token: Option<String>,
        file_kind: CrashDraftFileKind,
        entry_token: String,
    },
    Corrupt {
        document_id: String,
        raw_bytes: u64,
        reason: CorruptReasonDto,
        entry_token: String,
    },
    UnsupportedVersion {
        document_id: String,
        raw_bytes: u64,
        schema_version: u64,
        entry_token: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CorruptReasonDto {
    InvalidMetadata,
    Oversized,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftCatalogDto {
    pub(crate) schema_version: u32,
    pub(crate) catalog_token: String,
    pub(crate) total_bytes: u64,
    pub(crate) entries: Vec<CrashDraftEntryDto>,
    pub(crate) limits: CrashDraftLimitsDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftWriteResponseDto {
    pub(crate) status: WriteStatusDto,
    pub(crate) document_id: String,
    pub(crate) draft_revision: u64,
    pub(crate) entry_token: String,
    pub(crate) updated_at_unix_ms: u64,
    pub(crate) evicted_document_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WriteStatusDto {
    Stored,
    Unchanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftRecoverResponseDto {
    pub(crate) document_id: String,
    pub(crate) draft_revision: u64,
    pub(crate) file_kind: CrashDraftFileKind,
    pub(crate) path_hint: Option<String>,
    pub(crate) base_version_token: Option<String>,
    pub(crate) content: String,
    pub(crate) updated_at_unix_ms: u64,
    pub(crate) entry_token: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct MutationStatusDto {
    pub(crate) status: MutationStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MutationStatus {
    ConfirmedDiscarded,
    ConfirmedReset,
    Conflict,
    Indeterminate,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverflowResetProgressDto {
    pub(crate) removed_entries: u64,
    pub(crate) blocked_entries: u64,
    pub(crate) more_work_remaining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_receipt: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftCommandError {
    pub(crate) code: CrashDraftCommandErrorCode,
    pub(crate) message: &'static str,
    pub(crate) can_reset: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_receipt: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrashDraftCommandErrorCode {
    InvalidRequest,
    Oversized,
    StoreFull,
    RevisionConflict,
    Corrupt,
    UnsupportedVersion,
    NotFound,
    Persistence,
    Indeterminate,
    NotInitialized,
}
