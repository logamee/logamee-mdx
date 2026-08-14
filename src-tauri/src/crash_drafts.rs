use std::{
    fmt::Debug,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
const PRIVATE_DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
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

pub(crate) trait DraftClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ExpectedDraftState<V> {
    Absent,
    Exact(V),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftObservation<V> {
    Missing,
    Present {
        bytes: Vec<u8>,
        size: u64,
        version: V,
        version_token: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftWriteOutcome<V> {
    ConfirmedCommitted {
        version: V,
        version_token: String,
        recovery_paths: Vec<PathBuf>,
    },
    ConfirmedNotCommitted {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftDeleteOutcome<V> {
    ConfirmedDeleted,
    ConfirmedNotDeleted {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}

pub(crate) trait DraftWritePort: Send + Sync {
    type Version: Clone + Debug + Eq + Send + Sync;

    /// Returns at most `max_bytes + 1` bytes while capturing the exact file version.
    fn observe(
        &self,
        path: &Path,
        max_bytes: usize,
    ) -> Result<DraftObservation<Self::Version>, String>;

    /// Adapter errors after mutation begins must be represented by a four-state outcome.
    fn persist(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: ExpectedDraftState<Self::Version>,
    ) -> DraftWriteOutcome<Self::Version>;

    /// Deletes only the exact observed version; path-only deletion is forbidden.
    fn remove_exact(
        &self,
        destination: &Path,
        expected: &Self::Version,
    ) -> DraftDeleteOutcome<Self::Version>;
}

pub(crate) struct CrashDraftStore<W, C> {
    root: PathBuf,
    writer: W,
    clock: C,
    runtime_lock: Mutex<()>,
    overflow_reset_token: Mutex<Option<PendingRepair>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingRepairKind {
    Cleanup,
    Limit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingRepair {
    token: String,
    fingerprint: String,
    kind: PendingRepairKind,
}

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
        self.with_lock(|| {
            if self.has_ignored_artifacts()? {
                return Err(overflow_capacity_error(
                    self.issue_overflow_reset_token(PendingRepairKind::Cleanup)?,
                ));
            }
            let mut catalog = self.scan_catalog()?;
            let existing_index = catalog
                .entries
                .iter()
                .position(|entry| entry.id() == request.document_id);
            if existing_index
                .and_then(|index| catalog.entries.get(index))
                .is_some_and(|entry| matches!(entry, ScannedEntry::Protected { .. }))
            {
                return Err(CrashDraftError::plain(
                    CrashDraftErrorCode::Protected,
                    "the existing crash draft is protected and must be explicitly discarded",
                ));
            }

            let existing = existing_index.and_then(|index| catalog.entries.get(index));
            if let Some(previous) = existing.and_then(ScannedEntry::supported_envelope) {
                if request.revision < previous.revision {
                    return Err(revision_conflict());
                }
                if request.revision == previous.revision {
                    if request_matches(previous, &request) {
                        let mut summary = summary_from_supported(
                            previous,
                            existing.expect("existing entry is present").token(),
                            existing.expect("existing entry is present").size(),
                        );
                        summary.write_status = Some(CrashDraftWriteStatus::Unchanged);
                        return Ok(summary);
                    }
                    return Err(revision_conflict());
                }
            }

            let highest_time = catalog
                .entries
                .iter()
                .filter_map(ScannedEntry::supported_envelope)
                .map(|entry| entry.updated_at_ms)
                .max()
                .unwrap_or(0);
            let now = self.clock.now_ms().min(JS_SAFE_INTEGER);
            let updated_at_ms = if now > highest_time {
                now
            } else {
                highest_time
                    .checked_add(1)
                    .filter(|value| *value <= JS_SAFE_INTEGER)
                    .ok_or_else(|| {
                        CrashDraftError::plain(
                            CrashDraftErrorCode::Invalid,
                            "crash draft timestamp exhausted the safe integer range",
                        )
                    })?
            };
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
            let bytes =
                serde_json::to_vec(&envelope).map_err(|_| CrashDraftError::persistence())?;
            if bytes.len() > MAX_DRAFT_ENVELOPE_BYTES {
                return Err(CrashDraftError::plain(
                    CrashDraftErrorCode::Oversized,
                    "crash draft envelope exceeds the size limit",
                ));
            }
            ensure_protected_capacity(&catalog.entries, &envelope.document_id, bytes.len() as u64)?;

            let expected = existing
                .map(|entry| ExpectedDraftState::Exact(entry.version().clone()))
                .unwrap_or(ExpectedDraftState::Absent);
            let destination = self.entry_path(&envelope.document_id);
            let (version, version_token, committed_recovery_paths) =
                match self.writer.persist(&destination, &bytes, expected) {
                    DraftWriteOutcome::ConfirmedCommitted {
                        version,
                        version_token,
                        recovery_paths,
                    } => (version, version_token, recovery_paths),
                    DraftWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } => {
                        return Err(CrashDraftError::mutation(
                            CrashDraftErrorCode::Persistence,
                            CrashDraftPersistenceDisposition::ConfirmedNotCommitted,
                            recovery_paths,
                        ));
                    }
                    DraftWriteOutcome::Conflict { recovery_paths, .. } => {
                        return Err(CrashDraftError::mutation(
                            CrashDraftErrorCode::Conflict,
                            CrashDraftPersistenceDisposition::Conflict,
                            recovery_paths,
                        ));
                    }
                    DraftWriteOutcome::Indeterminate { recovery_paths } => {
                        return Err(CrashDraftError::mutation(
                            CrashDraftErrorCode::Indeterminate,
                            CrashDraftPersistenceDisposition::Indeterminate,
                            recovery_paths,
                        ));
                    }
                };

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
            let evicted_document_ids =
                match self.repair_limits(&mut catalog.entries, Some(&envelope.document_id)) {
                    Ok(evicted) => evicted,
                    Err(error) => {
                        let mut recovery_paths = error.recovery_paths;
                        recovery_paths.extend(committed_recovery_paths);
                        recovery_paths.sort();
                        recovery_paths.dedup();
                        return Err(committed_needs_repair(
                            CrashDraftRepairRequired::LimitRepair,
                            recovery_paths,
                            &[destination],
                        ));
                    }
                };
            let mut summary = summary_from_supported(&envelope, &token, bytes.len() as u64);
            summary.write_status = Some(CrashDraftWriteStatus::Stored);
            summary.evicted_document_ids = evicted_document_ids;
            summary.recovery_paths = committed_recovery_paths;
            if !summary.recovery_paths.is_empty() {
                summary.repair_required = Some(CrashDraftRepairRequired::CleanupRepair);
                summary.repair_receipt = repair_receipt("cleanup_repair", &summary.recovery_paths);
            }
            Ok(summary)
        })
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
                let metadata =
                    fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
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

            let has_extra_candidate = candidates.len() > OVERFLOW_RESET_DELETE_BATCH;
            candidates.truncate(OVERFLOW_RESET_DELETE_BATCH);
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

    fn require_catalog_within_limits<V>(
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

    fn has_ignored_artifacts(&self) -> Result<bool, CrashDraftError> {
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

    fn cleanup_ignored_artifacts(&self) -> Result<bool, CrashDraftError> {
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

    fn with_lock<T>(
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
        lock.lock_exclusive()
            .map_err(|_| CrashDraftError::persistence())?;
        let result = operation();
        let unlock = FileExt::unlock(&lock).map_err(|_| CrashDraftError::persistence());
        match (result, unlock) {
            (Err(error), _) => Err(error),
            // Dropping the handle still releases the advisory lock. An explicit unlock
            // failure does not change the already-established operation disposition.
            (Ok(value), _) => Ok(value),
        }
    }

    fn scan_catalog(&self) -> Result<ScannedCatalog<W::Version>, CrashDraftError> {
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
            let Some(file_name) = dir_entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(document_id) = file_name.strip_suffix(".json") else {
                continue;
            };
            if validate_document_id(document_id).is_err() {
                continue;
            }
            let path = dir_entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| CrashDraftError::persistence())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                continue;
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
                continue;
            };
            let token = entry_token(&bytes, size, &version_token);
            entries.push(classify_entry(
                document_id.to_string(),
                path,
                bytes,
                size,
                token,
                version,
                oversized_on_disk || size > MAX_DRAFT_ENVELOPE_BYTES as u64,
            ));
        }
        entries.sort_by(|left, right| left.id().cmp(right.id()));
        let catalog_token = catalog_token(&entries);
        Ok(ScannedCatalog {
            entries,
            catalog_token,
        })
    }

    fn repair_limits(
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
                retained.push(candidate);
                retained.extend(candidates);
                retained.sort_by(|left, right| left.id().cmp(right.id()));
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
                    retained.push(candidate);
                    retained.extend(candidates);
                    retained.sort_by(|left, right| left.id().cmp(right.id()));
                    *entries = retained;
                    return Err(CrashDraftError::mutation(
                        CrashDraftErrorCode::Indeterminate,
                        CrashDraftPersistenceDisposition::Indeterminate,
                        error.recovery_paths,
                    ));
                }
                Err(error) => {
                    retained.push(candidate);
                    retained.extend(candidates);
                    retained.sort_by(|left, right| left.id().cmp(right.id()));
                    *entries = retained;
                    return Err(error);
                }
            }
        }
        retained.sort_by(|left, right| left.id().cmp(right.id()));
        *entries = retained;
        if entries.len() <= MAX_DRAFT_ENTRIES && total_size <= MAX_DRAFT_TOTAL_BYTES {
            Ok(evicted_document_ids)
        } else {
            Err(CrashDraftError::plain(
                CrashDraftErrorCode::Capacity,
                "protected crash drafts consume the available storage capacity",
            ))
        }
    }

    fn delete_all_exact(
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

    fn entry_path(&self, document_id: &str) -> PathBuf {
        self.root.join(format!("{document_id}.json"))
    }

    fn issue_overflow_reset_token(
        &self,
        kind: PendingRepairKind,
    ) -> Result<String, CrashDraftError> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| CrashDraftError::persistence())?;
        let token = format!("{:x}", Sha256::digest(random));
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

    fn storage_fingerprint(&self) -> Result<String, CrashDraftError> {
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
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

struct ScannedCatalog<V> {
    entries: Vec<ScannedEntry<V>>,
    catalog_token: String,
}

enum ScannedEntry<V> {
    Supported {
        envelope: CrashDraftEnvelope,
        path: PathBuf,
        size: u64,
        token: String,
        version: V,
    },
    Protected {
        document_id: String,
        path: PathBuf,
        size: u64,
        token: String,
        version: V,
        reason: ProtectedDraftReason,
        future_schema_version: Option<u64>,
    },
}

impl<V> ScannedEntry<V> {
    fn id(&self) -> &str {
        match self {
            Self::Supported { envelope, .. } => &envelope.document_id,
            Self::Protected { document_id, .. } => document_id,
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Supported { path, .. } | Self::Protected { path, .. } => path,
        }
    }

    fn size(&self) -> u64 {
        match self {
            Self::Supported { size, .. } | Self::Protected { size, .. } => *size,
        }
    }

    fn token(&self) -> &str {
        match self {
            Self::Supported { token, .. } | Self::Protected { token, .. } => token,
        }
    }

    fn version(&self) -> &V {
        match self {
            Self::Supported { version, .. } | Self::Protected { version, .. } => version,
        }
    }

    fn supported_envelope(&self) -> Option<&CrashDraftEnvelope> {
        match self {
            Self::Supported { envelope, .. } => Some(envelope),
            Self::Protected { .. } => None,
        }
    }

    fn eviction_key(&self) -> (u64, u64, &str) {
        match self {
            Self::Supported { envelope, .. } => (
                envelope.updated_at_ms,
                envelope.revision,
                envelope.document_id.as_str(),
            ),
            Self::Protected { document_id, .. } => (u64::MAX, u64::MAX, document_id),
        }
    }

    fn public(&self) -> CrashDraftListEntry {
        match self {
            Self::Supported {
                envelope,
                size,
                token,
                ..
            } => CrashDraftListEntry::Supported {
                draft: summary_from_supported(envelope, token, *size),
            },
            Self::Protected {
                document_id,
                size,
                token,
                reason,
                future_schema_version,
                ..
            } => CrashDraftListEntry::Protected {
                document_id: document_id.clone(),
                entry_token: token.clone(),
                reason: *reason,
                raw_size_bytes: *size,
                future_schema_version: *future_schema_version,
            },
        }
    }
}

impl<V> ScannedCatalog<V> {
    fn public(self) -> CrashDraftCatalog {
        CrashDraftCatalog {
            entries: self.entries.iter().map(ScannedEntry::public).collect(),
            catalog_token: self.catalog_token,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn classify_entry<V>(
    filename_id: String,
    path: PathBuf,
    bytes: Vec<u8>,
    size: u64,
    token: String,
    version: V,
    oversized: bool,
) -> ScannedEntry<V> {
    if oversized {
        return ScannedEntry::Protected {
            document_id: filename_id,
            path,
            size,
            token,
            version,
            reason: ProtectedDraftReason::Oversized,
            future_schema_version: None,
        };
    }
    let detected_schema_version = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
        });
    let future_schema_version =
        detected_schema_version.filter(|schema| *schema > u64::from(CRASH_DRAFT_SCHEMA_VERSION));
    if let Ok(envelope) = serde_json::from_slice::<CrashDraftEnvelope>(&bytes) {
        if validate_envelope(&envelope, &filename_id).is_ok() {
            return ScannedEntry::Supported {
                envelope,
                path,
                size,
                token,
                version,
            };
        }
    }
    ScannedEntry::Protected {
        document_id: filename_id,
        path,
        size,
        token,
        version,
        reason: if future_schema_version.is_some() {
            ProtectedDraftReason::UnsupportedSchema
        } else {
            ProtectedDraftReason::Corrupt
        },
        future_schema_version,
    }
}

fn validate_write_request(request: &CrashDraftWriteRequest) -> Result<(), CrashDraftError> {
    validate_document_id(&request.document_id)?;
    if request.revision == 0 || request.revision > JS_SAFE_INTEGER {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft revision must be a positive safe integer",
        ));
    }
    validate_pair(&request.path_hint, &request.base_version_token)?;
    if let Some(path) = request.path_hint.as_deref() {
        validate_path_hint(path)?;
    }
    if request.content.len() > MAX_DRAFT_CONTENT_BYTES {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Oversized,
            "crash draft content exceeds the size limit",
        ));
    }
    Ok(())
}

fn validate_envelope(envelope: &CrashDraftEnvelope, filename_id: &str) -> Result<(), ()> {
    if envelope.schema_version != CRASH_DRAFT_SCHEMA_VERSION
        || envelope.document_id != filename_id
        || validate_document_id(&envelope.document_id).is_err()
        || envelope.revision == 0
        || envelope.revision > JS_SAFE_INTEGER
        || envelope.updated_at_ms > JS_SAFE_INTEGER
        || validate_pair(&envelope.path_hint, &envelope.base_version_token).is_err()
        || envelope
            .path_hint
            .as_deref()
            .is_some_and(|path| validate_path_hint(path).is_err())
        || envelope.content.len() > MAX_DRAFT_CONTENT_BYTES
        || envelope.checksum != envelope_checksum(envelope)
    {
        return Err(());
    }
    Ok(())
}

fn validate_document_id(document_id: &str) -> Result<(), CrashDraftError> {
    if document_id.len() == 32
        && document_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "document ID must be 32 lowercase hexadecimal characters",
        ))
    }
}

fn validate_expected_token(token: &str) -> Result<(), CrashDraftError> {
    if is_opaque_token(token) {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft token must be 64 lowercase hexadecimal characters",
        ))
    }
}

fn is_ignored_artifact_name(file_name: &std::ffi::OsStr) -> bool {
    if file_name == LOCK_FILE_NAME {
        return false;
    }
    !file_name
        .to_str()
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|id| validate_document_id(id).is_ok())
}

fn validate_pair(path: &Option<String>, version: &Option<String>) -> Result<(), CrashDraftError> {
    if matches!((path, version), (None, None))
        || matches!((path, version), (Some(path), Some(version)) if !path.is_empty() && is_opaque_token(version))
    {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "path hint and base version token must be supplied together",
        ))
    }
}

fn validate_path_hint(path: &str) -> Result<(), CrashDraftError> {
    if path.len() > MAX_PATH_HINT_BYTES {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Oversized,
            "crash draft path hint exceeds the size limit",
        ));
    }
    if path.is_empty()
        || path
            .chars()
            .any(|character| character.is_control() || is_unicode_format_control(character))
    {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft path hint contains unsupported characters",
        ));
    }
    Ok(())
}

fn is_opaque_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_unicode_format_control(character: char) -> bool {
    matches!(
        character,
        '\u{00ad}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

fn request_matches(envelope: &CrashDraftEnvelope, request: &CrashDraftWriteRequest) -> bool {
    envelope.file_kind == request.file_kind
        && envelope.revision == request.revision
        && envelope.path_hint == request.path_hint
        && envelope.base_version_token == request.base_version_token
        && envelope.content == request.content
}

fn ensure_protected_capacity<V>(
    entries: &[ScannedEntry<V>],
    incoming_id: &str,
    incoming_size: u64,
) -> Result<(), CrashDraftError> {
    let protected: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry, ScannedEntry::Protected { .. }))
        .collect();
    let replacing_protected = protected.iter().any(|entry| entry.id() == incoming_id);
    let minimum_count = protected.len() + usize::from(!replacing_protected);
    let protected_size = protected.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(entry.size())
            .ok_or_else(capacity_overflow)
    })?;
    let minimum_size = protected_size
        .checked_add(incoming_size)
        .ok_or_else(capacity_overflow)?;
    if minimum_count > MAX_DRAFT_ENTRIES || minimum_size > MAX_DRAFT_TOTAL_BYTES {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Capacity,
            "protected crash drafts consume the available storage capacity",
        ))
    } else {
        Ok(())
    }
}

fn checked_total_size<V>(entries: &[ScannedEntry<V>]) -> Result<u64, CrashDraftError> {
    entries.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(entry.size())
            .ok_or_else(capacity_overflow)
    })
}

fn capacity_overflow() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Capacity,
        "crash draft storage size exceeds the supported range",
    )
}

fn overflow_capacity_error(receipt: String) -> CrashDraftError {
    let mut error = CrashDraftError::plain(
        CrashDraftErrorCode::Capacity,
        "crash draft directory contains too many entries",
    );
    error.repair_required = Some(CrashDraftRepairRequired::LimitRepair);
    error.repair_receipt = Some(receipt);
    error
}

fn envelope_checksum(envelope: &CrashDraftEnvelope) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft\0\x01");
    frame_field(&mut frame, &envelope.schema_version.to_be_bytes());
    frame_field(&mut frame, envelope.document_id.as_bytes());
    frame_field(
        &mut frame,
        match envelope.file_kind {
            CrashDraftFileKind::Markdown => b"markdown",
            CrashDraftFileKind::Html => b"html",
            CrashDraftFileKind::Excalidraw => b"excalidraw",
        },
    );
    frame_field(&mut frame, &envelope.revision.to_be_bytes());
    frame_field(&mut frame, &envelope.updated_at_ms.to_be_bytes());
    frame_option(&mut frame, envelope.path_hint.as_deref());
    frame_option(&mut frame, envelope.base_version_token.as_deref());
    frame_field(&mut frame, envelope.content.as_bytes());
    format!("{:x}", Sha256::digest(frame))
}

fn frame_option(frame: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(value) => {
            frame.push(1);
            frame_field(frame, value.as_bytes());
        }
        None => frame.push(0),
    }
}

fn frame_field(frame: &mut Vec<u8>, bytes: &[u8]) {
    frame.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    frame.extend_from_slice(bytes);
}

fn entry_token(bytes: &[u8], size: u64, version_token: &str) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft-entry\0\x01");
    frame_field(&mut frame, &size.to_be_bytes());
    frame_field(&mut frame, version_token.as_bytes());
    frame_field(&mut frame, bytes);
    format!("{:x}", Sha256::digest(frame))
}

fn catalog_token<V>(entries: &[ScannedEntry<V>]) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft-catalog\0\x01");
    for entry in entries {
        frame_field(&mut frame, entry.id().as_bytes());
        frame_field(&mut frame, entry.token().as_bytes());
        frame_field(&mut frame, &entry.size().to_be_bytes());
    }
    format!("{:x}", Sha256::digest(frame))
}

fn summary_from_supported(
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

fn require_token<V>(entry: &ScannedEntry<V>, token: &str) -> Result<(), CrashDraftError> {
    if entry.token() == token {
        Ok(())
    } else {
        Err(token_conflict())
    }
}

fn map_delete_outcome<V>(outcome: DraftDeleteOutcome<V>) -> Result<(), CrashDraftError> {
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

fn revision_conflict() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Conflict,
        "crash draft revision conflicts with the stored revision",
    )
}

fn token_conflict() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Conflict,
        "crash draft token no longer matches storage",
    )
}

fn not_found() -> CrashDraftError {
    CrashDraftError::plain(CrashDraftErrorCode::NotFound, "crash draft was not found")
}

fn committed_needs_repair(
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

fn disposition_label(disposition: CrashDraftPersistenceDisposition) -> &'static str {
    match disposition {
        CrashDraftPersistenceDisposition::ConfirmedCommitted => "confirmed_committed",
        CrashDraftPersistenceDisposition::ConfirmedNotCommitted => "confirmed_not_committed",
        CrashDraftPersistenceDisposition::Conflict => "conflict",
        CrashDraftPersistenceDisposition::Indeterminate => "indeterminate",
    }
}

fn repair_kind_label(kind: CrashDraftRepairRequired) -> &'static str {
    match kind {
        CrashDraftRepairRequired::LimitRepair => "limit_repair",
        CrashDraftRepairRequired::PrivacyRepair => "privacy_repair",
        CrashDraftRepairRequired::CleanupRepair => "cleanup_repair",
    }
}

fn repair_receipt(domain: &str, paths: &[PathBuf]) -> Option<String> {
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
    Some(format!("{:x}", Sha256::digest(frame)))
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    make_directory_private(path)
}

#[cfg(unix)]
fn make_directory_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(unix)]
fn make_file_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(windows)]
pub(crate) fn make_directory_private(path: &Path) -> io::Result<()> {
    let sddl = private_windows_sddl(PRIVATE_DIRECTORY_SDDL, "OICI")?;
    apply_and_verify_private_windows_dacl(path, &sddl, 0x03)
}

#[cfg(windows)]
fn make_file_private(path: &Path) -> io::Result<()> {
    let sddl = private_windows_sddl(PRIVATE_FILE_SDDL, "")?;
    apply_and_verify_private_windows_dacl(path, &sddl, 0x00)
}

#[cfg(windows)]
fn current_process_token_information(
    information_class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    use std::{mem, ptr};
    use windows_sys::Win32::{Foundation::HANDLE, Security::GetTokenInformation};

    const CURRENT_PROCESS_TOKEN: HANDLE = (-4_isize) as HANDLE;
    let mut token_size = 0u32;
    unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            ptr::null_mut(),
            0,
            &mut token_size,
        );
    }
    if token_size == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_size = mem::size_of::<usize>();
    let mut token = vec![0usize; (token_size as usize).div_ceil(word_size)];
    if unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            token.as_mut_ptr().cast(),
            token_size,
            &mut token_size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(token)
}

#[cfg(windows)]
fn current_process_user_sid_string() -> io::Result<String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertSidToStringSidW, TokenUser, TOKEN_USER},
    };

    let token = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token.as_ptr().cast::<TOKEN_USER>() };
    let mut string_sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid) } == 0
        || string_sid.is_null()
    {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let length = unsafe { (0..1024).position(|index| *string_sid.add(index) == 0) }
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "unterminated TokenUser SID")
            })?;
        String::from_utf16(unsafe { std::slice::from_raw_parts(string_sid, length) })
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid TokenUser SID"))
    })();
    unsafe {
        LocalFree(string_sid.cast());
    }
    result
}

#[cfg(windows)]
fn private_windows_sddl(base: &str, ace_flags: &str) -> io::Result<String> {
    let token_user = current_process_user_sid_string()?;
    Ok(format!("{base}(A;{ace_flags};FA;;;{token_user})"))
}

#[cfg(windows)]
fn apply_and_verify_private_windows_dacl(
    path: &Path,
    sddl: &str,
    expected_ace_flags: u8,
) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            AclSizeInformation,
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            GetAclInformation, GetFileSecurityW, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, SetFileSecurityW, ACL_SIZE_INFORMATION,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let wide_sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(io::Error::last_os_error());
    }

    let result = (|| {
        let applied = unsafe {
            SetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        };
        if applied == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut needed = 0u32;
        unsafe {
            GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let word_size = mem::size_of::<usize>();
        let mut security = vec![0usize; (needed as usize).div_ceil(word_size)];
        let read = unsafe {
            GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                security.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        let observed = security.as_mut_ptr().cast();
        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(observed, &mut control, &mut revision) } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL protection could not be verified",
            ));
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = ptr::null_mut();
        if unsafe { GetSecurityDescriptorDacl(observed, &mut present, &mut dacl, &mut defaulted) }
            == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL presence could not be verified",
            ));
        }
        let mut acl_info = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
                mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || acl_info.AceCount != 4
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL entries could not be verified",
            ));
        }
        verify_private_windows_aces(dacl, expected_ace_flags, FILE_ALL_ACCESS)?;
        Ok(())
    })();
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
fn verify_private_windows_aces(
    dacl: *mut windows_sys::Win32::Security::ACL,
    expected_ace_flags: u8,
    expected_mask: u32,
) -> io::Result<()> {
    use std::{mem, ptr};
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetAce, TokenUser, WinBuiltinAdministratorsSid,
        WinCreatorOwnerRightsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE, SECURITY_MAX_SID_SIZE,
        TOKEN_USER,
    };

    let mut well_known_sids = Vec::new();
    for sid_type in [
        WinCreatorOwnerRightsSid,
        WinLocalSystemSid,
        WinBuiltinAdministratorsSid,
    ] {
        let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = SECURITY_MAX_SID_SIZE;
        if unsafe {
            CreateWellKnownSid(
                sid_type,
                ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        sid.truncate(size as usize);
        well_known_sids.push(sid);
    }

    let token = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token.as_ptr().cast::<TOKEN_USER>() };
    let mut expected_sids: Vec<_> = well_known_sids
        .iter()
        .map(|sid| sid.as_ptr().cast_mut().cast())
        .collect();
    expected_sids.push(token_user.User.Sid);

    let mut matched = vec![false; expected_sids.len()];
    for index in 0..expected_sids.len() as u32 {
        let mut raw_ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(io::Error::last_os_error());
        }
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        // ACCESS_ALLOWED_ACE_TYPE is zero. The literal avoids adding
        // Win32_System_SystemServices solely for this discriminator.
        if ace.Header.AceType != 0
            || ace.Header.AceFlags != expected_ace_flags
            || ace.Mask != expected_mask
            || usize::from(ace.Header.AceSize) < mem::size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL ACE policy could not be verified",
            ));
        }
        let observed_sid = (&ace.SidStart as *const u32).cast_mut().cast();
        let Some(expected_index) =
            expected_sids
                .iter()
                .enumerate()
                .position(|(expected_index, expected)| {
                    !matched[expected_index] && unsafe { EqualSid(observed_sid, *expected) != 0 }
                })
        else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL trustee could not be verified",
            ));
        };
        matched[expected_index] = true;
    }
    if !matched.into_iter().all(|value| value) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private DACL is missing a required trustee",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn make_directory_private(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private crash-draft ACL support is unavailable",
    ))
}

#[cfg(not(any(unix, windows)))]
fn make_file_private(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private crash-draft ACL support is unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        fs,
        io::Read,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::Duration,
    };

    use tempfile::TempDir;

    use super::*;

    #[derive(Clone)]
    struct TestClock(Arc<AtomicU64>);

    impl TestClock {
        fn new(now: u64) -> Self {
            Self(Arc::new(AtomicU64::new(now)))
        }

        fn set(&self, now: u64) {
            self.0.store(now, Ordering::SeqCst);
        }
    }

    impl DraftClock for TestClock {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[derive(Clone, Default)]
    struct TestWriter {
        calls: Arc<Mutex<Vec<String>>>,
        fail_next_delete: Arc<AtomicBool>,
        replace_before_delete: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl TestWriter {
        fn version(path: &Path) -> Option<String> {
            let bytes = fs::read(path).ok()?;
            Some(format!("{:x}", Sha256::digest(bytes)))
        }

        fn overwrite(path: &Path, bytes: &[u8]) {
            fs::write(path, bytes).unwrap();
        }
    }

    impl DraftWritePort for TestWriter {
        type Version = String;

        fn observe(
            &self,
            path: &Path,
            max_bytes: usize,
        ) -> Result<DraftObservation<String>, String> {
            let Some(version) = Self::version(path) else {
                return Ok(DraftObservation::Missing);
            };
            let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
            let mut bytes = Vec::new();
            fs::File::open(path)
                .map_err(|error| error.to_string())?
                .take((max_bytes as u64).saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok(DraftObservation::Present {
                bytes,
                size,
                version: version.clone(),
                version_token: version,
            })
        }

        fn persist(
            &self,
            destination: &Path,
            bytes: &[u8],
            expected: ExpectedDraftState<String>,
        ) -> DraftWriteOutcome<String> {
            self.calls.lock().unwrap().push(match &expected {
                ExpectedDraftState::Absent => "persist:absent".into(),
                ExpectedDraftState::Exact(_) => "persist:exact".into(),
            });
            let current = Self::version(destination);
            let matches = match expected {
                ExpectedDraftState::Absent => current.is_none(),
                ExpectedDraftState::Exact(expected) => current.as_ref() == Some(&expected),
            };
            if !matches {
                return DraftWriteOutcome::Conflict {
                    current_version: current,
                    recovery_paths: vec![destination.to_path_buf()],
                };
            }
            fs::write(destination, bytes).unwrap();
            let version = Self::version(destination).unwrap();
            DraftWriteOutcome::ConfirmedCommitted {
                version: version.clone(),
                version_token: version,
                recovery_paths: Vec::new(),
            }
        }

        fn remove_exact(
            &self,
            destination: &Path,
            expected: &String,
        ) -> DraftDeleteOutcome<String> {
            self.calls.lock().unwrap().push("delete:exact".into());
            if let Some(replacement) = self.replace_before_delete.lock().unwrap().take() {
                Self::overwrite(destination, &replacement);
            }
            let current = Self::version(destination);
            if self.fail_next_delete.swap(false, Ordering::SeqCst)
                || current.as_ref() != Some(expected)
            {
                return DraftDeleteOutcome::Conflict {
                    current_version: current,
                    recovery_paths: vec![destination.to_path_buf()],
                };
            }
            fs::remove_file(destination).unwrap();
            DraftDeleteOutcome::ConfirmedDeleted
        }
    }

    fn id(index: usize) -> String {
        format!("{index:032x}")
    }

    fn request(index: usize, revision: u64, content: impl Into<String>) -> CrashDraftWriteRequest {
        CrashDraftWriteRequest {
            document_id: id(index),
            file_kind: CrashDraftFileKind::Markdown,
            revision,
            path_hint: None,
            base_version_token: None,
            content: content.into(),
        }
    }

    fn setup(
        now: u64,
    ) -> (
        TempDir,
        CrashDraftStore<TestWriter, TestClock>,
        TestClock,
        TestWriter,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let clock = TestClock::new(now);
        let writer = TestWriter::default();
        let store = CrashDraftStore::new(temp.path(), writer.clone(), clock.clone());
        (temp, store, clock, writer)
    }

    fn root(temp: &TempDir) -> PathBuf {
        temp.path().join("crash-drafts/v1")
    }

    fn supported(catalog: &CrashDraftCatalog) -> Vec<&CrashDraftSummary> {
        catalog
            .entries
            .iter()
            .filter_map(|entry| match entry {
                CrashDraftListEntry::Supported { draft } => Some(draft),
                CrashDraftListEntry::Protected { .. } => None,
            })
            .collect()
    }

    fn assert_opaque_receipt(receipt: &str) {
        assert_eq!(receipt.len(), 64);
        assert!(receipt
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    fn assert_serialization_hides_paths(value: &impl Serialize, private_root: &Path) {
        let json = serde_json::to_string(value).unwrap();
        let root = private_root.to_string_lossy();
        assert!(!json.contains(root.as_ref()));
        for component in private_root.components() {
            let component = component.as_os_str().to_string_lossy();
            if component.len() >= 6 {
                assert!(!json.contains(component.as_ref()));
            }
        }
    }

    #[test]
    fn validates_opaque_untitled_pair_unicode_and_size_contracts() {
        let (_temp, store, _clock, _writer) = setup(10);
        let mut invalid = request(1, 1, "text");
        invalid.document_id = "ABC/path-derived".into();
        assert_eq!(
            store.write(invalid).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        assert_eq!(
            store.write(request(1, 0, "")).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        let empty = store.write(request(1, 1, "")).unwrap();
        assert_eq!(empty.path_hint, None);
        let unicode = store.write(request(2, 1, "你好\n🙂\nمرحبا")).unwrap();
        assert_eq!(
            store
                .recover(&id(2), &unicode.entry_token)
                .unwrap()
                .envelope
                .content,
            "你好\n🙂\nمرحبا"
        );
        let mut unpaired = request(3, 1, "x");
        unpaired.path_hint = Some("/hint".into());
        assert_eq!(
            store.write(unpaired).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        let mut long_path = request(3, 1, "x");
        long_path.path_hint = Some("p".repeat(MAX_PATH_HINT_BYTES + 1));
        long_path.base_version_token = Some("b".repeat(64));
        assert_eq!(
            store.write(long_path).unwrap_err().code,
            CrashDraftErrorCode::Oversized
        );
        assert_eq!(
            store
                .write(request(3, 1, "x".repeat(MAX_DRAFT_CONTENT_BYTES + 1)))
                .unwrap_err()
                .code,
            CrashDraftErrorCode::Oversized
        );
        assert_eq!(
            store
                .write(request(3, JS_SAFE_INTEGER + 1, "x"))
                .unwrap_err()
                .code,
            CrashDraftErrorCode::Invalid
        );
        store
            .write(request(4, JS_SAFE_INTEGER, "max revision"))
            .unwrap();
    }

    #[test]
    fn validates_path_hint_controls_and_exact_base_token_format() {
        let (_temp, store, _clock, _writer) = setup(10);
        let mut valid = request(1, 1, "x");
        valid.path_hint = Some("C:\\notes\\文档.md".into());
        valid.base_version_token = Some("a".repeat(64));
        store.write(valid).unwrap();

        for (index, path) in [
            "/notes/bad\nname.md",
            "/notes/bad\0name.md",
            "/notes/\u{200b}name.md",
            "/notes/\u{202e}name.md",
        ]
        .into_iter()
        .enumerate()
        {
            let mut invalid = request(index + 2, 1, "x");
            invalid.path_hint = Some(path.into());
            invalid.base_version_token = Some("b".repeat(64));
            assert_eq!(
                store.write(invalid).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
        }

        for (index, token) in [
            "a".repeat(63),
            "A".repeat(64),
            format!("{}\n", "a".repeat(63)),
        ]
        .into_iter()
        .enumerate()
        {
            let mut invalid = request(index + 10, 1, "x");
            invalid.path_hint = Some("/notes/file.md".into());
            invalid.base_version_token = Some(token);
            assert_eq!(
                store.write(invalid).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
        }
    }

    #[test]
    fn directory_scan_is_bounded_before_candidate_processing() {
        let (temp, store, _clock, writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        for index in 0..MAX_CRASH_DRAFT_DIRECTORY_ENTRIES {
            fs::write(root(&temp).join(format!("unrelated-{index}.tmp")), b"x").unwrap();
        }
        let error = store.list().unwrap_err();
        assert_eq!(error.code, CrashDraftErrorCode::Capacity);
        let mut receipt = error.repair_receipt.unwrap();
        assert_opaque_receipt(&receipt);
        assert!(writer.calls.lock().unwrap().is_empty());
        assert_eq!(
            store.reset_overflow_batch("stale").unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        let mut total_removed = 0usize;
        for _ in 0..8 {
            let progress = store.reset_overflow_batch(&receipt).unwrap();
            assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
            total_removed += progress.removed_entries;
            if !progress.more_work_remaining {
                break;
            }
            receipt = progress.repair_receipt.unwrap();
        }
        assert_eq!(total_removed, MAX_CRASH_DRAFT_DIRECTORY_ENTRIES);
        assert!(store.list().unwrap().entries.is_empty());
        assert_eq!(
            store.reset_overflow_batch(&receipt).unwrap_err().code,
            CrashDraftErrorCode::Conflict
        );
        assert!(writer
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| call == "delete:exact"));
    }

    #[test]
    fn protected_logical_count_overflow_issues_restartable_bounded_reset_receipts() {
        let (temp, store, clock, writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        for index in 0..(MAX_DRAFT_ENTRIES + 1) {
            fs::write(root(&temp).join(format!("{}.json", id(index))), b"invalid").unwrap();
        }
        let first = store.list().unwrap_err().repair_receipt.unwrap();
        assert_opaque_receipt(&first);
        drop(store);

        let restarted = CrashDraftStore::new(temp.path(), writer, clock);
        let mut receipt = restarted.list().unwrap_err().repair_receipt.unwrap();
        assert_ne!(first, receipt);
        let mut removed = 0;
        loop {
            let progress = restarted.reset_overflow_batch(&receipt).unwrap();
            assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
            removed += progress.removed_entries;
            if !progress.more_work_remaining {
                break;
            }
            receipt = progress.repair_receipt.unwrap();
        }
        assert_eq!(removed, MAX_DRAFT_ENTRIES + 1);
        assert!(restarted.list().unwrap().entries.is_empty());
    }

    #[test]
    fn protected_logical_byte_overflow_issues_a_bounded_reset_receipt() {
        let (temp, store, _clock, _writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        let oversized = vec![b'x'; MAX_DRAFT_ENVELOPE_BYTES + 1];
        for index in 0..4 {
            fs::write(root(&temp).join(format!("{}.json", id(index))), &oversized).unwrap();
        }
        let error = store.list().unwrap_err();
        assert_eq!(error.code, CrashDraftErrorCode::Capacity);
        let receipt = error.repair_receipt.unwrap();
        let progress = store.reset_overflow_batch(&receipt).unwrap();
        assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
    }

    #[test]
    fn malformed_boundary_tokens_are_rejected_before_lock_or_scan() {
        let (temp, store, _clock, writer) = setup(10);
        for malformed in ["", "a", &"A".repeat(64), &"a".repeat(65)] {
            assert_eq!(
                store.recover(&id(1), malformed).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
            assert_eq!(
                store.discard(&id(1), malformed).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
            assert_eq!(
                store.reset(malformed).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
            assert_eq!(
                store.reset_overflow_batch(malformed).unwrap_err().code,
                CrashDraftErrorCode::Invalid
            );
        }
        assert!(!root(&temp).exists());
        assert!(writer.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn retained_artifact_blocks_healthy_list_and_write_until_receipted_cleanup() {
        let (temp, store, _clock, _writer) = setup(10);
        store.write(request(1, 1, "safe")).unwrap();
        fs::write(
            root(&temp).join(".draft.json.recovery-retained"),
            b"private",
        )
        .unwrap();

        let error = store.list().unwrap_err();
        let receipt = error.repair_receipt.unwrap();
        assert_eq!(error.code, CrashDraftErrorCode::Capacity);
        assert_eq!(
            store.write(request(2, 1, "blocked")).unwrap_err().code,
            CrashDraftErrorCode::Capacity
        );
        let replacement_receipt = store.list().unwrap_err().repair_receipt.unwrap();
        assert_ne!(receipt, replacement_receipt);
        let progress = store.reset_overflow_batch(&replacement_receipt).unwrap();
        assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
        assert!(store.list().unwrap().entries.len() <= 1);
    }

    #[test]
    fn repair_receipt_is_bound_to_the_scanned_physical_store_fingerprint() {
        let (temp, store, _clock, writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        let artifact = root(&temp).join(".draft.json.recovery-retained");
        fs::write(&artifact, b"first").unwrap();
        let receipt = store.list().unwrap_err().repair_receipt.unwrap();
        fs::write(&artifact, b"other").unwrap();

        assert_eq!(
            store.reset_overflow_batch(&receipt).unwrap_err().code,
            CrashDraftErrorCode::Conflict
        );
        assert_eq!(fs::read(&artifact).unwrap(), b"other");
        assert!(writer.calls.lock().unwrap().is_empty());
        assert_eq!(
            store.reset_overflow_batch(&receipt).unwrap_err().code,
            CrashDraftErrorCode::Conflict
        );
    }

    #[test]
    fn total_size_accounting_rejects_integer_overflow() {
        let entries = vec![
            ScannedEntry::Protected {
                document_id: id(1),
                path: PathBuf::from("one"),
                size: u64::MAX,
                token: "one".into(),
                version: "one".to_string(),
                reason: ProtectedDraftReason::Oversized,
                future_schema_version: None,
            },
            ScannedEntry::Protected {
                document_id: id(2),
                path: PathBuf::from("two"),
                size: 1,
                token: "two".into(),
                version: "two".to_string(),
                reason: ProtectedDraftReason::Oversized,
                future_schema_version: None,
            },
        ];
        assert_eq!(
            checked_total_size(&entries).unwrap_err().code,
            CrashDraftErrorCode::Capacity
        );
        assert_eq!(
            ensure_protected_capacity(&entries[..1], &id(3), 1)
                .unwrap_err()
                .code,
            CrashDraftErrorCode::Capacity
        );
    }

    #[test]
    fn checksum_binds_all_metadata_and_content() {
        let (_temp, store, _clock, _writer) = setup(10);
        let summary = store.write(request(1, 1, "text")).unwrap();
        let original = store
            .recover(&id(1), &summary.entry_token)
            .unwrap()
            .envelope;
        let checksum = envelope_checksum(&original);
        let mut variants = Vec::new();
        let mut value = original.clone();
        value.schema_version += 1;
        variants.push(value);
        let mut value = original.clone();
        value.document_id = id(2);
        variants.push(value);
        let mut value = original.clone();
        value.file_kind = CrashDraftFileKind::Html;
        variants.push(value);
        let mut value = original.clone();
        value.revision += 1;
        variants.push(value);
        let mut value = original.clone();
        value.updated_at_ms += 1;
        variants.push(value);
        let mut value = original.clone();
        value.path_hint = Some("/p".into());
        variants.push(value);
        let mut value = original.clone();
        value.base_version_token = Some("v".into());
        variants.push(value);
        let mut value = original;
        value.content.push('!');
        variants.push(value);
        assert!(variants
            .into_iter()
            .all(|value| envelope_checksum(&value) != checksum));
    }

    #[test]
    fn write_uses_expected_absent_then_exact_and_revision_is_not_the_cas() {
        let (_temp, store, _clock, writer) = setup(10);
        let first = store.write(request(1, 1, "a")).unwrap();
        let second = store.write(request(1, 2, "b")).unwrap();
        assert_eq!(first.write_status, Some(CrashDraftWriteStatus::Stored));
        assert_eq!(second.write_status, Some(CrashDraftWriteStatus::Stored));
        assert_eq!(
            writer.calls.lock().unwrap().as_slice(),
            ["persist:absent", "persist:exact"]
        );
    }

    #[derive(Clone)]
    struct OutcomeWriter {
        inner: TestWriter,
        outcome: Arc<Mutex<Option<&'static str>>>,
    }

    impl DraftWritePort for OutcomeWriter {
        type Version = String;

        fn observe(&self, path: &Path, max: usize) -> Result<DraftObservation<String>, String> {
            self.inner.observe(path, max)
        }

        fn persist(
            &self,
            destination: &Path,
            bytes: &[u8],
            expected: ExpectedDraftState<String>,
        ) -> DraftWriteOutcome<String> {
            match self.outcome.lock().unwrap().take() {
                Some("not_committed") => DraftWriteOutcome::ConfirmedNotCommitted {
                    current_version: TestWriter::version(destination),
                    recovery_paths: vec![destination.with_extension("recovery")],
                },
                Some("conflict") => DraftWriteOutcome::Conflict {
                    current_version: TestWriter::version(destination),
                    recovery_paths: vec![destination.with_extension("conflict")],
                },
                Some("indeterminate") => {
                    TestWriter::overwrite(destination, bytes);
                    DraftWriteOutcome::Indeterminate {
                        recovery_paths: vec![destination.to_path_buf()],
                    }
                }
                Some("committed_recovery") => {
                    match self.inner.persist(destination, bytes, expected) {
                        DraftWriteOutcome::ConfirmedCommitted {
                            version,
                            version_token,
                            ..
                        } => DraftWriteOutcome::ConfirmedCommitted {
                            version,
                            version_token,
                            recovery_paths: vec![destination.with_extension("displaced")],
                        },
                        outcome => outcome,
                    }
                }
                _ => self.inner.persist(destination, bytes, expected),
            }
        }

        fn remove_exact(&self, path: &Path, expected: &String) -> DraftDeleteOutcome<String> {
            self.inner.remove_exact(path, expected)
        }
    }

    #[test]
    fn maps_not_committed_conflict_and_post_mutation_indeterminate_with_evidence() {
        for (outcome, disposition) in [
            (
                "not_committed",
                CrashDraftPersistenceDisposition::ConfirmedNotCommitted,
            ),
            ("conflict", CrashDraftPersistenceDisposition::Conflict),
            (
                "indeterminate",
                CrashDraftPersistenceDisposition::Indeterminate,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let writer = OutcomeWriter {
                inner: TestWriter::default(),
                outcome: Arc::new(Mutex::new(None)),
            };
            let control = writer.outcome.clone();
            let store = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
            store.write(request(1, 1, "old material")).unwrap();
            *control.lock().unwrap() = Some(outcome);
            let error = store.write(request(1, 2, "new material")).unwrap_err();
            assert_eq!(error.disposition, Some(disposition));
            assert!(!error.recovery_paths.is_empty());
            assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
            assert_serialization_hides_paths(&error, temp.path());
            if outcome == "indeterminate" {
                let bytes = fs::read(root(&temp).join(format!("{}.json", id(1)))).unwrap();
                assert!(String::from_utf8(bytes).unwrap().contains("new material"));
            } else {
                let catalog = store.list().unwrap();
                let draft = supported(&catalog)[0];
                assert_eq!(
                    store
                        .recover(&id(1), &draft.entry_token)
                        .unwrap()
                        .envelope
                        .content,
                    "old material"
                );
            }
        }
    }

    #[test]
    fn confirmed_commit_preserves_recovery_evidence_in_the_write_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let writer = OutcomeWriter {
            inner: TestWriter::default(),
            outcome: Arc::new(Mutex::new(Some("committed_recovery"))),
        };
        let store = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
        let receipt = store.write(request(1, 1, "material")).unwrap();
        assert_eq!(
            receipt.recovery_paths,
            [root(&temp)
                .join(format!("{}.json", id(1)))
                .with_extension("displaced")]
        );
        assert_eq!(
            receipt.repair_required,
            Some(CrashDraftRepairRequired::CleanupRepair)
        );
        assert_opaque_receipt(receipt.repair_receipt.as_deref().unwrap());
        assert_serialization_hides_paths(&receipt, temp.path());
    }

    #[test]
    fn padded_oversized_corrupt_and_future_entries_are_protected_without_leaks() {
        let (temp, store, _clock, _writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        fs::write(
            root(&temp).join(format!("{}.json", id(1))),
            vec![b' '; MAX_DRAFT_ENVELOPE_BYTES + 1],
        )
        .unwrap();
        fs::write(
            root(&temp).join(format!("{}.json", id(2))),
            br#"{"pathHint":"secret","content":"secret"}"#,
        )
        .unwrap();
        fs::write(
            root(&temp).join(format!("{}.json", id(3))),
            br#"{"schemaVersion":2,"pathHint":"future-secret"}"#,
        )
        .unwrap();
        let valid = store.write(request(4, 1, "valid")).unwrap();
        let strict_path = root(&temp).join(format!("{}.json", id(4)));
        let mut strict_value: serde_json::Value =
            serde_json::from_slice(&fs::read(&strict_path).unwrap()).unwrap();
        strict_value["unknownField"] = serde_json::Value::Bool(true);
        fs::write(&strict_path, serde_json::to_vec(&strict_value).unwrap()).unwrap();
        let catalog = store.list().unwrap();
        let future = catalog
            .entries
            .iter()
            .find(|entry| {
                matches!(
                    entry,
                    CrashDraftListEntry::Protected { document_id, .. } if *document_id == id(3)
                )
            })
            .unwrap();
        match future {
            CrashDraftListEntry::Protected {
                raw_size_bytes,
                future_schema_version,
                ..
            } => {
                assert!(*raw_size_bytes > 0);
                assert_eq!(*future_schema_version, Some(2));
            }
            CrashDraftListEntry::Supported { .. } => unreachable!(),
        }
        let json = serde_json::to_string(&catalog).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("rawSizeBytes"));
        assert!(!json.contains("futureSchemaVersion"));
        assert!(json.contains("oversized"));
        assert!(json.contains("corrupt"));
        assert!(json.contains("unsupported_schema"));
        assert!(catalog.entries.iter().any(|entry| matches!(
            entry,
            CrashDraftListEntry::Protected { document_id, reason: ProtectedDraftReason::Corrupt, .. }
                if *document_id == valid.document_id
        )));
    }

    #[test]
    fn deterministic_eviction_persists_incoming_first_and_never_evicts_protected() {
        let (temp, store, clock, writer) = setup(100);
        for index in 1..=MAX_DRAFT_ENTRIES {
            clock.set(100 + index as u64);
            store.write(request(index, 1, "x")).unwrap();
        }
        writer.calls.lock().unwrap().clear();
        let receipt = store
            .write(request(MAX_DRAFT_ENTRIES + 1, 1, "new"))
            .unwrap();
        assert_eq!(receipt.evicted_document_ids, [id(1)]);
        let calls = writer.calls.lock().unwrap().clone();
        assert_eq!(calls, ["persist:absent", "delete:exact"]);
        let catalog = store.list().unwrap();
        let ids: HashSet<_> = supported(&catalog)
            .iter()
            .map(|draft| draft.document_id.clone())
            .collect();
        assert!(!ids.contains(&id(1)));

        let protected_path = root(&temp).join(format!("{}.json", id(99)));
        fs::write(&protected_path, b"corrupt").unwrap();
        let repaired = store.repair_startup().unwrap();
        assert!(repaired.entries.iter().any(|entry| matches!(entry, CrashDraftListEntry::Protected { document_id, .. } if *document_id == id(99))));
    }

    #[test]
    fn protected_entries_can_fill_capacity_without_being_replaced_or_evicted() {
        let (temp, store, _clock, writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        for index in 1..=MAX_DRAFT_ENTRIES {
            fs::write(root(&temp).join(format!("{}.json", id(index))), b"corrupt").unwrap();
        }
        writer.calls.lock().unwrap().clear();
        let error = store.write(request(99, 1, "incoming")).unwrap_err();
        assert_eq!(error.code, CrashDraftErrorCode::Capacity);
        assert!(writer.calls.lock().unwrap().is_empty());
        assert_eq!(store.list().unwrap().entries.len(), MAX_DRAFT_ENTRIES);
    }

    #[test]
    fn total_limit_uses_updated_revision_id_order() {
        let (temp, store, _clock, _writer) = setup(10);
        fs::create_dir_all(root(&temp)).unwrap();
        let mut entries = Vec::new();
        for index in 1..=6 {
            let path = root(&temp).join(format!("{}.json", id(index)));
            fs::write(&path, b"x").unwrap();
            let version = TestWriter::version(&path).unwrap();
            entries.push(ScannedEntry::Supported {
                envelope: CrashDraftEnvelope {
                    schema_version: 1,
                    document_id: id(index),
                    file_kind: CrashDraftFileKind::Markdown,
                    revision: if index < 3 { 1 } else { index as u64 },
                    updated_at_ms: 10,
                    path_hint: None,
                    base_version_token: None,
                    content: "x".into(),
                    checksum: "test".into(),
                },
                path,
                size: 4 * 1024 * 1024,
                token: format!("token-{index}"),
                version,
            });
        }
        store.repair_limits(&mut entries, Some(&id(6))).unwrap();
        assert!(entries.iter().all(|entry| entry.id() != id(1)));
    }

    #[test]
    fn conditional_discard_and_reset_do_not_delete_racing_replacements() {
        let (temp, store, _clock, writer) = setup(10);
        let summary = store.write(request(1, 1, "old")).unwrap();
        let path = root(&temp).join(format!("{}.json", id(1)));
        *writer.replace_before_delete.lock().unwrap() = Some(b"newer replacement".to_vec());
        assert_eq!(
            store
                .discard(&id(1), &summary.entry_token)
                .unwrap_err()
                .disposition,
            Some(CrashDraftPersistenceDisposition::Conflict)
        );
        assert_eq!(fs::read(&path).unwrap(), b"newer replacement");

        let catalog = store.list().unwrap();
        *writer.replace_before_delete.lock().unwrap() = Some(b"newest replacement".to_vec());
        let error = store.reset(&catalog.catalog_token).unwrap_err();
        assert_eq!(
            error.disposition,
            Some(CrashDraftPersistenceDisposition::Conflict)
        );
        assert!(path.exists());
    }

    #[test]
    fn conditional_delete_maps_not_deleted_and_indeterminate_without_losing_evidence() {
        let recovery = PathBuf::from("recovery-copy");
        let not_deleted = map_delete_outcome::<String>(DraftDeleteOutcome::ConfirmedNotDeleted {
            current_version: Some("current".into()),
            recovery_paths: vec![recovery.clone()],
        })
        .unwrap_err();
        assert_eq!(
            not_deleted.disposition,
            Some(CrashDraftPersistenceDisposition::ConfirmedNotCommitted)
        );
        assert_eq!(not_deleted.recovery_paths, [recovery.clone()]);
        assert!(!serde_json::to_string(&not_deleted)
            .unwrap()
            .contains("recovery-copy"));

        let indeterminate = map_delete_outcome::<String>(DraftDeleteOutcome::Indeterminate {
            recovery_paths: vec![recovery.clone()],
        })
        .unwrap_err();
        assert_eq!(
            indeterminate.disposition,
            Some(CrashDraftPersistenceDisposition::Indeterminate)
        );
        assert_eq!(indeterminate.recovery_paths, [recovery]);
        assert!(!serde_json::to_string(&indeterminate)
            .unwrap()
            .contains("recovery-copy"));
    }

    #[test]
    fn eviction_failure_reports_committed_and_restart_repairs() {
        let (temp, store, clock, writer) = setup(100);
        for index in 1..=MAX_DRAFT_ENTRIES {
            clock.set(100 + index as u64);
            store.write(request(index, 1, "x")).unwrap();
        }
        writer.fail_next_delete.store(true, Ordering::SeqCst);
        let error = store
            .write(request(MAX_DRAFT_ENTRIES + 1, 1, "incoming"))
            .unwrap_err();
        assert_eq!(error.code, CrashDraftErrorCode::CommittedNeedsRepair);
        assert_eq!(
            error.disposition,
            Some(CrashDraftPersistenceDisposition::ConfirmedCommitted)
        );
        assert_eq!(
            error.repair_required,
            Some(CrashDraftRepairRequired::LimitRepair)
        );
        assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
        let incoming = root(&temp).join(format!("{}.json", id(MAX_DRAFT_ENTRIES + 1)));
        assert!(!error.recovery_paths.contains(&incoming));
        assert_serialization_hides_paths(&error, temp.path());
        assert_eq!(
            store.list().unwrap_err().code,
            CrashDraftErrorCode::Capacity
        );
        drop(store);
        let restarted = CrashDraftStore::new(temp.path(), writer, clock);
        assert_eq!(
            restarted.repair_startup().unwrap().entries.len(),
            MAX_DRAFT_ENTRIES
        );
    }

    #[test]
    fn backward_clock_revision_idempotency_and_token_conflicts_are_stable() {
        let (_temp, store, clock, writer) = setup(100);
        let first = store.write(request(1, 1, "a")).unwrap();
        clock.set(50);
        let second = store.write(request(2, 1, "b")).unwrap();
        assert_eq!(second.updated_at_ms, first.updated_at_ms + 1);
        writer.calls.lock().unwrap().clear();
        let mut unchanged = first.clone();
        unchanged.write_status = Some(CrashDraftWriteStatus::Unchanged);
        assert_eq!(store.write(request(1, 1, "a")).unwrap(), unchanged);
        assert!(writer.calls.lock().unwrap().is_empty());
        assert_eq!(
            store.write(request(1, 1, "changed")).unwrap_err().code,
            CrashDraftErrorCode::Conflict
        );
        let newer = store.write(request(1, 2, "new")).unwrap();
        assert_eq!(
            store.recover(&id(1), &first.entry_token).unwrap_err().code,
            CrashDraftErrorCode::Conflict
        );
        store.discard(&id(1), &newer.entry_token).unwrap();
    }

    #[test]
    fn token_bound_reset_removes_protected_and_list_recover_never_probe_hint() {
        let (temp, store, _clock, _writer) = setup(100);
        let forbidden = temp.path().join("must-not-be-probed");
        let mut write = request(1, 1, "safe");
        write.path_hint = Some(forbidden.to_string_lossy().into_owned());
        write.base_version_token = Some("b".repeat(64));
        let summary = store.write(write).unwrap();
        assert!(!forbidden.exists());
        assert_eq!(
            store
                .recover(&id(1), &summary.entry_token)
                .unwrap()
                .envelope
                .content,
            "safe"
        );
        assert!(!forbidden.exists());
        fs::write(root(&temp).join(format!("{}.json", id(2))), b"corrupt").unwrap();
        let catalog = store.list().unwrap();
        assert_eq!(
            store.reset("stale").unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        store.reset(&catalog.catalog_token).unwrap();
        assert!(store.list().unwrap().entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn storage_permissions_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, store, _clock, _writer) = setup(100);
        store.write(request(1, 1, "a")).unwrap();
        assert_eq!(
            fs::metadata(root(&temp)).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root(&temp).join(LOCK_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(root(&temp).join(format!("{}.json", id(1))))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn private_descriptor_policy_is_protected_and_principal_minimal() {
        assert!(PRIVATE_DIRECTORY_SDDL.starts_with("D:P"));
        assert!(PRIVATE_FILE_SDDL.starts_with("D:P"));
        for principal in [";;;OW)", ";;;SY)", ";;;BA)"] {
            assert!(PRIVATE_DIRECTORY_SDDL.contains(principal));
            assert!(PRIVATE_FILE_SDDL.contains(principal));
        }
        assert_eq!(PRIVATE_DIRECTORY_SDDL.matches(";FA;").count(), 3);
        assert_eq!(PRIVATE_FILE_SDDL.matches(";FA;").count(), 3);
        assert_eq!(PRIVATE_DIRECTORY_SDDL.matches("OICI").count(), 3);
        assert!(!PRIVATE_FILE_SDDL.contains("OICI"));
        for forbidden in [";;;WD)", ";;;BU)", ";;;AU)", ";;;AN)"] {
            assert!(!PRIVATE_DIRECTORY_SDDL.contains(forbidden));
            assert!(!PRIVATE_FILE_SDDL.contains(forbidden));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_dacl_smoke_for_directory_and_file() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("private-directory");
        fs::create_dir(&directory).unwrap();
        make_directory_private(&directory).unwrap();
        let file = directory.join("private-file");
        fs::write(&file, b"private").unwrap();
        make_file_private(&file).unwrap();
    }

    #[cfg(not(any(unix, windows)))]
    #[test]
    fn unsupported_private_acl_backend_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            make_directory_private(temp.path()).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        assert_eq!(
            make_file_private(&temp.path().join("draft"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn privacy_repair_receipt_never_classifies_live_destination_as_recovery_material() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("authoritative-draft.json");
        let error = committed_needs_repair(
            CrashDraftRepairRequired::PrivacyRepair,
            Vec::new(),
            std::slice::from_ref(&destination),
        );
        assert!(error.recovery_paths.is_empty());
        assert_eq!(
            error.repair_required,
            Some(CrashDraftRepairRequired::PrivacyRepair)
        );
        assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
        assert_serialization_hides_paths(&error, temp.path());
    }

    #[derive(Clone)]
    struct BlockingWriter {
        inner: TestWriter,
        entered: Arc<Mutex<Option<mpsc::Sender<()>>>>,
        release: Arc<Mutex<mpsc::Receiver<()>>>,
    }

    impl DraftWritePort for BlockingWriter {
        type Version = String;

        fn observe(&self, path: &Path, max: usize) -> Result<DraftObservation<String>, String> {
            self.inner.observe(path, max)
        }

        fn persist(
            &self,
            path: &Path,
            bytes: &[u8],
            expected: ExpectedDraftState<String>,
        ) -> DraftWriteOutcome<String> {
            if let Some(sender) = self.entered.lock().unwrap().take() {
                sender.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            self.inner.persist(path, bytes, expected)
        }

        fn remove_exact(&self, path: &Path, expected: &String) -> DraftDeleteOutcome<String> {
            self.inner.remove_exact(path, expected)
        }
    }

    #[test]
    fn two_store_instances_serialize_on_the_filesystem_lock() {
        let temp = tempfile::tempdir().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = BlockingWriter {
            inner: TestWriter::default(),
            entered: Arc::new(Mutex::new(Some(entered_tx))),
            release: Arc::new(Mutex::new(release_rx)),
        };
        let first = CrashDraftStore::new(temp.path(), writer.clone(), TestClock::new(10));
        let second = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
        let first_thread = thread::spawn(move || first.write(request(1, 1, "a")));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (listed_tx, listed_rx) = mpsc::channel();
        let second_thread = thread::spawn(move || listed_tx.send(second.list()).unwrap());
        assert!(listed_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        first_thread.join().unwrap().unwrap();
        listed_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        second_thread.join().unwrap();
    }
}
