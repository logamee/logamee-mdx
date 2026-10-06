//! Store internals: locking, scanning, repair and overflow reset.
use super::*;
use crate::private_fs::lowercase_hex;

impl<W: DraftWritePort, C: DraftClock> CrashDraftStore<W, C> {
    pub(super) fn repair_limits(
        &self,
        entries: &mut Vec<ScannedEntry<W::Version>>,
        incoming_id: Option<&str>,
    ) -> Result<Vec<String>, CrashDraftError> {
        let mut removed_any = false;
        let mut evicted_document_ids = Vec::new();
        let mut total_size = checked_total_size(entries)?;
        let (mut candidates, mut retained): (Vec<_>, Vec<_>) =
            std::mem::take(entries).into_iter().partition(|entry| {
                matches!(entry, ScannedEntry::Supported { .. }) && incoming_id != Some(entry.id())
            });
        candidates.sort_by(|left, right| left.eviction_key().cmp(&right.eviction_key()));

        let mut candidates = candidates.into_iter();
        while let Some(candidate) = candidates.next() {
            let current_count = retained.len() + candidates.len() + 1;
            if current_count <= MAX_DRAFT_ENTRIES && total_size <= MAX_DRAFT_TOTAL_BYTES {
                retained = reassembled_entries(retained, candidate, candidates);
                *entries = retained;
                return Ok(evicted_document_ids);
            }
            let candidate_size = candidate.size();
            let outcome = self
                .writer
                .remove_exact(candidate.path(), candidate.version());
            match map_delete_outcome(outcome) {
                Ok(()) => {
                    evicted_document_ids.push(candidate.id().to_string());
                    total_size = total_size
                        .checked_sub(candidate_size)
                        .ok_or_else(capacity_overflow)?;
                    removed_any = true;
                }
                Err(error) if removed_any => {
                    *entries = reassembled_entries(retained, candidate, candidates);
                    return Err(indeterminate_after_partial_eviction(error.recovery_paths));
                }
                Err(error) => {
                    *entries = reassembled_entries(retained, candidate, candidates);
                    return Err(error);
                }
            }
        }
        retained.sort_by(|left, right| left.id().cmp(right.id()));
        *entries = retained;
        if entries.len() <= MAX_DRAFT_ENTRIES && total_size <= MAX_DRAFT_TOTAL_BYTES {
            Ok(evicted_document_ids)
        } else {
            Err(protected_capacity_exhausted())
        }
    }

    pub(super) fn delete_all_exact(
        &self,
        entries: &[ScannedEntry<W::Version>],
    ) -> Result<(), CrashDraftError> {
        let mut deleted_any = false;
        for entry in entries {
            match map_delete_outcome(self.writer.remove_exact(entry.path(), entry.version())) {
                Ok(()) => deleted_any = true,
                Err(error) if deleted_any => {
                    return Err(CrashDraftError::mutation(
                        CrashDraftErrorCode::Indeterminate,
                        CrashDraftPersistenceDisposition::Indeterminate,
                        error.recovery_paths,
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub(super) fn entry_path(&self, document_id: &str) -> PathBuf {
        self.root.join(format!("{document_id}.json"))
    }

    pub(super) fn issue_overflow_reset_token(
        &self,
        kind: PendingRepairKind,
    ) -> Result<String, CrashDraftError> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| CrashDraftError::persistence())?;
        let token = lowercase_hex(&Sha256::digest(random));
        let pending = PendingRepair {
            token: token.clone(),
            fingerprint: self.storage_fingerprint()?,
            kind,
        };
        *self
            .overflow_reset_token
            .lock()
            .map_err(|_| CrashDraftError::persistence())? = Some(pending);
        Ok(token)
    }

    pub(super) fn storage_fingerprint(&self) -> Result<String, CrashDraftError> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.root)
            .map_err(|_| CrashDraftError::persistence())?
            .take(OVERFLOW_RESET_SCAN_BATCH)
        {
            let entry = entry.map_err(|_| CrashDraftError::persistence())?;
            if entry.file_name() == LOCK_FILE_NAME {
                continue;
            }
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
            let file_type = metadata.file_type();
            let kind = if file_type.is_symlink() {
                "symlink".to_string()
            } else if file_type.is_dir() {
                "directory".to_string()
            } else if file_type.is_file() {
                match self
                    .writer
                    .observe(&path, MAX_DRAFT_ENVELOPE_BYTES)
                    .map_err(|_| CrashDraftError::persistence())?
                {
                    DraftObservation::Missing => "missing".to_string(),
                    DraftObservation::Present {
                        size,
                        version_token,
                        ..
                    } => format!("file:{size}:{version_token}"),
                }
            } else {
                "blocked".to_string()
            };
            records.push((
                entry.file_name().to_string_lossy().into_owned(),
                metadata.len(),
                kind,
            ));
        }
        records.sort();
        let bytes = serde_json::to_vec(&records).map_err(|_| CrashDraftError::persistence())?;
        Ok(lowercase_hex(&Sha256::digest(bytes)))
    }
}

pub(crate) enum PendingRepairKind {
    Cleanup,
    Limit,
}
pub(crate) struct PendingRepair {
    pub(crate) token: String,
    pub(crate) fingerprint: String,
    pub(crate) kind: PendingRepairKind,
}

fn reassembled_entries<V>(
    mut retained: Vec<ScannedEntry<V>>,
    candidate: ScannedEntry<V>,
    remaining: impl Iterator<Item = ScannedEntry<V>>,
) -> Vec<ScannedEntry<V>> {
    retained.push(candidate);
    retained.extend(remaining);
    retained.sort_by(|left, right| left.id().cmp(right.id()));
    retained
}

fn indeterminate_after_partial_eviction(recovery_paths: Vec<PathBuf>) -> CrashDraftError {
    CrashDraftError::mutation(
        CrashDraftErrorCode::Indeterminate,
        CrashDraftPersistenceDisposition::Indeterminate,
        recovery_paths,
    )
}

fn protected_capacity_exhausted() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Capacity,
        "protected crash drafts consume the available storage capacity",
    )
}
