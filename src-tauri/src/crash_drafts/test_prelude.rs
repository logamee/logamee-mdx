//! Shared crash-draft test imports.
pub(crate) use std::{
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
use crate::private_fs::lowercase_hex;
pub(crate) use tempfile::TempDir;
pub(crate) use super::*;
#[derive(Clone)]
pub(crate) struct TestClock(Arc<AtomicU64>);
impl TestClock {
    pub(crate) fn new(now: u64) -> Self {
        Self(Arc::new(AtomicU64::new(now)))
    }
    pub(crate) fn set(&self, now: u64) {
        self.0.store(now, Ordering::SeqCst);
    }
}
impl DraftClock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Clone, Default)]
pub(crate) struct TestWriter {
    pub(crate) calls: Arc<Mutex<Vec<String>>>,
    pub(crate) fail_next_delete: Arc<AtomicBool>,
    pub(crate) replace_before_delete: Arc<Mutex<Option<Vec<u8>>>>,
}
impl TestWriter {
    pub(crate) fn version(path: &Path) -> Option<String> {
        let bytes = fs::read(path).ok()?;
        Some(lowercase_hex(&Sha256::digest(bytes)))
    }
    pub(crate) fn overwrite(path: &Path, bytes: &[u8]) {
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
pub(crate) fn id(index: usize) -> String {
    format!("{index:032x}")
}
pub(crate) fn request(index: usize, revision: u64, content: impl Into<String>) -> CrashDraftWriteRequest {
    CrashDraftWriteRequest {
        document_id: id(index),
        file_kind: CrashDraftFileKind::Markdown,
        revision,
        path_hint: None,
        base_version_token: None,
        content: content.into(),
    }
}
pub(crate) fn setup(
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
pub(crate) fn root(temp: &TempDir) -> PathBuf {
    temp.path().join("crash-drafts/v1")
}
pub(crate) fn supported(catalog: &CrashDraftCatalog) -> Vec<&CrashDraftSummary> {
    catalog
        .entries
        .iter()
        .filter_map(|entry| match entry {
            CrashDraftListEntry::Supported { draft } => Some(draft),
            CrashDraftListEntry::Protected { .. } => None,
        })
        .collect()
}
pub(crate) fn assert_opaque_receipt(receipt: &str) {
    assert_eq!(receipt.len(), 64);
    assert!(receipt
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
}
pub(crate) fn assert_serialization_hides_paths(value: &impl Serialize, private_root: &Path) {
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
