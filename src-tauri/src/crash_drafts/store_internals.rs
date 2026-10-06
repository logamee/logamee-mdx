//! Store internals: locking, scanning, repair and overflow reset.
use super::*;

impl<W: DraftWritePort, C: DraftClock> CrashDraftStore<W, C> {
    pub(super) fn require_catalog_within_limits<V>(
        &self,
        entries: &[ScannedEntry<V>],
    ) -> Result<(), CrashDraftError> {
        let total = match checked_total_size(entries) {
            Ok(total) => total,
            Err(_) => {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Limit)?,
                ))
            }
        };
        if entries.len() > MAX_DRAFT_ENTRIES || total > MAX_DRAFT_TOTAL_BYTES {
            return Err(overflow_capacity_error(
                self.issue_overflow_reset_token(PendingRepairKind::Limit)?,
            ));
        }
        Ok(())
    }

    pub(super) fn has_ignored_artifacts(&self) -> Result<bool, CrashDraftError> {
        for dir_entry in fs::read_dir(&self.root)
            .map_err(|_| CrashDraftError::persistence())?
            .take(MAX_CRASH_DRAFT_DIRECTORY_ENTRIES)
        {
            let dir_entry = dir_entry.map_err(|_| CrashDraftError::persistence())?;
            if is_ignored_artifact_name(&dir_entry.file_name()) {
                let metadata = fs::symlink_metadata(dir_entry.path())
                    .map_err(|_| CrashDraftError::persistence())?;
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub(super) fn cleanup_ignored_artifacts(&self) -> Result<bool, CrashDraftError> {
        let mut candidates = Vec::new();
        for dir_entry in fs::read_dir(&self.root)
            .map_err(|_| CrashDraftError::persistence())?
            .take(MAX_CRASH_DRAFT_DIRECTORY_ENTRIES)
        {
            let dir_entry = dir_entry.map_err(|_| CrashDraftError::persistence())?;
            let file_name = dir_entry.file_name();
            if !is_ignored_artifact_name(&file_name) {
                continue;
            }
            let path = dir_entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            if let DraftObservation::Present { version, .. } = self
                .writer
                .observe(&path, MAX_DRAFT_ENVELOPE_BYTES)
                .map_err(|_| CrashDraftError::persistence())?
            {
                candidates.push((path, version));
                if candidates.len() >= OVERFLOW_RESET_DELETE_BATCH {
                    break;
                }
            }
        }
        for (path, version) in candidates {
            map_delete_outcome(self.writer.remove_exact(&path, &version))?;
        }
        self.has_ignored_artifacts()
    }

    pub(super) fn with_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, CrashDraftError>,
    ) -> Result<T, CrashDraftError> {
        let _runtime = self
            .runtime_lock
            .lock()
            .map_err(|_| CrashDraftError::persistence())?;
        ensure_private_directory(&self.root).map_err(|_| CrashDraftError::persistence())?;
        let lock_path = self.root.join(LOCK_FILE_NAME);
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|_| CrashDraftError::persistence())?;
        make_file_private(&lock_path).map_err(|_| CrashDraftError::persistence())?;
        lock.lock()
            .map_err(|_| CrashDraftError::persistence())?;
        let result = operation();
        let unlock = lock.unlock().map_err(|_| CrashDraftError::persistence());
        match (result, unlock) {
            (Err(error), _) => Err(error),
            // Dropping the handle still releases the advisory lock. An explicit unlock
            // failure does not change the already-established operation disposition.
            (Ok(value), _) => Ok(value),
        }
    }

    pub(super) fn scan_catalog(&self) -> Result<ScannedCatalog<W::Version>, CrashDraftError> {
        let mut entries = Vec::new();
        for (index, dir_entry) in fs::read_dir(&self.root)
            .map_err(|_| CrashDraftError::persistence())?
            .enumerate()
        {
            if index >= MAX_CRASH_DRAFT_DIRECTORY_ENTRIES {
                let receipt = self.issue_overflow_reset_token(PendingRepairKind::Limit)?;
                return Err(overflow_capacity_error(receipt));
            }
            let dir_entry = dir_entry.map_err(|_| CrashDraftError::persistence())?;
            if let Some(entry) = self.scan_dir_entry(dir_entry)? {
                entries.push(entry);
            }
        }
        entries.sort_by(|left, right| left.id().cmp(right.id()));
        let catalog_token = catalog_token(&entries);
        Ok(ScannedCatalog {
            entries,
            catalog_token,
        })
    }

    fn scan_dir_entry(
        &self,
        dir_entry: fs::DirEntry,
    ) -> Result<Option<ScannedEntry<W::Version>>, CrashDraftError> {
        let Some(file_name) = dir_entry.file_name().to_str().map(str::to_owned) else {
            return Ok(None);
        };
        let Some(document_id) = file_name.strip_suffix(".json") else {
            return Ok(None);
        };
        if validate_document_id(document_id).is_err() {
            return Ok(None);
        }
        let path = dir_entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Ok(None);
        }
        make_file_private(&path).map_err(|_| CrashDraftError::persistence())?;
        let oversized_on_disk = metadata.len() > MAX_DRAFT_ENVELOPE_BYTES as u64;
        let observation = self
            .writer
            .observe(&path, MAX_DRAFT_ENVELOPE_BYTES)
            .map_err(|_| CrashDraftError::persistence())?;
        let DraftObservation::Present {
            bytes,
            size,
            version,
            version_token,
        } = observation
        else {
            return Ok(None);
        };
        let token = entry_token(&bytes, size, &version_token);
        Ok(Some(classify_entry(
            document_id.to_string(),
            path,
            bytes,
            size,
            token,
            version,
            oversized_on_disk || size > MAX_DRAFT_ENVELOPE_BYTES as u64,
        )))
    }

}

pub(super) fn unchanged_summary<V>(
    existing: Option<&ScannedEntry<V>>,
    request: &CrashDraftWriteRequest,
) -> Result<Option<CrashDraftSummary>, CrashDraftError> {
    if let Some(previous) = existing.and_then(ScannedEntry::supported_envelope) {
        if request.revision < previous.revision {
            return Err(revision_conflict());
        }
        if request.revision == previous.revision {
            if request_matches(previous, request) {
                let mut summary = summary_from_supported(
                    previous,
                    existing.expect("existing entry is present").token(),
                    existing.expect("existing entry is present").size(),
                );
                summary.write_status = Some(CrashDraftWriteStatus::Unchanged);
                return Ok(Some(summary));
            }
            return Err(revision_conflict());
        }
    }
    Ok(None)
}

pub(super) fn seal_envelope(
    request: CrashDraftWriteRequest,
    updated_at_ms: u64,
) -> Result<(CrashDraftEnvelope, Vec<u8>), CrashDraftError> {
    let mut envelope = CrashDraftEnvelope {
        schema_version: CRASH_DRAFT_SCHEMA_VERSION,
        document_id: request.document_id,
        file_kind: request.file_kind,
        revision: request.revision,
        updated_at_ms,
        path_hint: request.path_hint,
        base_version_token: request.base_version_token,
        content: request.content,
        checksum: String::new(),
    };
    envelope.checksum = envelope_checksum(&envelope);
    let bytes = serde_json::to_vec(&envelope).map_err(|_| CrashDraftError::persistence())?;
    if bytes.len() > MAX_DRAFT_ENVELOPE_BYTES {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Oversized,
            "crash draft envelope exceeds the size limit",
        ));
    }
    Ok((envelope, bytes))
}

pub(super) fn stored_summary(
    envelope: &CrashDraftEnvelope,
    token: &str,
    raw_size_bytes: u64,
    evicted_document_ids: Vec<String>,
    recovery_paths: Vec<PathBuf>,
) -> CrashDraftSummary {
    let mut summary = summary_from_supported(envelope, token, raw_size_bytes);
    summary.write_status = Some(CrashDraftWriteStatus::Stored);
    summary.evicted_document_ids = evicted_document_ids;
    summary.recovery_paths = recovery_paths;
    if !summary.recovery_paths.is_empty() {
        summary.repair_required = Some(CrashDraftRepairRequired::CleanupRepair);
        summary.repair_receipt = repair_receipt("cleanup_repair", &summary.recovery_paths);
    }
    summary
}
