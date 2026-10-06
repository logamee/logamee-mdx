//! Projection of crash-draft core results into flat frontend DTOs.
use super::dtos::{
    CrashDraftCatalogDto, CrashDraftCommandError, CrashDraftCommandErrorCode, CrashDraftEntryDto,
    CorruptReasonDto, CrashDraftLimitsDto,
};
use crate::crash_drafts::{
    CrashDraftCatalog, CrashDraftError, CrashDraftErrorCode, CrashDraftListEntry,
    ProtectedDraftReason, CRASH_DRAFT_SCHEMA_VERSION,
    MAX_DRAFT_CONTENT_BYTES, MAX_DRAFT_ENTRIES, MAX_DRAFT_TOTAL_BYTES,
};

pub(super) fn project_catalog(
    catalog: CrashDraftCatalog,
) -> Result<CrashDraftCatalogDto, CrashDraftCommandError> {
    let mut total_bytes = 0u64;
    let mut entries = Vec::with_capacity(catalog.entries.len());
    for entry in catalog.entries {
        entries.push(project_list_entry(entry, &mut total_bytes)?);
    }
    if total_bytes > MAX_DRAFT_TOTAL_BYTES || entries.len() > MAX_DRAFT_ENTRIES {
        return Err(command_error(
            CrashDraftCommandErrorCode::StoreFull,
            true,
            None,
        ));
    }
    Ok(CrashDraftCatalogDto {
        schema_version: CRASH_DRAFT_SCHEMA_VERSION,
        catalog_token: catalog.catalog_token,
        total_bytes,
        entries,
        limits: CrashDraftLimitsDto {
            max_draft_bytes: MAX_DRAFT_CONTENT_BYTES as u64,
            max_drafts: MAX_DRAFT_ENTRIES as u64,
            max_store_bytes: MAX_DRAFT_TOTAL_BYTES,
        },
    })
}

fn project_list_entry(
    entry: CrashDraftListEntry,
    total_bytes: &mut u64,
) -> Result<CrashDraftEntryDto, CrashDraftCommandError> {
    match entry {
        CrashDraftListEntry::Supported { draft } => {
            *total_bytes = (*total_bytes)
                .checked_add(draft.raw_size_bytes)
                .ok_or_else(|| command_error(CrashDraftCommandErrorCode::StoreFull, true, None))?;
            Ok(CrashDraftEntryDto::Recoverable {
                document_id: draft.document_id,
                draft_revision: draft.revision,
                updated_at_unix_ms: draft.updated_at_ms,
                content_bytes: draft.content_bytes,
                path_hint: draft.path_hint,
                base_version_token: draft.base_version_token,
                file_kind: draft.file_kind,
                entry_token: draft.entry_token,
            })
        }
        CrashDraftListEntry::Protected {
            document_id,
            entry_token,
            reason,
            raw_size_bytes,
            future_schema_version,
        } => {
            *total_bytes = (*total_bytes).checked_add(raw_size_bytes).ok_or_else(|| {
                command_error(CrashDraftCommandErrorCode::StoreFull, true, None)
            })?;
            project_protected_entry(
                document_id,
                entry_token,
                reason,
                raw_size_bytes,
                future_schema_version,
            )
        }
    }
}

fn project_protected_entry(
    document_id: String,
    entry_token: String,
    reason: ProtectedDraftReason,
    raw_size_bytes: u64,
    future_schema_version: Option<u64>,
) -> Result<CrashDraftEntryDto, CrashDraftCommandError> {
    Ok(match reason {
        ProtectedDraftReason::UnsupportedSchema => CrashDraftEntryDto::UnsupportedVersion {
            document_id,
            raw_bytes: raw_size_bytes,
            schema_version: future_schema_version
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    command_error(CrashDraftCommandErrorCode::UnsupportedVersion, true, None)
                })?,
            entry_token,
        },
        ProtectedDraftReason::Oversized => CrashDraftEntryDto::Corrupt {
            document_id,
            raw_bytes: raw_size_bytes,
            reason: CorruptReasonDto::Oversized,
            entry_token,
        },
        ProtectedDraftReason::Corrupt => CrashDraftEntryDto::Corrupt {
            document_id,
            raw_bytes: raw_size_bytes,
            reason: CorruptReasonDto::InvalidMetadata,
            entry_token,
        },
    })
}

pub(super) fn project_error(error: CrashDraftError) -> CrashDraftCommandError {
    let (code, can_reset) = match error.code {
        CrashDraftErrorCode::Invalid => (CrashDraftCommandErrorCode::InvalidRequest, false),
        CrashDraftErrorCode::Oversized => (CrashDraftCommandErrorCode::Oversized, false),
        CrashDraftErrorCode::Capacity => (
            CrashDraftCommandErrorCode::StoreFull,
            error.repair_receipt.is_some(),
        ),
        CrashDraftErrorCode::Conflict => (CrashDraftCommandErrorCode::RevisionConflict, false),
        CrashDraftErrorCode::NotFound => (CrashDraftCommandErrorCode::NotFound, false),
        CrashDraftErrorCode::Protected => (CrashDraftCommandErrorCode::Corrupt, true),
        CrashDraftErrorCode::Persistence => (CrashDraftCommandErrorCode::Persistence, true),
        CrashDraftErrorCode::Indeterminate | CrashDraftErrorCode::CommittedNeedsRepair => {
            (CrashDraftCommandErrorCode::Indeterminate, true)
        }
    };
    command_error(code, can_reset, error.repair_receipt)
}

pub(super) fn command_error(
    code: CrashDraftCommandErrorCode,
    can_reset: bool,
    repair_receipt: Option<String>,
) -> CrashDraftCommandError {
    let message = match code {
        CrashDraftCommandErrorCode::InvalidRequest => "The crash draft request was rejected.",
        CrashDraftCommandErrorCode::Oversized => "The crash draft is too large to store.",
        CrashDraftCommandErrorCode::StoreFull => "Crash draft storage is full.",
        CrashDraftCommandErrorCode::RevisionConflict => {
            "The crash draft changed before the operation completed."
        }
        CrashDraftCommandErrorCode::Corrupt => {
            "The crash draft is damaged and cannot be recovered."
        }
        CrashDraftCommandErrorCode::UnsupportedVersion => {
            "The crash draft was created by a newer application version."
        }
        CrashDraftCommandErrorCode::NotFound => "The crash draft is no longer available.",
        CrashDraftCommandErrorCode::Persistence => "Crash draft storage is unavailable.",
        CrashDraftCommandErrorCode::Indeterminate => {
            "The crash draft operation could not be confirmed."
        }
        CrashDraftCommandErrorCode::NotInitialized => "Crash recovery is not initialized.",
    };
    CrashDraftCommandError {
        code,
        message,
        can_reset,
        repair_receipt,
    }
}
