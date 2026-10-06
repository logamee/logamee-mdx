pub(crate) use std::{
    fmt::Debug,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use sha2::{Digest, Sha256};

pub(crate) const CRASH_DRAFT_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_DRAFT_CONTENT_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const MAX_DRAFT_ENVELOPE_BYTES: usize = MAX_DRAFT_CONTENT_BYTES + 64 * 1024;
pub(crate) const MAX_DRAFT_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_DRAFT_ENTRIES: usize = 16;
pub(crate) const MAX_PATH_HINT_BYTES: usize = 32 * 1024;
pub(crate) const MAX_CRASH_DRAFT_DIRECTORY_ENTRIES: usize = 64;
pub(crate) const OVERFLOW_RESET_DELETE_BATCH: usize = 16;
pub(crate) const OVERFLOW_RESET_SCAN_BATCH: usize = 64;
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const LOCK_FILE_NAME: &str = ".lock";
#[cfg(any(windows, test))]
const PRIVATE_DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
#[cfg(any(windows, test))]
const PRIVATE_FILE_SDDL: &str = "D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrashDraftFileKind {
    Markdown,
    Html,
    Excalidraw,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrashDraftEnvelope {
    pub(crate) schema_version: u32,
    pub(crate) document_id: String,
    pub(crate) file_kind: CrashDraftFileKind,
    pub(crate) revision: u64,
    pub(crate) updated_at_ms: u64,
    pub(crate) path_hint: Option<String>,
    pub(crate) base_version_token: Option<String>,
    pub(crate) content: String,
    pub(crate) checksum: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CrashDraftWriteRequest {
    pub(crate) document_id: String,
    pub(crate) file_kind: CrashDraftFileKind,
    pub(crate) revision: u64,
    pub(crate) path_hint: Option<String>,
    pub(crate) base_version_token: Option<String>,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftSummary {
    pub(crate) document_id: String,
    pub(crate) file_kind: CrashDraftFileKind,
    pub(crate) revision: u64,
    pub(crate) updated_at_ms: u64,
    pub(crate) path_hint: Option<String>,
    pub(crate) entry_token: String,
    #[serde(skip)]
    pub(crate) base_version_token: Option<String>,
    #[serde(skip)]
    pub(crate) content_bytes: u64,
    #[serde(skip)]
    pub(crate) raw_size_bytes: u64,
    #[serde(skip)]
    pub(crate) write_status: Option<CrashDraftWriteStatus>,
    #[serde(skip)]
    pub(crate) evicted_document_ids: Vec<String>,
    #[serde(skip)]
    pub(crate) recovery_paths: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_required: Option<CrashDraftRepairRequired>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_receipt: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CrashDraftWriteStatus {
    Stored,
    Unchanged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProtectedDraftReason {
    Corrupt,
    Oversized,
    UnsupportedSchema,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum CrashDraftListEntry {
    Supported {
        draft: CrashDraftSummary,
    },
    Protected {
        document_id: String,
        entry_token: String,
        reason: ProtectedDraftReason,
        #[serde(skip)]
        raw_size_bytes: u64,
        #[serde(skip)]
        future_schema_version: Option<u64>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftCatalog {
    pub(crate) entries: Vec<CrashDraftListEntry>,
    pub(crate) catalog_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftOverflowResetProgress {
    pub(crate) removed_entries: usize,
    pub(crate) blocked_entries: usize,
    pub(crate) more_work_remaining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_receipt: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecoveredCrashDraft {
    pub(crate) envelope: CrashDraftEnvelope,
    pub(crate) entry_token: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrashDraftErrorCode {
    Invalid,
    Oversized,
    Capacity,
    Conflict,
    NotFound,
    Protected,
    Persistence,
    Indeterminate,
    CommittedNeedsRepair,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrashDraftPersistenceDisposition {
    ConfirmedCommitted,
    ConfirmedNotCommitted,
    Conflict,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrashDraftRepairRequired {
    LimitRepair,
    PrivacyRepair,
    CleanupRepair,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftError {
    pub(crate) code: CrashDraftErrorCode,
    pub(crate) message: String,
    pub(crate) disposition: Option<CrashDraftPersistenceDisposition>,
    #[serde(skip)]
    pub(crate) recovery_paths: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_required: Option<CrashDraftRepairRequired>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repair_receipt: Option<String>,
}

impl CrashDraftError {
    fn plain(code: CrashDraftErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            disposition: None,
            recovery_paths: Vec::new(),
            repair_required: None,
            repair_receipt: None,
        }
    }

    fn persistence() -> Self {
        Self::plain(
            CrashDraftErrorCode::Persistence,
            "crash draft storage operation failed",
        )
    }

    fn mutation(
        code: CrashDraftErrorCode,
        disposition: CrashDraftPersistenceDisposition,
        recovery_paths: Vec<PathBuf>,
    ) -> Self {
        let message = match disposition {
            CrashDraftPersistenceDisposition::ConfirmedCommitted => {
                "crash draft was committed but storage cleanup still requires repair"
            }
            CrashDraftPersistenceDisposition::ConfirmedNotCommitted => {
                "crash draft storage confirmed that the requested change was not committed"
            }
            CrashDraftPersistenceDisposition::Conflict => {
                "crash draft storage changed before the requested operation could commit"
            }
            CrashDraftPersistenceDisposition::Indeterminate => {
                "crash draft storage could not determine whether the requested operation committed"
            }
        };
        let repair_required =
            (!recovery_paths.is_empty()).then_some(CrashDraftRepairRequired::CleanupRepair);
        let repair_receipt = repair_receipt(disposition_label(disposition), &recovery_paths);
        Self {
            code,
            message: message.to_string(),
            disposition: Some(disposition),
            recovery_paths,
            repair_required,
            repair_receipt,
        }
    }
}


mod ports;
mod private_dirs;
#[cfg(windows)]
mod private_dirs_windows;
#[cfg(windows)]
mod windows_dacl;
mod scan;
pub(crate) use ports::*;
pub(crate) use repair::{PendingRepair, PendingRepairKind};
pub(crate) use scan::*;
pub(crate) use tokens::*;
pub(crate) use validate::*;
pub(crate) use private_dirs::*;
#[cfg(windows)]
pub(crate) use private_dirs_windows::*;
#[cfg(windows)]
pub(crate) use windows_dacl::*;
mod repair;
mod reset;
mod store;
mod store_internals;
mod tokens;
mod validate;
#[cfg(test)]
mod test_prelude;
#[cfg(test)]
mod group0_tests;
#[cfg(test)]
mod group1_tests;
#[cfg(test)]
mod group2_tests;
#[cfg(test)]
mod group3_tests;

pub(crate) struct CrashDraftStore<W, C> {
    root: PathBuf,
    writer: W,
    clock: C,
    runtime_lock: Mutex<()>,
    overflow_reset_token: Mutex<Option<PendingRepair>>,
}
