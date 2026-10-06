mod dtos;
mod projections;

pub(crate) use dtos::*;
use projections::{command_error, project_catalog, project_error};

use tauri::State;

use crate::{
    crash_drafts::{
        CrashDraftCatalog, CrashDraftError, CrashDraftErrorCode, CrashDraftListEntry,
        ProtectedDraftReason, CrashDraftPersistenceDisposition, CrashDraftWriteStatus,
        CrashDraftWriteRequest,
    },
    state::AppState,
};

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

#[cfg(test)]
mod tests;
