//! Crash-draft store public operations.
use super::*;

impl<W: DraftWritePort, C: DraftClock> CrashDraftStore<W, C> {
    pub(crate) fn reset_overflow_batch(
        &self,
        expected_repair_receipt: &str,
    ) -> Result<CrashDraftOverflowResetProgress, CrashDraftError> {
        validate_expected_token(expected_repair_receipt)?;
        self.with_lock(|| {
            let mut active_token = self
                .overflow_reset_token
                .lock()
                .map_err(|_| CrashDraftError::persistence())?;
            let Some(active) = active_token.as_ref() else {
                return Err(token_conflict());
            };
            if active.token != expected_repair_receipt {
                return Err(token_conflict());
            }
            let pending = active_token
                .take()
                .expect("validated pending repair exists");
            drop(active_token);
            if self.storage_fingerprint()? != pending.fingerprint {
                return Err(token_conflict());
            }
            let (mut candidates, blocked_entries, scan_truncated) =
                self.collect_overflow_reset_candidates()?;
            let has_extra_candidate = candidates.len() > OVERFLOW_RESET_DELETE_BATCH;
            candidates.truncate(OVERFLOW_RESET_DELETE_BATCH);
            let removed_entries = self.delete_overflow_reset_candidates(candidates)?;
            let more_work_remaining = has_extra_candidate || scan_truncated;
            let repair_receipt = if more_work_remaining {
                Some(self.issue_overflow_reset_token(pending.kind)?)
            } else {
                None
            };
            Ok(CrashDraftOverflowResetProgress {
                removed_entries,
                blocked_entries,
                more_work_remaining,
                repair_receipt,
            })
        })
    }

    fn collect_overflow_reset_candidates(
        &self,
    ) -> Result<(Vec<(PathBuf, W::Version)>, usize, bool), CrashDraftError> {
        let mut candidates = Vec::with_capacity(OVERFLOW_RESET_DELETE_BATCH + 1);
        let mut blocked_entries = 0usize;
        let mut scan_truncated = false;
        for (index, dir_entry) in fs::read_dir(&self.root)
            .map_err(|_| CrashDraftError::persistence())?
            .enumerate()
        {
            if index >= OVERFLOW_RESET_SCAN_BATCH {
                scan_truncated = true;
                break;
            }
            let dir_entry = dir_entry.map_err(|_| CrashDraftError::persistence())?;
            if dir_entry.file_name() == LOCK_FILE_NAME {
                continue;
            }
            let path = dir_entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                blocked_entries = blocked_entries.saturating_add(1);
                continue;
            }
            make_file_private(&path).map_err(|_| CrashDraftError::persistence())?;
            match self
                .writer
                .observe(&path, MAX_DRAFT_ENVELOPE_BYTES)
                .map_err(|_| CrashDraftError::persistence())?
            {
                DraftObservation::Missing => {}
                DraftObservation::Present { version, .. } => {
                    candidates.push((path, version));
                    if candidates.len() > OVERFLOW_RESET_DELETE_BATCH {
                        break;
                    }
                }
            }
        }
        Ok((candidates, blocked_entries, scan_truncated))
    }

    fn delete_overflow_reset_candidates(
        &self,
        candidates: Vec<(PathBuf, W::Version)>,
    ) -> Result<usize, CrashDraftError> {
        let mut removed_entries = 0usize;
        for (path, version) in candidates {
            match map_delete_outcome(self.writer.remove_exact(&path, &version)) {
                Ok(()) => removed_entries += 1,
                Err(error) if removed_entries > 0 => {
                    return Err(CrashDraftError::mutation(
                        CrashDraftErrorCode::Indeterminate,
                        CrashDraftPersistenceDisposition::Indeterminate,
                        error.recovery_paths,
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        Ok(removed_entries)
    }

    pub(crate) fn repair_startup(&self) -> Result<CrashDraftCatalog, CrashDraftError> {
        self.with_lock(|| {
            if self.cleanup_ignored_artifacts()? {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
                ));
            }
            let mut catalog = self.scan_catalog()?;
            if let Err(error) = self.repair_limits(&mut catalog.entries, None) {
                if error.code == CrashDraftErrorCode::Capacity {
                    return Err(overflow_capacity_error(
                        self.issue_overflow_reset_token(PendingRepairKind::Limit)?,
                    ));
                }
                return Err(error);
            }
            self.scan_catalog().map(ScannedCatalog::public)
        })
    }
}
