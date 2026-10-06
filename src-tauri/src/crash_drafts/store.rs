//! Crash-draft store public operations.
use super::*;
use super::store_internals::{seal_envelope, stored_summary, unchanged_summary};

impl<W: DraftWritePort, C: DraftClock> CrashDraftStore<W, C> {
    pub(crate) fn new(app_data_dir: impl AsRef<Path>, writer: W, clock: C) -> Self {
        Self {
            root: app_data_dir.as_ref().join("crash-drafts").join("v1"),
            writer,
            clock,
            runtime_lock: Mutex::new(()),
            overflow_reset_token: Mutex::new(None),
        }
    }

    pub(crate) fn list(&self) -> Result<CrashDraftCatalog, CrashDraftError> {
        self.with_lock(|| {
            if self.has_ignored_artifacts()? {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
                ));
            }
            let catalog = self.scan_catalog()?;
            self.require_catalog_within_limits(&catalog.entries)?;
            Ok(catalog.public())
        })
    }

    pub(crate) fn write(
        &self,
        request: CrashDraftWriteRequest,
    ) -> Result<CrashDraftSummary, CrashDraftError> {
        validate_write_request(&request)?;
        self.with_lock(|| self.write_locked(request))
    }

    fn write_locked(
        &self,
        request: CrashDraftWriteRequest,
    ) -> Result<CrashDraftSummary, CrashDraftError> {
        if self.has_ignored_artifacts()? {
            return Err(overflow_capacity_error(
                self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
            ));
        }
        let mut catalog = self.scan_catalog()?;
        let existing_index = locate_existing_index(&catalog.entries, &request.document_id)?;
        let existing = existing_index.and_then(|index| catalog.entries.get(index));
        if let Some(summary) = unchanged_summary(existing, &request)? {
            return Ok(summary);
        }
        let updated_at_ms = self.next_updated_at_ms(&catalog.entries)?;
        let (envelope, bytes) = seal_envelope(request, updated_at_ms)?;
        ensure_protected_capacity(&catalog.entries, &envelope.document_id, bytes.len() as u64)?;
        let destination = self.entry_path(&envelope.document_id);
        let (version, version_token, committed_recovery_paths) =
            self.persist_envelope(existing, &destination, &bytes)?;
        if let Err(_error) = make_file_private(&destination) {
            return Err(committed_needs_repair(
                CrashDraftRepairRequired::PrivacyRepair,
                committed_recovery_paths,
                &[destination],
            ));
        }
        if let Some(index) = existing_index {
            catalog.entries.remove(index);
        }
        let token = entry_token(&bytes, bytes.len() as u64, &version_token);
        catalog.entries.push(ScannedEntry::Supported {
            envelope: envelope.clone(),
            path: destination.clone(),
            size: bytes.len() as u64,
            token: token.clone(),
            version,
        });
        let evicted_document_ids = self.evict_after_write(
            &mut catalog.entries,
            &envelope.document_id,
            &destination,
            &committed_recovery_paths,
        )?;
        let summary = stored_summary(
            &envelope,
            &token,
            bytes.len() as u64,
            evicted_document_ids,
            committed_recovery_paths,
        );
        Ok(summary)
    }

    pub(crate) fn recover(
        &self,
        document_id: &str,
        expected_entry_token: &str,
    ) -> Result<RecoveredCrashDraft, CrashDraftError> {
        validate_document_id(document_id)?;
        validate_expected_token(expected_entry_token)?;
        self.with_lock(|| {
            let catalog = self.scan_catalog()?;
            let entry = catalog
                .entries
                .iter()
                .find(|entry| entry.id() == document_id)
                .ok_or_else(not_found)?;
            require_token(entry, expected_entry_token)?;
            match entry {
                ScannedEntry::Supported {
                    envelope, token, ..
                } => Ok(RecoveredCrashDraft {
                    envelope: envelope.clone(),
                    entry_token: token.clone(),
                }),
                ScannedEntry::Protected { .. } => Err(CrashDraftError::plain(
                    CrashDraftErrorCode::Protected,
                    "protected crash draft content cannot be recovered",
                )),
            }
        })
    }

    pub(crate) fn discard(
        &self,
        document_id: &str,
        expected_entry_token: &str,
    ) -> Result<(), CrashDraftError> {
        validate_document_id(document_id)?;
        validate_expected_token(expected_entry_token)?;
        self.with_lock(|| {
            let catalog = self.scan_catalog()?;
            let entry = catalog
                .entries
                .iter()
                .find(|entry| entry.id() == document_id)
                .ok_or_else(not_found)?;
            require_token(entry, expected_entry_token)?;
            map_delete_outcome(self.writer.remove_exact(entry.path(), entry.version()))?;
            if self.cleanup_ignored_artifacts()? {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
                ));
            }
            Ok(())
        })
    }

    pub(crate) fn reset(&self, expected_catalog_token: &str) -> Result<(), CrashDraftError> {
        validate_expected_token(expected_catalog_token)?;
        self.with_lock(|| {
            let catalog = self.scan_catalog()?;
            if catalog.catalog_token != expected_catalog_token {
                return Err(token_conflict());
            }
            self.delete_all_exact(&catalog.entries)?;
            if self.cleanup_ignored_artifacts()? {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
                ));
            }
            Ok(())
        })
    }
}

fn locate_existing_index<V>(
    entries: &[ScannedEntry<V>],
    document_id: &str,
) -> Result<Option<usize>, CrashDraftError> {
    let existing_index = entries
        .iter()
        .position(|entry| entry.id() == document_id);
    if existing_index
        .and_then(|index| entries.get(index))
        .is_some_and(|entry| matches!(entry, ScannedEntry::Protected { .. }))
    {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Protected,
            "the existing crash draft is protected and must be explicitly discarded",
        ));
    }
    Ok(existing_index)
}

impl<W: DraftWritePort, C: DraftClock> CrashDraftStore<W, C> {
    fn next_updated_at_ms(
        &self,
        entries: &[ScannedEntry<W::Version>],
    ) -> Result<u64, CrashDraftError> {
        let highest_time = entries
            .iter()
            .filter_map(ScannedEntry::supported_envelope)
            .map(|entry| entry.updated_at_ms)
            .max()
            .unwrap_or(0);
        let now = self.clock.now_ms().min(JS_SAFE_INTEGER);
        if now > highest_time {
            return Ok(now);
        }
        highest_time
            .checked_add(1)
            .filter(|value| *value <= JS_SAFE_INTEGER)
            .ok_or_else(|| {
                CrashDraftError::plain(
                    CrashDraftErrorCode::Invalid,
                    "crash draft timestamp exhausted the safe integer range",
                )
            })
    }

    fn persist_envelope(
        &self,
        existing: Option<&ScannedEntry<W::Version>>,
        destination: &Path,
        bytes: &[u8],
    ) -> Result<(W::Version, String, Vec<PathBuf>), CrashDraftError> {
        let expected = existing
            .map(|entry| ExpectedDraftState::Exact(entry.version().clone()))
            .unwrap_or(ExpectedDraftState::Absent);
        match self.writer.persist(destination, bytes, expected) {
            DraftWriteOutcome::ConfirmedCommitted {
                version,
                version_token,
                recovery_paths,
            } => Ok((version, version_token, recovery_paths)),
            DraftWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } => {
                Err(CrashDraftError::mutation(
                    CrashDraftErrorCode::Persistence,
                    CrashDraftPersistenceDisposition::ConfirmedNotCommitted,
                    recovery_paths,
                ))
            }
            DraftWriteOutcome::Conflict { recovery_paths, .. } => Err(CrashDraftError::mutation(
                CrashDraftErrorCode::Conflict,
                CrashDraftPersistenceDisposition::Conflict,
                recovery_paths,
            )),
            DraftWriteOutcome::Indeterminate { recovery_paths } => Err(CrashDraftError::mutation(
                CrashDraftErrorCode::Indeterminate,
                CrashDraftPersistenceDisposition::Indeterminate,
                recovery_paths,
            )),
        }
    }

    fn evict_after_write(
        &self,
        entries: &mut Vec<ScannedEntry<W::Version>>,
        incoming_id: &str,
        destination: &Path,
        committed_recovery_paths: &[PathBuf],
    ) -> Result<Vec<String>, CrashDraftError> {
        match self.repair_limits(entries, Some(incoming_id)) {
            Ok(evicted) => Ok(evicted),
            Err(error) => {
                let mut recovery_paths = error.recovery_paths;
                recovery_paths.extend_from_slice(committed_recovery_paths);
                recovery_paths.sort();
                recovery_paths.dedup();
                Err(committed_needs_repair(
                    CrashDraftRepairRequired::LimitRepair,
                    recovery_paths,
                    &[destination.to_path_buf()],
                ))
            }
        }
    }
}
