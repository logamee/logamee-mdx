use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    crash_drafts::{
        CrashDraftCatalog, CrashDraftError, CrashDraftErrorCode, CrashDraftFileKind,
        CrashDraftListEntry, CrashDraftPersistenceDisposition, CrashDraftWriteRequest,
        CrashDraftWriteStatus, ProtectedDraftReason, CRASH_DRAFT_SCHEMA_VERSION,
        MAX_DRAFT_CONTENT_BYTES, MAX_DRAFT_ENTRIES, MAX_DRAFT_TOTAL_BYTES,
    },
    state::AppState,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteCrashDraftRequest {
    document_id: String,
    file_kind: CrashDraftFileKind,
    draft_revision: u64,
    path_hint: Option<String>,
    base_version_token: Option<String>,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftLimitsDto {
    max_draft_bytes: u64,
    max_drafts: u64,
    max_store_bytes: u64,
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
    schema_version: u32,
    catalog_token: String,
    total_bytes: u64,
    entries: Vec<CrashDraftEntryDto>,
    limits: CrashDraftLimitsDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftWriteResponseDto {
    status: WriteStatusDto,
    document_id: String,
    draft_revision: u64,
    entry_token: String,
    updated_at_unix_ms: u64,
    evicted_document_ids: Vec<String>,
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
    document_id: String,
    draft_revision: u64,
    file_kind: CrashDraftFileKind,
    path_hint: Option<String>,
    base_version_token: Option<String>,
    content: String,
    updated_at_unix_ms: u64,
    entry_token: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct MutationStatusDto {
    status: MutationStatus,
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
    removed_entries: u64,
    blocked_entries: u64,
    more_work_remaining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repair_receipt: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashDraftCommandError {
    code: CrashDraftCommandErrorCode,
    message: &'static str,
    can_reset: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repair_receipt: Option<String>,
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

fn store(
    state: &AppState,
) -> Result<&crate::crash_draft_store::ProductionCrashDraftStore, CrashDraftCommandError> {
    state
        .crash_drafts()
        .map_err(|_| command_error(CrashDraftCommandErrorCode::NotInitialized, false, None))
}

#[tauri::command]
pub(crate) fn list_crash_drafts(
    state: State<'_, AppState>,
) -> Result<CrashDraftCatalogDto, CrashDraftCommandError> {
    if let Some(error) = state.take_crash_draft_startup_error() {
        return Err(project_error(error));
    }
    project_catalog(store(&state)?.list().map_err(project_error)?)
}

#[tauri::command]
pub(crate) fn write_crash_draft(
    state: State<'_, AppState>,
    request: WriteCrashDraftRequest,
) -> Result<CrashDraftWriteResponseDto, CrashDraftCommandError> {
    let summary = store(&state)?
        .write(CrashDraftWriteRequest {
            document_id: request.document_id,
            file_kind: request.file_kind,
            revision: request.draft_revision,
            path_hint: request.path_hint,
            base_version_token: request.base_version_token,
            content: request.content,
        })
        .map_err(project_error)?;
    project_write_summary(summary)
}

fn project_write_summary(
    summary: crate::crash_drafts::CrashDraftSummary,
) -> Result<CrashDraftWriteResponseDto, CrashDraftCommandError> {
    if summary.repair_required.is_some() {
        return Err(command_error(
            CrashDraftCommandErrorCode::Indeterminate,
            true,
            summary.repair_receipt,
        ));
    }
    Ok(CrashDraftWriteResponseDto {
        status: match summary.write_status {
            Some(CrashDraftWriteStatus::Stored) => WriteStatusDto::Stored,
            Some(CrashDraftWriteStatus::Unchanged) => WriteStatusDto::Unchanged,
            None => {
                return Err(command_error(
                    CrashDraftCommandErrorCode::Persistence,
                    false,
                    None,
                ))
            }
        },
        document_id: summary.document_id,
        draft_revision: summary.revision,
        entry_token: summary.entry_token,
        updated_at_unix_ms: summary.updated_at_ms,
        evicted_document_ids: summary.evicted_document_ids,
    })
}

#[tauri::command]
pub(crate) fn recover_crash_draft(
    state: State<'_, AppState>,
    document_id: String,
    expected_entry_token: String,
) -> Result<CrashDraftRecoverResponseDto, CrashDraftCommandError> {
    let store = store(&state)?;
    let recovered = match store.recover(&document_id, &expected_entry_token) {
        Ok(recovered) => recovered,
        Err(error) if error.code == CrashDraftErrorCode::Protected => {
            return Err(project_protected_recovery_error(
                store.list().ok(),
                &document_id,
                &expected_entry_token,
            )
            .unwrap_or_else(|| project_error(error)));
        }
        Err(error) => return Err(project_error(error)),
    };
    let envelope = recovered.envelope;
    Ok(CrashDraftRecoverResponseDto {
        document_id: envelope.document_id,
        draft_revision: envelope.revision,
        file_kind: envelope.file_kind,
        path_hint: envelope.path_hint,
        base_version_token: envelope.base_version_token,
        content: envelope.content,
        updated_at_unix_ms: envelope.updated_at_ms,
        entry_token: recovered.entry_token,
    })
}

fn project_protected_recovery_error(
    catalog: Option<CrashDraftCatalog>,
    document_id: &str,
    entry_token: &str,
) -> Option<CrashDraftCommandError> {
    catalog?.entries.into_iter().find_map(|entry| match entry {
        CrashDraftListEntry::Protected {
            document_id: candidate_id,
            entry_token: candidate_token,
            reason,
            ..
        } if candidate_id == document_id && candidate_token == entry_token => Some(command_error(
            if reason == ProtectedDraftReason::UnsupportedSchema {
                CrashDraftCommandErrorCode::UnsupportedVersion
            } else {
                CrashDraftCommandErrorCode::Corrupt
            },
            true,
            None,
        )),
        _ => None,
    })
}

#[tauri::command]
pub(crate) fn discard_crash_draft(
    state: State<'_, AppState>,
    document_id: String,
    expected_entry_token: String,
) -> Result<MutationStatusDto, CrashDraftCommandError> {
    match store(&state)?.discard(&document_id, &expected_entry_token) {
        Ok(()) => Ok(MutationStatusDto {
            status: MutationStatus::ConfirmedDiscarded,
        }),
        Err(error) => mutation_or_error(error),
    }
}

#[tauri::command]
pub(crate) fn reset_crash_drafts(
    state: State<'_, AppState>,
    expected_catalog_token: String,
) -> Result<MutationStatusDto, CrashDraftCommandError> {
    match store(&state)?.reset(&expected_catalog_token) {
        Ok(()) => Ok(MutationStatusDto {
            status: MutationStatus::ConfirmedReset,
        }),
        Err(error) => mutation_or_error(error),
    }
}

#[tauri::command]
pub(crate) fn reset_crash_draft_overflow_batch(
    state: State<'_, AppState>,
    expected_repair_receipt: String,
) -> Result<OverflowResetProgressDto, CrashDraftCommandError> {
    let progress = store(&state)?
        .reset_overflow_batch(&expected_repair_receipt)
        .map_err(project_error)?;
    Ok(OverflowResetProgressDto {
        removed_entries: progress.removed_entries as u64,
        blocked_entries: progress.blocked_entries as u64,
        more_work_remaining: progress.more_work_remaining,
        repair_receipt: progress.repair_receipt,
    })
}

fn mutation_or_error(error: CrashDraftError) -> Result<MutationStatusDto, CrashDraftCommandError> {
    match error.disposition {
        Some(CrashDraftPersistenceDisposition::Conflict) => Ok(MutationStatusDto {
            status: MutationStatus::Conflict,
        }),
        Some(CrashDraftPersistenceDisposition::Indeterminate) => Ok(MutationStatusDto {
            status: MutationStatus::Indeterminate,
        }),
        _ if error.code == CrashDraftErrorCode::Conflict => Ok(MutationStatusDto {
            status: MutationStatus::Conflict,
        }),
        _ => Err(project_error(error)),
    }
}

fn project_catalog(
    catalog: CrashDraftCatalog,
) -> Result<CrashDraftCatalogDto, CrashDraftCommandError> {
    let mut total_bytes = 0u64;
    let mut entries = Vec::with_capacity(catalog.entries.len());
    for entry in catalog.entries {
        let projected = match entry {
            CrashDraftListEntry::Supported { draft } => {
                total_bytes = total_bytes
                    .checked_add(draft.raw_size_bytes)
                    .ok_or_else(|| {
                        command_error(CrashDraftCommandErrorCode::StoreFull, true, None)
                    })?;
                CrashDraftEntryDto::Recoverable {
                    document_id: draft.document_id,
                    draft_revision: draft.revision,
                    updated_at_unix_ms: draft.updated_at_ms,
                    content_bytes: draft.content_bytes,
                    path_hint: draft.path_hint,
                    base_version_token: draft.base_version_token,
                    file_kind: draft.file_kind,
                    entry_token: draft.entry_token,
                }
            }
            CrashDraftListEntry::Protected {
                document_id,
                entry_token,
                reason,
                raw_size_bytes,
                future_schema_version,
            } => {
                total_bytes = total_bytes.checked_add(raw_size_bytes).ok_or_else(|| {
                    command_error(CrashDraftCommandErrorCode::StoreFull, true, None)
                })?;
                match reason {
                    ProtectedDraftReason::UnsupportedSchema => {
                        CrashDraftEntryDto::UnsupportedVersion {
                            document_id,
                            raw_bytes: raw_size_bytes,
                            schema_version: future_schema_version
                                .filter(|value| *value <= 9_007_199_254_740_991)
                                .ok_or_else(|| {
                                    command_error(
                                        CrashDraftCommandErrorCode::UnsupportedVersion,
                                        true,
                                        None,
                                    )
                                })?,
                            entry_token,
                        }
                    }
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
                }
            }
        };
        entries.push(projected);
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

fn project_error(error: CrashDraftError) -> CrashDraftCommandError {
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

fn command_error(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crash_drafts::{CrashDraftSummary, CrashDraftWriteStatus};

    #[test]
    fn command_dtos_serialize_to_the_exact_flat_frontend_schema() {
        let response = CrashDraftWriteResponseDto {
            status: WriteStatusDto::Stored,
            document_id: "0".repeat(32),
            draft_revision: 1,
            entry_token: "a".repeat(64),
            updated_at_unix_ms: 7,
            evicted_document_ids: vec!["1".repeat(32)],
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "status": "stored",
                "documentId": "00000000000000000000000000000000",
                "draftRevision": 1,
                "entryToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "updatedAtUnixMs": 7,
                "evictedDocumentIds": ["11111111111111111111111111111111"]
            })
        );
    }

    #[test]
    fn catalog_projection_counts_raw_bytes_and_flattens_supported_entries() {
        let catalog = CrashDraftCatalog {
            catalog_token: "a".repeat(64),
            entries: vec![CrashDraftListEntry::Supported {
                draft: CrashDraftSummary {
                    document_id: "0".repeat(32),
                    file_kind: CrashDraftFileKind::Markdown,
                    revision: 1,
                    updated_at_ms: 2,
                    path_hint: None,
                    entry_token: "b".repeat(64),
                    base_version_token: None,
                    content_bytes: 3,
                    raw_size_bytes: 41,
                    write_status: Some(CrashDraftWriteStatus::Stored),
                    evicted_document_ids: vec![],
                    recovery_paths: vec![],
                    repair_required: None,
                    repair_receipt: None,
                },
            }],
        };
        let value = serde_json::to_value(project_catalog(catalog).unwrap()).unwrap();
        assert_eq!(value["totalBytes"], 41);
        assert_eq!(value["entries"][0]["status"], "recoverable");
        assert!(value["entries"][0].get("draft").is_none());
        assert!(value["entries"][0].get("contentBytes").is_some());
    }

    #[test]
    fn projected_errors_never_include_core_messages_or_recovery_paths() {
        let error = CrashDraftError {
            code: CrashDraftErrorCode::Persistence,
            message: "/private/path contained secret text".into(),
            disposition: None,
            recovery_paths: vec!["/private/path".into()],
            repair_required: None,
            repair_receipt: None,
        };
        let json = serde_json::to_string(&project_error(error)).unwrap();
        assert!(!json.contains("private"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn protected_recovery_distinguishes_unsupported_versions_from_corruption() {
        let catalog = CrashDraftCatalog {
            catalog_token: "a".repeat(64),
            entries: vec![CrashDraftListEntry::Protected {
                document_id: "0".repeat(32),
                entry_token: "b".repeat(64),
                reason: ProtectedDraftReason::UnsupportedSchema,
                raw_size_bytes: 10,
                future_schema_version: Some(2),
            }],
        };
        let error =
            project_protected_recovery_error(Some(catalog), &"0".repeat(32), &"b".repeat(64))
                .unwrap();
        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            "unsupportedVersion"
        );
    }

    #[test]
    fn completed_overflow_progress_omits_the_final_repair_receipt() {
        let value = serde_json::to_value(OverflowResetProgressDto {
            removed_entries: 1,
            blocked_entries: 0,
            more_work_remaining: false,
            repair_receipt: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "removedEntries": 1,
                "blockedEntries": 0,
                "moreWorkRemaining": false
            })
        );
    }

    #[test]
    fn retained_write_cleanup_is_surfaced_as_opaque_repair_state_not_stored() {
        let receipt = "c".repeat(64);
        let result = project_write_summary(CrashDraftSummary {
            document_id: "0".repeat(32),
            file_kind: CrashDraftFileKind::Markdown,
            revision: 1,
            updated_at_ms: 2,
            path_hint: None,
            entry_token: "b".repeat(64),
            base_version_token: None,
            content_bytes: 3,
            raw_size_bytes: 40,
            write_status: Some(CrashDraftWriteStatus::Stored),
            evicted_document_ids: vec![],
            recovery_paths: vec!["/private/hidden".into()],
            repair_required: Some(crate::crash_drafts::CrashDraftRepairRequired::CleanupRepair),
            repair_receipt: Some(receipt.clone()),
        })
        .unwrap_err();
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["code"], "indeterminate");
        assert_eq!(value["repairReceipt"], receipt);
        assert!(!value.to_string().contains("private"));
    }
}
