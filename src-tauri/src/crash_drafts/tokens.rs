//! Checksums, tokens, outcome mapping and repair receipts.
use super::*;
use crate::private_fs::lowercase_hex;

pub(crate) fn entry_token(bytes: &[u8], size: u64, version_token: &str) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft-entry\0\x01");
    frame_field(&mut frame, &size.to_be_bytes());
    frame_field(&mut frame, version_token.as_bytes());
    frame_field(&mut frame, bytes);
    lowercase_hex(&Sha256::digest(frame))
}

pub(crate) fn catalog_token<V>(entries: &[ScannedEntry<V>]) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft-catalog\0\x01");
    for entry in entries {
        frame_field(&mut frame, entry.id().as_bytes());
        frame_field(&mut frame, entry.token().as_bytes());
        frame_field(&mut frame, &entry.size().to_be_bytes());
    }
    lowercase_hex(&Sha256::digest(frame))
}

pub(crate) fn summary_from_supported(
    envelope: &CrashDraftEnvelope,
    token: &str,
    raw_size_bytes: u64,
) -> CrashDraftSummary {
    CrashDraftSummary {
        document_id: envelope.document_id.clone(),
        file_kind: envelope.file_kind,
        revision: envelope.revision,
        updated_at_ms: envelope.updated_at_ms,
        path_hint: envelope.path_hint.clone(),
        entry_token: token.to_string(),
        base_version_token: envelope.base_version_token.clone(),
        content_bytes: envelope.content.len() as u64,
        raw_size_bytes,
        write_status: None,
        evicted_document_ids: Vec::new(),
        recovery_paths: Vec::new(),
        repair_required: None,
        repair_receipt: None,
    }
}

pub(crate) fn require_token<V>(entry: &ScannedEntry<V>, token: &str) -> Result<(), CrashDraftError> {
    if entry.token() == token {
        Ok(())
    } else {
        Err(token_conflict())
    }
}

pub(crate) fn map_delete_outcome<V>(outcome: DraftDeleteOutcome<V>) -> Result<(), CrashDraftError> {
    match outcome {
        DraftDeleteOutcome::ConfirmedDeleted => Ok(()),
        DraftDeleteOutcome::ConfirmedNotDeleted { recovery_paths, .. } => {
            Err(CrashDraftError::mutation(
                CrashDraftErrorCode::Persistence,
                CrashDraftPersistenceDisposition::ConfirmedNotCommitted,
                recovery_paths,
            ))
        }
        DraftDeleteOutcome::Conflict { recovery_paths, .. } => Err(CrashDraftError::mutation(
            CrashDraftErrorCode::Conflict,
            CrashDraftPersistenceDisposition::Conflict,
            recovery_paths,
        )),
        DraftDeleteOutcome::Indeterminate { recovery_paths } => Err(CrashDraftError::mutation(
            CrashDraftErrorCode::Indeterminate,
            CrashDraftPersistenceDisposition::Indeterminate,
            recovery_paths,
        )),
    }
}

pub(crate) fn revision_conflict() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Conflict,
        "crash draft revision conflicts with the stored revision",
    )
}

pub(crate) fn token_conflict() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Conflict,
        "crash draft token no longer matches storage",
    )
}

pub(crate) fn not_found() -> CrashDraftError {
    CrashDraftError::plain(CrashDraftErrorCode::NotFound, "crash draft was not found")
}

pub(crate) fn committed_needs_repair(
    repair_required: CrashDraftRepairRequired,
    recovery_paths: Vec<PathBuf>,
    receipt_material: &[PathBuf],
) -> CrashDraftError {
    let mut receipt_paths = recovery_paths.clone();
    receipt_paths.extend(receipt_material.iter().cloned());
    let mut error = CrashDraftError::mutation(
        CrashDraftErrorCode::CommittedNeedsRepair,
        CrashDraftPersistenceDisposition::ConfirmedCommitted,
        recovery_paths,
    );
    error.repair_required = Some(repair_required);
    error.repair_receipt = repair_receipt(repair_kind_label(repair_required), &receipt_paths);
    error
}

pub(crate) fn disposition_label(disposition: CrashDraftPersistenceDisposition) -> &'static str {
    match disposition {
        CrashDraftPersistenceDisposition::ConfirmedCommitted => "confirmed_committed",
        CrashDraftPersistenceDisposition::ConfirmedNotCommitted => "confirmed_not_committed",
        CrashDraftPersistenceDisposition::Conflict => "conflict",
        CrashDraftPersistenceDisposition::Indeterminate => "indeterminate",
    }
}

pub(crate) fn repair_kind_label(kind: CrashDraftRepairRequired) -> &'static str {
    match kind {
        CrashDraftRepairRequired::LimitRepair => "limit_repair",
        CrashDraftRepairRequired::PrivacyRepair => "privacy_repair",
        CrashDraftRepairRequired::CleanupRepair => "cleanup_repair",
    }
}

pub(crate) fn repair_receipt(domain: &str, paths: &[PathBuf]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }
    let mut material: Vec<_> = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    material.sort();
    material.dedup();
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft-repair\0\x01");
    frame_field(&mut frame, domain.as_bytes());
    for path in material {
        frame_field(&mut frame, path.as_bytes());
    }
    Some(lowercase_hex(&Sha256::digest(frame)))
}
