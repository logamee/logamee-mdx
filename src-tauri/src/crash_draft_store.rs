use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    crash_drafts::{
        DraftClock, DraftDeleteOutcome, DraftObservation, DraftWriteOutcome, DraftWritePort,
        ExpectedDraftState,
    },
    durable_write::{
        durable_remove_exact, durable_write, observe_versioned_file, DurableDeleteOutcome,
        DurableWriteOutcome, ExpectedFileState, FileVersion,
    },
};

#[derive(Default)]
pub(crate) struct SystemDraftClock;

impl DraftClock for SystemDraftClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

#[derive(Default)]
pub(crate) struct DurableDraftWriter;

impl DraftWritePort for DurableDraftWriter {
    type Version = FileVersion;

    fn observe(
        &self,
        path: &Path,
        max_bytes: usize,
    ) -> Result<DraftObservation<Self::Version>, String> {
        match observe_versioned_file(path, max_bytes)
            .map_err(|_| "draft observation failed".to_string())?
        {
            None => Ok(DraftObservation::Missing),
            Some(observed) => {
                let size = observed.version.length();
                let version_token = observed.version.opaque_token();
                Ok(DraftObservation::Present {
                    bytes: observed.bytes,
                    size,
                    version: observed.version,
                    version_token,
                })
            }
        }
    }

    fn persist(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: ExpectedDraftState<Self::Version>,
    ) -> DraftWriteOutcome<Self::Version> {
        let expected = match expected {
            ExpectedDraftState::Absent => ExpectedFileState::Absent,
            ExpectedDraftState::Exact(version) => ExpectedFileState::Exact { version },
        };
        match durable_write(destination, bytes, &expected) {
            Ok(DurableWriteOutcome::ConfirmedCommitted {
                version,
                displaced_path,
            }) => {
                let version_token = version.opaque_token();
                let recovery_paths = displaced_path
                    .into_iter()
                    .flat_map(cleanup_committed_artifact)
                    .collect();
                DraftWriteOutcome::ConfirmedCommitted {
                    version,
                    version_token,
                    recovery_paths,
                }
            }
            Ok(DurableWriteOutcome::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
                ..
            }) => DraftWriteOutcome::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
            },
            Ok(DurableWriteOutcome::Conflict {
                current_version,
                recovery_path,
            }) => DraftWriteOutcome::Conflict {
                current_version,
                recovery_paths: vec![recovery_path],
            },
            Ok(DurableWriteOutcome::Indeterminate { recovery_paths, .. }) => {
                DraftWriteOutcome::Indeterminate { recovery_paths }
            }
            Err(_) => DraftWriteOutcome::ConfirmedNotCommitted {
                current_version: None,
                recovery_paths: Vec::new(),
            },
        }
    }

    fn remove_exact(
        &self,
        destination: &Path,
        expected: &Self::Version,
    ) -> DraftDeleteOutcome<Self::Version> {
        match durable_remove_exact(destination, expected) {
            DurableDeleteOutcome::ConfirmedDeleted => DraftDeleteOutcome::ConfirmedDeleted,
            DurableDeleteOutcome::ConfirmedNotDeleted {
                current_version,
                recovery_paths,
            } => DraftDeleteOutcome::ConfirmedNotDeleted {
                current_version,
                recovery_paths,
            },
            DurableDeleteOutcome::Conflict {
                current_version,
                recovery_paths,
            } => DraftDeleteOutcome::Conflict {
                current_version,
                recovery_paths,
            },
            DurableDeleteOutcome::Indeterminate { recovery_paths } => {
                DraftDeleteOutcome::Indeterminate { recovery_paths }
            }
        }
    }
}

fn cleanup_committed_artifact(path: std::path::PathBuf) -> Vec<std::path::PathBuf> {
    let version = match crate::durable_write::capture_file_version(&path) {
        Ok(Some(version)) => version,
        Ok(None) => return Vec::new(),
        Err(_) => return vec![path],
    };
    match durable_remove_exact(&path, &version) {
        DurableDeleteOutcome::ConfirmedDeleted => Vec::new(),
        DurableDeleteOutcome::ConfirmedNotDeleted { recovery_paths, .. }
        | DurableDeleteOutcome::Conflict { recovery_paths, .. }
        | DurableDeleteOutcome::Indeterminate { recovery_paths } => {
            let mut retained = recovery_paths;
            if path.exists() {
                retained.push(path);
            }
            retained.sort();
            retained.dedup();
            retained
        }
    }
}

pub(crate) type ProductionCrashDraftStore =
    crate::crash_drafts::CrashDraftStore<DurableDraftWriter, SystemDraftClock>;

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::crash_drafts::{CrashDraftFileKind, CrashDraftWriteRequest};

    #[test]
    fn durable_store_survives_restart_and_preserves_unchanged_outcome() {
        let directory = TempDir::new().unwrap();
        let request = CrashDraftWriteRequest {
            document_id: "00000000000000000000000000000001".into(),
            file_kind: CrashDraftFileKind::Markdown,
            revision: 1,
            path_hint: None,
            base_version_token: None,
            content: "unsaved".into(),
        };
        let first =
            ProductionCrashDraftStore::new(directory.path(), DurableDraftWriter, SystemDraftClock);
        let receipt = first.write(request.clone()).unwrap();
        drop(first);

        let restarted =
            ProductionCrashDraftStore::new(directory.path(), DurableDraftWriter, SystemDraftClock);
        restarted.repair_startup().unwrap();
        let unchanged = restarted.write(request).unwrap();
        assert_eq!(unchanged.entry_token, receipt.entry_token);
        assert_eq!(
            unchanged.write_status,
            Some(crate::crash_drafts::CrashDraftWriteStatus::Unchanged)
        );
        assert_eq!(restarted.list().unwrap().entries.len(), 1);
    }

    #[test]
    fn durable_delete_rejects_a_replaced_version_without_removing_it() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("draft.json");
        fs::write(&path, b"first").unwrap();
        let writer = DurableDraftWriter;
        let DraftObservation::Present { version, .. } = writer.observe(&path, 100).unwrap() else {
            panic!("expected observed draft");
        };
        fs::write(&path, b"replacement").unwrap();

        assert!(matches!(
            writer.remove_exact(&path, &version),
            DraftDeleteOutcome::Conflict { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }

    #[test]
    fn durable_observation_returns_a_bounded_sentinel_for_oversized_files() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("oversized.json");
        fs::write(&path, b"oversized").unwrap();

        let DraftObservation::Present { bytes, size, .. } =
            DurableDraftWriter.observe(&path, 4).unwrap()
        else {
            panic!("expected observed draft");
        };

        assert_eq!(bytes, b"overs");
        assert_eq!(size, 9);
    }

    #[test]
    fn overflow_reset_receipts_are_random_single_use_and_batch_bounded() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("crash-drafts").join("v1");
        fs::create_dir_all(&root).unwrap();
        for index in 0..65 {
            fs::write(root.join(format!("{index:032x}.json")), b"invalid").unwrap();
        }
        let store =
            ProductionCrashDraftStore::new(directory.path(), DurableDraftWriter, SystemDraftClock);
        let first = store.list().unwrap_err().repair_receipt.unwrap();
        let second = store.list().unwrap_err().repair_receipt.unwrap();
        assert_ne!(first, second);

        let progress = store.reset_overflow_batch(&second).unwrap();
        assert!(progress.removed_entries <= 16);
        assert!(store.reset_overflow_batch(&second).is_err());
    }

    #[test]
    fn repeated_updates_restart_discard_and_reset_leave_no_private_artifacts() {
        let directory = TempDir::new().unwrap();
        let store =
            ProductionCrashDraftStore::new(directory.path(), DurableDraftWriter, SystemDraftClock);
        for revision in 1..=8 {
            store
                .write(CrashDraftWriteRequest {
                    document_id: "00000000000000000000000000000001".into(),
                    file_kind: CrashDraftFileKind::Markdown,
                    revision,
                    path_hint: None,
                    base_version_token: None,
                    content: format!("revision {revision}"),
                })
                .unwrap();
        }
        let root = directory.path().join("crash-drafts").join("v1");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::write(root.join(".draft.json.recovery-test"), b"private artifact").unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        drop(store);

        let restarted =
            ProductionCrashDraftStore::new(directory.path(), DurableDraftWriter, SystemDraftClock);
        let catalog = restarted.repair_startup().unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let entry = catalog.entries.into_iter().next().unwrap();
        let crate::crash_drafts::CrashDraftListEntry::Supported { draft } = entry else {
            panic!("expected supported draft");
        };
        restarted
            .discard(&draft.document_id, &draft.entry_token)
            .unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }
}
