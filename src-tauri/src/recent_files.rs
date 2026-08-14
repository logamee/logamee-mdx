use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

#[cfg(test)]
use std::ops::{Deref, DerefMut};

use crate::{
    models::{OpenCommitResult, OpenCommitStatus, RecentFileSummary, RecentFilesSnapshot},
    path_auth::{FileAuthorizationSession, WorkspaceReadAuthorization},
    workspace_file_kind::WorkspaceFileKind,
};

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_RECENT_FILES: usize = 5;
const MAX_PENDING_RECEIPTS: usize = 32;
const PENDING_RECEIPT_TTL: Duration = Duration::from_secs(30);
const MAX_TERMINAL_OUTCOMES: usize = 64;
const TERMINAL_OUTCOME_TTL: Duration = Duration::from_secs(120);
const STORE_FILE_NAME: &str = "recent-files-v1.json";
const LOCK_FILE_NAME: &str = "recent-files-v1.lock";
const STAGING_ATTEMPTS: usize = 8;
const COMMIT_FAILURE_MESSAGE: &str = "The file could not be finalized. Please try again.";
// Windows reports fs2 contention as ERROR_LOCK_VIOLATION instead of WouldBlock.
const WINDOWS_ERROR_LOCK_VIOLATION: i32 = 33;

pub(crate) fn is_retryable_lock_contention(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && error.raw_os_error() == Some(WINDOWS_ERROR_LOCK_VIOLATION))
}

pub(crate) trait MonotonicClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(crate) struct SystemMonotonicClock {
    started_at: Instant,
}

impl Default for SystemMonotonicClock {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl MonotonicClock for SystemMonotonicClock {
    fn now(&self) -> Duration {
        self.started_at.elapsed()
    }
}

pub(crate) trait OpaqueIdSource: Send + Sync {
    fn next_id(&self) -> Result<String, String>;
}

pub(crate) struct SystemOpaqueIdSource;

impl OpaqueIdSource for SystemOpaqueIdSource {
    fn next_id(&self) -> Result<String, String> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("Cannot generate a recent file identifier: {error}"))?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

pub(crate) trait RecentStoreAtomicReplacer: Send + Sync {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()>;
}

pub(crate) struct SystemRecentStoreAtomicReplacer;

impl RecentStoreAtomicReplacer for SystemRecentStoreAtomicReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        replace_file_atomically(staged, active)
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PersistFault {
    Serialize,
    CreateStagedFile,
    WriteStagedFile,
    SyncStagedFile,
    ReparseStagedFile,
}

#[cfg(not(windows))]
fn replace_file_atomically(staged: &Path, active: &Path) -> io::Result<()> {
    fs::rename(staged, active)
}

#[cfg(windows)]
fn replace_file_atomically(staged: &Path, active: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staged = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let active = active
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            staged.as_ptr(),
            active.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) struct RecentStore {
    root: PathBuf,
    store_path: PathBuf,
    lock_path: PathBuf,
    replacer: Arc<dyn RecentStoreAtomicReplacer>,
    id_source: Arc<dyn OpaqueIdSource>,
    retry_interval: Duration,
    lock_timeout: Duration,
    #[cfg(test)]
    fail_unlock: bool,
    #[cfg(test)]
    persist_fault: Option<PersistFault>,
}

impl RecentStore {
    #[cfg(test)]
    pub(crate) fn new(root: PathBuf) -> Self {
        Self::with_ports(
            root,
            Arc::new(SystemRecentStoreAtomicReplacer),
            Arc::new(SystemOpaqueIdSource),
            Duration::from_millis(25),
            Duration::from_secs(2),
        )
    }

    fn with_ports(
        root: PathBuf,
        replacer: Arc<dyn RecentStoreAtomicReplacer>,
        id_source: Arc<dyn OpaqueIdSource>,
        retry_interval: Duration,
        lock_timeout: Duration,
    ) -> Self {
        let store_path = root.join(STORE_FILE_NAME);
        let lock_path = root.join(LOCK_FILE_NAME);
        Self {
            root,
            store_path,
            lock_path,
            replacer,
            id_source,
            retry_interval,
            lock_timeout,
            #[cfg(test)]
            fail_unlock: false,
            #[cfg(test)]
            persist_fault: None,
        }
    }

    fn store_path(&self) -> &Path {
        &self.store_path
    }

    fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    fn unlock(&self, lock: &File) -> io::Result<()> {
        #[cfg(test)]
        if self.fail_unlock {
            return Err(io::Error::other("injected unlock failure"));
        }
        FileExt::unlock(lock)
    }

    #[cfg(test)]
    fn inject_persist_fault(&self, fault: PersistFault) -> Result<(), String> {
        if self.persist_fault == Some(fault) {
            Err(format!("injected persistence fault at {fault:?}"))
        } else {
            Ok(())
        }
    }

    fn ensure_storage(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("Cannot create recent files storage: {error}"))?;
        set_private_directory_permissions(&self.root)
            .map_err(|error| format!("Cannot secure recent files storage: {error}"))?;

        let lock = open_private_file(self.lock_path(), true)
            .map_err(|error| format!("Cannot open recent files lock: {error}"))?;
        drop(lock);
        if self.store_path().exists() {
            set_private_file_permissions(self.store_path())
                .map_err(|error| format!("Cannot secure recent files store: {error}"))?;
        }
        Ok(())
    }

    fn list(&self) -> Result<RecentFilesSnapshot, String> {
        self.with_exclusive_lock(|| {
            let store = self.load_repaired_locked()?;
            store.snapshot()
        })
    }

    fn remove(&self, entry_id: &str) -> Result<RecentFilesSnapshot, String> {
        if !is_valid_opaque_id(entry_id) {
            return Err("Recent file identifier is invalid".to_string());
        }
        self.with_exclusive_lock(|| {
            let mut store = self.load_repaired_locked()?;
            let original_len = store.entries.len();
            store.entries.retain(|entry| entry.id != entry_id);
            if store.entries.len() != original_len {
                self.persist_locked(&store)?;
            }
            store.snapshot()
        })
    }

    fn clear(&self) -> Result<RecentFilesSnapshot, String> {
        self.with_exclusive_lock(|| {
            let store = self.load_repaired_locked()?;
            if !store.entries.is_empty() || !self.store_path().exists() {
                self.persist_locked(&RecentFileStoreV1::empty())?;
            }
            Ok(RecentFilesSnapshot {
                entries: Vec::new(),
            })
        })
    }

    #[cfg(test)]
    fn persist(&self, store: &RecentFileStoreV1) -> Result<(), String> {
        self.with_exclusive_lock(|| self.persist_locked(store))
    }

    fn with_current_store<T>(
        &self,
        operation: impl FnOnce(RecentFileStoreV1) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_exclusive_lock(|| operation(self.load_repaired_locked()?))
    }

    fn with_exclusive_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_storage()?;
        let lock = open_private_file(self.lock_path(), true)
            .map_err(|error| format!("Cannot open recent files lock: {error}"))?;
        let started = Instant::now();
        loop {
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if is_retryable_lock_contention(&error) => {
                    let elapsed = started.elapsed();
                    if elapsed >= self.lock_timeout {
                        return Err("Recent files store is busy".to_string());
                    }
                    thread::sleep(self.retry_interval.min(self.lock_timeout - elapsed));
                }
                Err(error) => return Err(format!("Cannot lock recent files store: {error}")),
            }
        }
        #[cfg(test)]
        crate::path_auth::lock_order_test_probe::recent_fs2_acquired();

        let result = operation();
        if let Err(error) = self.unlock(&lock) {
            let _ = writeln!(
                io::stderr().lock(),
                "Cannot explicitly unlock recent files store; relying on file drop: {error}"
            );
        }
        drop(lock);
        #[cfg(test)]
        crate::path_auth::lock_order_test_probe::recent_fs2_released();
        result
    }

    fn persist_locked(&self, store: &RecentFileStoreV1) -> Result<(), String> {
        #[cfg(test)]
        self.inject_persist_fault(PersistFault::Serialize)?;
        let bytes = serialize_complete_store(store)?;
        #[cfg(test)]
        self.inject_persist_fault(PersistFault::CreateStagedFile)?;
        let (staged_path, mut staged_file) = self.create_staged_file()?;
        let result = (|| {
            #[cfg(test)]
            if let Err(error) = self.inject_persist_fault(PersistFault::WriteStagedFile) {
                drop(staged_file);
                return Err(error);
            }
            staged_file
                .write_all(&bytes)
                .map_err(|error| format!("Cannot stage recent files: {error}"))?;
            #[cfg(test)]
            if let Err(error) = self.inject_persist_fault(PersistFault::SyncStagedFile) {
                drop(staged_file);
                return Err(error);
            }
            staged_file
                .sync_all()
                .map_err(|error| format!("Cannot stage recent files: {error}"))?;
            drop(staged_file);

            let staged_bytes = read_bounded(&staged_path, MAX_STORE_BYTES)
                .map_err(|error| format!("Cannot verify staged recent files: {error}"))?;
            #[cfg(test)]
            self.inject_persist_fault(PersistFault::ReparseStagedFile)?;
            let reparsed: RecentFileStoreV1 = serde_json::from_slice(&staged_bytes)
                .map_err(|error| format!("Cannot verify staged recent files: {error}"))?;
            if reparsed != *store || reparsed.version != STORE_VERSION {
                return Err("Staged recent files image failed strict verification".to_string());
            }

            self.replacer
                .replace_complete_image(&staged_path, self.store_path())
                .map_err(|error| format!("Cannot replace recent files store: {error}"))?;
            let _ = set_private_file_permissions(self.store_path());
            let _ = sync_parent_directory(&self.root);
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&staged_path);
        }
        result
    }

    fn load_repaired_locked(&self) -> Result<RecentFileStoreV1, String> {
        let bytes = match read_bounded(self.store_path(), MAX_STORE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(RecentFileStoreV1::empty());
            }
            Err(error) => return Err(format!("Cannot read recent files: {error}")),
        };
        let (store, repaired) = repair_store_bytes(&bytes, canonicalize_supported_file);
        if repaired {
            self.persist_locked(&store)?;
        }
        Ok(store)
    }

    fn create_staged_file(&self) -> Result<(PathBuf, File), String> {
        for _ in 0..STAGING_ATTEMPTS {
            let id = self.id_source.next_id()?;
            if !is_valid_opaque_id(&id) {
                return Err("Staging identifier is invalid".to_string());
            }
            let path = self.root.join(format!("{STORE_FILE_NAME}.tmp-{id}"));
            match open_private_file(&path, false) {
                Ok(file) => return Ok((path, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Cannot create staged recent files: {error}")),
            }
        }
        Err("Cannot allocate a unique recent files staging path".to_string())
    }
}

fn canonicalize_supported_file(target: &str) -> Option<String> {
    let canonical = fs::canonicalize(target).ok()?;
    if !canonical.is_file() || WorkspaceFileKind::classify(&canonical).is_none() {
        return None;
    }
    canonical.to_str().map(str::to_string)
}

fn read_bounded(path: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn serialize_complete_store(store: &RecentFileStoreV1) -> Result<Vec<u8>, String> {
    if store.version != STORE_VERSION
        || store.entries.len() > MAX_RECENT_FILES
        || store.entries.iter().any(|entry| {
            !is_valid_opaque_id(&entry.id) || !valid_canonical_target(&entry.canonical_target)
        })
        || store.entries.iter().enumerate().any(|(index, entry)| {
            store.entries[..index].iter().any(|prior| {
                prior.id == entry.id || prior.canonical_target == entry.canonical_target
            })
        })
    {
        return Err("Recent files store is invalid".to_string());
    }
    let bytes = serde_json::to_vec(store)
        .map_err(|error| format!("Cannot serialize recent files: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Recent files store exceeds its size limit".to_string());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_private_file(path: &Path, allow_existing: bool) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.read(true).write(true).mode(0o600);
    if allow_existing {
        options.create(true);
    } else {
        options.create_new(true);
    }
    let file = options.open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

#[cfg(not(unix))]
fn open_private_file(path: &Path, allow_existing: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if allow_existing {
        options.create(true);
    } else {
        options.create_new(true);
    }
    options.open(path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentFileStoreV1 {
    version: u8,
    entries: Vec<RecentFileEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentFileEntryV1 {
    id: String,
    #[serde(rename = "canonicalTarget")]
    canonical_target: String,
}

#[derive(Clone)]
struct PendingOpenReceipt {
    canonical_target: String,
    workspace_authorization: Option<WorkspaceReadAuthorization>,
    commit_operation_id: String,
    owner_window: String,
    issued_at: Duration,
    insertion_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TerminalOpenOutcome {
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RuntimeOpenStatus {
    Pending,
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TerminalOutcomeRecord {
    owner_window: String,
    outcome: TerminalOpenOutcome,
    finished_at: Duration,
    insertion_sequence: u64,
}

struct PreparedTerminalOutcome {
    commit_operation_id: String,
    owner_window: String,
    finished_at: Duration,
    insertion_sequence: u64,
}

#[derive(Default)]
struct RecentRuntime {
    pending_receipts: HashMap<String, PendingOpenReceipt>,
    terminal_outcomes: HashMap<String, TerminalOutcomeRecord>,
    next_sequence: u64,
}

#[cfg(test)]
struct RecentRuntimeGuard<'a> {
    inner: Option<std::sync::MutexGuard<'a, RecentRuntime>>,
}

#[cfg(not(test))]
type RecentRuntimeGuard<'a> = std::sync::MutexGuard<'a, RecentRuntime>;

#[cfg(test)]
impl<'a> RecentRuntimeGuard<'a> {
    fn new(inner: std::sync::MutexGuard<'a, RecentRuntime>) -> Self {
        crate::path_auth::lock_order_test_probe::recent_runtime_acquired();
        Self { inner: Some(inner) }
    }
}

#[cfg(test)]
impl Deref for RecentRuntimeGuard<'_> {
    type Target = RecentRuntime;

    fn deref(&self) -> &Self::Target {
        self.inner
            .as_deref()
            .expect("recent runtime guard is active")
    }
}

#[cfg(test)]
impl DerefMut for RecentRuntimeGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_deref_mut()
            .expect("recent runtime guard is active")
    }
}

#[cfg(test)]
impl Drop for RecentRuntimeGuard<'_> {
    fn drop(&mut self) {
        self.inner.take();
        crate::path_auth::lock_order_test_probe::recent_runtime_released();
    }
}

impl RecentRuntime {
    fn issue(
        &mut self,
        owner_window: &str,
        canonical_target: String,
        workspace_authorization: Option<WorkspaceReadAuthorization>,
        now: Duration,
        open_receipt: String,
        commit_operation_id: String,
    ) -> Result<(), String> {
        self.prune(now);
        if owner_window.is_empty()
            || !valid_canonical_target(&canonical_target)
            || !is_valid_opaque_id(&open_receipt)
            || !is_valid_opaque_id(&commit_operation_id)
            || open_receipt == commit_operation_id
            || self.pending_receipts.contains_key(&open_receipt)
            || self.operation_id_in_use(&commit_operation_id)
        {
            return Err("Open receipt identifiers are invalid or duplicated".to_string());
        }

        if self.pending_receipts.len() >= MAX_PENDING_RECEIPTS {
            if let Some(oldest) = self
                .pending_receipts
                .iter()
                .min_by_key(|(_, pending)| (pending.issued_at, pending.insertion_sequence))
                .map(|(receipt, _)| receipt.clone())
            {
                self.pending_receipts.remove(&oldest);
            }
        }
        self.pending_receipts
            .try_reserve(1)
            .map_err(|_| "Cannot reserve an open receipt".to_string())?;
        let insertion_sequence = self.allocate_sequence()?;
        self.pending_receipts.insert(
            open_receipt,
            PendingOpenReceipt {
                canonical_target,
                workspace_authorization,
                commit_operation_id,
                owner_window: owner_window.to_string(),
                issued_at: now,
                insertion_sequence,
            },
        );
        Ok(())
    }

    fn take_receipt(
        &mut self,
        open_receipt: &str,
        owner_window: &str,
        now: Duration,
    ) -> Option<PendingOpenReceipt> {
        self.prune(now);
        if self
            .pending_receipts
            .get(open_receipt)
            .is_none_or(|pending| pending.owner_window != owner_window)
        {
            return None;
        }
        self.pending_receipts.remove(open_receipt)
    }

    fn discard_receipt(&mut self, open_receipt: &str, owner_window: &str, now: Duration) -> bool {
        self.take_receipt(open_receipt, owner_window, now).is_some()
    }

    #[cfg(test)]
    fn retain_outcome(
        &mut self,
        owner_window: &str,
        commit_operation_id: String,
        outcome: TerminalOpenOutcome,
        now: Duration,
    ) -> Result<(), String> {
        self.prune(now);
        if owner_window.is_empty()
            || !is_valid_opaque_id(&commit_operation_id)
            || self.operation_id_in_use(&commit_operation_id)
        {
            return Err("Commit operation identifier is invalid or duplicated".to_string());
        }
        if self.terminal_outcomes.len() >= MAX_TERMINAL_OUTCOMES {
            if let Some(oldest) = self
                .terminal_outcomes
                .iter()
                .min_by_key(|(_, record)| (record.finished_at, record.insertion_sequence))
                .map(|(operation_id, _)| operation_id.clone())
            {
                self.terminal_outcomes.remove(&oldest);
            }
        }
        self.terminal_outcomes
            .try_reserve(1)
            .map_err(|_| "Cannot reserve a commit outcome".to_string())?;
        let insertion_sequence = self.allocate_sequence()?;
        self.terminal_outcomes.insert(
            commit_operation_id,
            TerminalOutcomeRecord {
                owner_window: owner_window.to_string(),
                outcome,
                finished_at: now,
                insertion_sequence,
            },
        );
        Ok(())
    }

    fn prepare_terminal_outcome(
        &mut self,
        owner_window: &str,
        commit_operation_id: String,
        now: Duration,
    ) -> Result<PreparedTerminalOutcome, String> {
        self.prune(now);
        if owner_window.is_empty()
            || !is_valid_opaque_id(&commit_operation_id)
            || self.operation_id_in_use(&commit_operation_id)
        {
            return Err("Commit operation identifier is invalid or duplicated".to_string());
        }
        if self.terminal_outcomes.len() >= MAX_TERMINAL_OUTCOMES {
            if let Some(oldest) = self
                .terminal_outcomes
                .iter()
                .min_by_key(|(_, record)| (record.finished_at, record.insertion_sequence))
                .map(|(operation_id, _)| operation_id.clone())
            {
                self.terminal_outcomes.remove(&oldest);
            }
        }
        self.terminal_outcomes
            .try_reserve(1)
            .map_err(|_| "Cannot reserve a commit outcome".to_string())?;
        let insertion_sequence = self.allocate_sequence()?;
        Ok(PreparedTerminalOutcome {
            commit_operation_id,
            owner_window: owner_window.to_string(),
            finished_at: now,
            insertion_sequence,
        })
    }

    fn apply_terminal_outcome(
        &mut self,
        prepared: PreparedTerminalOutcome,
        outcome: TerminalOpenOutcome,
    ) {
        let replaced = self.terminal_outcomes.insert(
            prepared.commit_operation_id,
            TerminalOutcomeRecord {
                owner_window: prepared.owner_window,
                outcome,
                finished_at: prepared.finished_at,
                insertion_sequence: prepared.insertion_sequence,
            },
        );
        debug_assert!(replaced.is_none());
    }

    fn status(
        &mut self,
        owner_window: &str,
        commit_operation_id: &str,
        now: Duration,
    ) -> RuntimeOpenStatus {
        self.prune(now);
        if self.pending_receipts.values().any(|pending| {
            pending.owner_window == owner_window
                && pending.commit_operation_id == commit_operation_id
        }) {
            return RuntimeOpenStatus::Pending;
        }
        let Some(record) = self.terminal_outcomes.get(commit_operation_id) else {
            return RuntimeOpenStatus::Unknown;
        };
        if record.owner_window != owner_window {
            return RuntimeOpenStatus::Unknown;
        }
        match &record.outcome {
            TerminalOpenOutcome::Committed { recent_files } => RuntimeOpenStatus::Committed {
                recent_files: recent_files.clone(),
            },
            TerminalOpenOutcome::NotCommitted { message } => RuntimeOpenStatus::NotCommitted {
                message: message.clone(),
            },
        }
    }

    fn remove_owner(&mut self, owner_window: &str, now: Duration) {
        self.prune(now);
        self.pending_receipts
            .retain(|_, pending| pending.owner_window != owner_window);
        self.terminal_outcomes
            .retain(|_, record| record.owner_window != owner_window);
    }

    fn shutdown(&mut self, now: Duration) {
        self.prune(now);
        self.pending_receipts.clear();
        self.terminal_outcomes.clear();
    }

    fn prune(&mut self, now: Duration) {
        self.pending_receipts
            .retain(|_, pending| elapsed_since(now, pending.issued_at) < PENDING_RECEIPT_TTL);
        self.terminal_outcomes
            .retain(|_, record| elapsed_since(now, record.finished_at) < TERMINAL_OUTCOME_TTL);
    }

    fn operation_id_in_use(&self, commit_operation_id: &str) -> bool {
        self.terminal_outcomes.contains_key(commit_operation_id)
            || self
                .pending_receipts
                .values()
                .any(|pending| pending.commit_operation_id == commit_operation_id)
    }

    fn allocate_sequence(&mut self) -> Result<u64, String> {
        let sequence = self.next_sequence;
        self.next_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| "Recent file insertion sequence is exhausted".to_string())?;
        Ok(sequence)
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending_receipts.len()
    }

    #[cfg(test)]
    fn outcome_len(&self) -> usize {
        self.terminal_outcomes.len()
    }
}

pub(crate) struct OpenReceiptIdentifiers {
    pub(crate) open_receipt: String,
    pub(crate) commit_operation_id: String,
}

pub(crate) struct RecentFilesState {
    runtime: Mutex<RecentRuntime>,
    store: RecentStore,
    id_source: Arc<dyn OpaqueIdSource>,
    clock: Arc<dyn MonotonicClock>,
}

impl RecentFilesState {
    pub(crate) fn new(root: PathBuf) -> Self {
        let id_source: Arc<dyn OpaqueIdSource> = Arc::new(SystemOpaqueIdSource);
        Self {
            runtime: Mutex::new(RecentRuntime::default()),
            store: RecentStore::with_ports(
                root,
                Arc::new(SystemRecentStoreAtomicReplacer),
                Arc::clone(&id_source),
                Duration::from_millis(25),
                Duration::from_secs(2),
            ),
            id_source,
            clock: Arc::new(SystemMonotonicClock::default()),
        }
    }

    #[cfg(test)]
    fn with_ports(
        store: RecentStore,
        id_source: Arc<dyn OpaqueIdSource>,
        clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self {
            runtime: Mutex::new(RecentRuntime::default()),
            store,
            id_source,
            clock,
        }
    }

    pub(crate) fn list(&self) -> Result<RecentFilesSnapshot, String> {
        let _runtime = self.lock_runtime()?;
        self.store.list()
    }

    #[cfg(feature = "packaged-lifecycle-e2e")]
    pub(crate) fn pending_receipt_count_for_evidence(&self) -> Result<usize, String> {
        let runtime = self.lock_runtime()?;
        Ok(runtime.pending_receipts.len())
    }

    pub(crate) fn issue_open(
        &self,
        owner_window: &str,
        canonical_target: impl AsRef<Path>,
    ) -> Result<OpenReceiptIdentifiers, String> {
        let canonical_target = canonicalize_supported_file(
            canonical_target
                .as_ref()
                .to_str()
                .ok_or_else(|| "Open target path is not valid UTF-8".to_string())?,
        )
        .ok_or_else(|| "Open target is not a supported file".to_string())?;
        let identifiers = self.next_receipt_identifiers()?;
        let mut runtime = self.lock_runtime()?;
        runtime.issue(
            owner_window,
            canonical_target,
            None,
            self.clock.now(),
            identifiers.open_receipt.clone(),
            identifiers.commit_operation_id.clone(),
        )?;
        Ok(identifiers)
    }

    pub(crate) fn issue_workspace_open(
        &self,
        owner_window: &str,
        authorization: &WorkspaceReadAuthorization,
    ) -> Result<OpenReceiptIdentifiers, String> {
        let canonical_target = authorization
            .path()
            .to_str()
            .filter(|target| valid_canonical_target(target))
            .filter(|_| WorkspaceFileKind::classify(authorization.path()).is_some())
            .ok_or_else(|| "Open target is not a supported file".to_string())?
            .to_string();
        let identifiers = self.next_receipt_identifiers()?;
        let mut runtime = self.lock_runtime()?;
        runtime.issue(
            owner_window,
            canonical_target,
            Some(authorization.clone()),
            self.clock.now(),
            identifiers.open_receipt.clone(),
            identifiers.commit_operation_id.clone(),
        )?;
        Ok(identifiers)
    }

    pub(crate) fn prepare_recent_open<S>(
        &self,
        owner_window: &str,
        entry_id: &str,
        response: impl FnOnce(&Path) -> Result<S, String>,
    ) -> Result<(S, OpenReceiptIdentifiers), String> {
        if !is_valid_opaque_id(entry_id) {
            return Err("Recent file identifier is invalid".to_string());
        }
        let mut runtime = self.lock_runtime()?;
        self.store.with_current_store(|store| {
            let entry = store
                .entries
                .iter()
                .find(|entry| entry.id == entry_id)
                .ok_or_else(|| "Recent file is no longer available".to_string())?;
            let canonical_target = canonicalize_supported_file(&entry.canonical_target)
                .filter(|target| target == &entry.canonical_target)
                .ok_or_else(|| "Recent file is no longer available".to_string())?;
            let response = response(Path::new(&canonical_target))?;
            let identifiers = self.next_receipt_identifiers()?;
            runtime.issue(
                owner_window,
                canonical_target,
                None,
                self.clock.now(),
                identifiers.open_receipt.clone(),
                identifiers.commit_operation_id.clone(),
            )?;
            Ok((response, identifiers))
        })
    }

    #[cfg(test)]
    pub(crate) fn commit_open(
        &self,
        open_receipt: &str,
        owner_window: &str,
        authorization: &FileAuthorizationSession,
    ) -> Result<OpenCommitResult, String> {
        self.commit_open_with_post_commit(open_receipt, owner_window, authorization, |_| {})
    }

    pub(crate) fn commit_open_with_post_commit(
        &self,
        open_receipt: &str,
        owner_window: &str,
        authorization: &FileAuthorizationSession,
        post_commit: impl FnOnce(&Path),
    ) -> Result<OpenCommitResult, String> {
        let now = self.clock.now();
        let mut runtime = self.lock_runtime()?;
        let pending = runtime
            .take_receipt(open_receipt, owner_window, now)
            .ok_or_else(|| "Open receipt is invalid, expired, or already consumed".to_string())?;
        let prepared_outcome =
            runtime.prepare_terminal_outcome(owner_window, pending.commit_operation_id, now)?;
        let mut prepared_outcome = Some(prepared_outcome);
        let mut indeterminate_error = None;
        let failure_outcome = TerminalOpenOutcome::NotCommitted {
            message: COMMIT_FAILURE_MESSAGE.to_string(),
        };

        let committed = self.store.with_current_store(|store| {
            let canonical_target = if let Some(authorization) = &pending.workspace_authorization {
                authorization
                    .path()
                    .to_str()
                    .filter(|target| *target == pending.canonical_target)
                    .ok_or_else(|| "Workspace open receipt target changed".to_string())?
                    .to_string()
            } else {
                canonicalize_supported_file(&pending.canonical_target)
                    .filter(|target| target == &pending.canonical_target)
                    .ok_or_else(|| "Open target is no longer a supported file".to_string())?
            };
            let original = store;
            let mut promoted = original.clone();
            promoted.promote(canonical_target.clone(), &mut || self.id_source.next_id())?;
            let snapshot = promoted.snapshot()?;
            let retained_snapshot = snapshot.clone();
            let post_commit_target = canonical_target.clone();
            authorization.with_prepared_open_document_grant_for_receipt(
                PathBuf::from(&canonical_target),
                pending.workspace_authorization.as_ref(),
                |grant| {
                    self.store.persist_locked(&promoted)?;
                    if let Err(error) = grant.apply() {
                        if let Err(rollback_error) = self.store.persist_locked(&original) {
                            indeterminate_error = Some(format!(
                                "Recent file commit became indeterminate after authorization failed ({error}) and rollback failed: {rollback_error}"
                            ));
                        }
                        return Err(error);
                    }
                    runtime.apply_terminal_outcome(
                        prepared_outcome
                            .take()
                            .expect("terminal outcome is applied exactly once"),
                        TerminalOpenOutcome::Committed {
                            recent_files: retained_snapshot,
                        },
                    );
                    Ok((snapshot, post_commit_target))
                },
            )
        });

        match committed {
            Ok((recent_files, canonical_target)) => {
                drop(runtime);
                post_commit(Path::new(&canonical_target));
                Ok(OpenCommitResult::Committed { recent_files })
            }
            Err(_) if indeterminate_error.is_some() => {
                Err(indeterminate_error
                    .expect("indeterminate commit failure retains its diagnostic"))
            }
            Err(_) => {
                runtime.apply_terminal_outcome(
                    prepared_outcome
                        .take()
                        .expect("failed commit retains its terminal outcome"),
                    failure_outcome,
                );
                Ok(OpenCommitResult::NotCommitted {
                    message: COMMIT_FAILURE_MESSAGE.to_string(),
                })
            }
        }
    }

    pub(crate) fn status(
        &self,
        owner_window: &str,
        commit_operation_id: &str,
    ) -> Result<OpenCommitStatus, String> {
        if !is_valid_opaque_id(commit_operation_id) {
            return Err("Commit operation identifier is invalid".to_string());
        }
        let mut runtime = self.lock_runtime()?;
        Ok(
            match runtime.status(owner_window, commit_operation_id, self.clock.now()) {
                RuntimeOpenStatus::Pending => OpenCommitStatus::Pending,
                RuntimeOpenStatus::Committed { recent_files } => {
                    OpenCommitStatus::Committed { recent_files }
                }
                RuntimeOpenStatus::NotCommitted { message } => {
                    OpenCommitStatus::NotCommitted { message }
                }
                RuntimeOpenStatus::Unknown => OpenCommitStatus::Unknown,
            },
        )
    }

    pub(crate) fn discard(&self, owner_window: &str, open_receipt: &str) -> Result<bool, String> {
        if !is_valid_opaque_id(open_receipt) {
            return Err("Open receipt is invalid".to_string());
        }
        let mut runtime = self.lock_runtime()?;
        Ok(runtime.discard_receipt(open_receipt, owner_window, self.clock.now()))
    }

    pub(crate) fn remove(&self, entry_id: &str) -> Result<RecentFilesSnapshot, String> {
        let _runtime = self.lock_runtime()?;
        self.store.remove(entry_id)
    }

    pub(crate) fn clear(&self) -> Result<RecentFilesSnapshot, String> {
        let _runtime = self.lock_runtime()?;
        self.store.clear()
    }

    pub(crate) fn remove_owner(&self, owner_window: &str) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        runtime.remove_owner(owner_window, self.clock.now());
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        runtime.shutdown(self.clock.now());
        Ok(())
    }

    fn lock_runtime(&self) -> Result<RecentRuntimeGuard<'_>, String> {
        let inner = self
            .runtime
            .lock()
            .map_err(|_| "Recent files state is poisoned".to_string())?;
        #[cfg(test)]
        {
            Ok(RecentRuntimeGuard::new(inner))
        }
        #[cfg(not(test))]
        {
            Ok(inner)
        }
    }

    fn next_receipt_identifiers(&self) -> Result<OpenReceiptIdentifiers, String> {
        let open_receipt = self.id_source.next_id()?;
        let commit_operation_id = self.id_source.next_id()?;
        if !is_valid_opaque_id(&open_receipt)
            || !is_valid_opaque_id(&commit_operation_id)
            || open_receipt == commit_operation_id
        {
            return Err("Generated open receipt identifiers are invalid".to_string());
        }
        Ok(OpenReceiptIdentifiers {
            open_receipt,
            commit_operation_id,
        })
    }
}

fn elapsed_since(now: Duration, started_at: Duration) -> Duration {
    now.checked_sub(started_at).unwrap_or_default()
}

impl RecentFileEntryV1 {
    #[cfg(test)]
    fn new(id: impl Into<String>, canonical_target: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            canonical_target: canonical_target.into(),
        }
    }
}

impl RecentFileStoreV1 {
    pub(crate) fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            entries: Vec::new(),
        }
    }

    fn promote(
        &mut self,
        canonical_target: String,
        next_id: &mut impl FnMut() -> Result<String, String>,
    ) -> Result<(), String> {
        if !valid_canonical_target(&canonical_target) {
            return Err("Recent file target is invalid".to_string());
        }

        let entry = if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.canonical_target == canonical_target)
        {
            self.entries.remove(index)
        } else {
            let id = next_id()?;
            if !is_valid_opaque_id(&id) || self.entries.iter().any(|entry| entry.id == id) {
                return Err("Recent file identifier is invalid or duplicated".to_string());
            }
            RecentFileEntryV1 {
                id,
                canonical_target,
            }
        };

        self.entries.insert(0, entry);
        self.entries.truncate(MAX_RECENT_FILES);
        if serde_json::to_vec(self)
            .map_err(|error| format!("Cannot serialize recent files: {error}"))?
            .len()
            > MAX_STORE_BYTES
        {
            return Err("Recent files store exceeds its size limit".to_string());
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<RecentFilesSnapshot, String> {
        let entries = self
            .entries
            .iter()
            .map(|entry| {
                let display_name = Path::new(&entry.canonical_target)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "Recent file has no displayable name".to_string())?;
                Ok(RecentFileSummary {
                    id: entry.id.clone(),
                    display_name: display_name.to_string(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(RecentFilesSnapshot { entries })
    }
}

fn is_valid_opaque_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_canonical_target(target: &str) -> bool {
    !target.is_empty() && target.len() <= MAX_PATH_BYTES && Path::new(target).is_absolute()
}

pub(crate) fn repair_store_bytes(
    bytes: &[u8],
    mut canonicalize_supported_file: impl FnMut(&str) -> Option<String>,
) -> (RecentFileStoreV1, bool) {
    if bytes.len() > MAX_STORE_BYTES {
        return (RecentFileStoreV1::empty(), true);
    }

    let parsed = match serde_json::from_slice::<RecentFileStoreV1>(bytes) {
        Ok(store) if store.version == STORE_VERSION => store,
        _ => return (RecentFileStoreV1::empty(), true),
    };
    let original = parsed.clone();
    let mut repaired = RecentFileStoreV1::empty();
    let mut ids = HashSet::new();
    let mut targets = HashSet::new();

    for entry in parsed.entries {
        if repaired.entries.len() == MAX_RECENT_FILES
            || !is_valid_opaque_id(&entry.id)
            || !valid_canonical_target(&entry.canonical_target)
            || ids.contains(&entry.id)
        {
            continue;
        }
        let Some(canonical_target) = canonicalize_supported_file(&entry.canonical_target) else {
            continue;
        };
        if canonical_target != entry.canonical_target
            || !valid_canonical_target(&canonical_target)
            || targets.contains(&canonical_target)
        {
            continue;
        }

        let repaired_entry = RecentFileEntryV1 {
            id: entry.id.clone(),
            canonical_target: canonical_target.clone(),
        };
        repaired.entries.push(repaired_entry);
        if serde_json::to_vec(&repaired)
            .expect("recent V1 store serialization is infallible")
            .len()
            > MAX_STORE_BYTES
        {
            repaired.entries.pop();
            continue;
        }
        ids.insert(entry.id);
        targets.insert(canonical_target);
    }

    let changed = repaired != original;
    (repaired, changed)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashSet, VecDeque},
        env,
        fs::{self, OpenOptions},
        io,
        panic::{catch_unwind, AssertUnwindSafe},
        path::{Path, PathBuf},
        process::{Child, Command},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc::{self, Receiver, Sender},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    use fs2::FileExt;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        is_retryable_lock_contention, repair_store_bytes, serialize_complete_store, MonotonicClock,
        OpaqueIdSource, PersistFault, RecentFileEntryV1, RecentFileStoreV1, RecentFilesState,
        RecentRuntime, RecentStore, RecentStoreAtomicReplacer, SystemRecentStoreAtomicReplacer,
        TerminalOpenOutcome,
    };
    use crate::{
        models::{OpenCommitResult, OpenCommitStatus, RecentFilesSnapshot},
        path_auth::{
            authorize_directory_root_inner, ensure_authorized_existing_file_inner,
            ensure_authorized_write_file_inner, is_authorized_image_path,
            open_authorized_existing_file_inner, FileAuthorizationSession,
        },
        state::AppState,
    };

    const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ID_C: &str = "cccccccccccccccccccccccccccccccc";
    const ID_D: &str = "dddddddddddddddddddddddddddddddd";
    const ID_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const ID_F: &str = "ffffffffffffffffffffffffffffffff";

    fn absolute_path(relative: impl AsRef<Path>) -> String {
        #[cfg(windows)]
        let root = Path::new(r"C:\");
        #[cfg(not(windows))]
        let root = Path::new("/");

        root.join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn classifies_retryable_lock_contention_errors() {
        assert!(is_retryable_lock_contention(&io::Error::from(
            io::ErrorKind::WouldBlock
        )));

        #[cfg(windows)]
        assert!(is_retryable_lock_contention(&io::Error::from_raw_os_error(
            super::WINDOWS_ERROR_LOCK_VIOLATION
        )));

        assert!(!is_retryable_lock_contention(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
    }

    fn canonical_target(path: &str) -> Option<String> {
        let canonical_a = absolute_path("docs/a.md");
        if path == canonical_a || path == absolute_path("alias/a.md") {
            return Some(canonical_a);
        }
        [
            "docs/b.md",
            "docs/c.html",
            "docs/d.md",
            "docs/e.md",
            "docs/f.md",
        ]
        .into_iter()
        .map(absolute_path)
        .find(|candidate| candidate == path)
    }

    #[test]
    fn repairs_untrusted_v1_entries_in_order_and_serializes_the_exact_schema() {
        let canonical_a = absolute_path("docs/a.md");
        let alias_a = absolute_path("alias/a.md");
        let canonical_b = absolute_path("docs/b.md");
        let canonical_c = absolute_path("docs/c.html");
        let missing = absolute_path("missing.md");
        let canonical_d = absolute_path("docs/d.md");
        let canonical_e = absolute_path("docs/e.md");
        let canonical_f = absolute_path("docs/f.md");
        let bytes = serde_json::to_vec(&json!({
            "version": 1,
            "entries": [
                { "id": ID_A, "canonicalTarget": &canonical_a },
                { "id": ID_B, "canonicalTarget": &alias_a },
                { "id": ID_A, "canonicalTarget": &canonical_b },
                { "id": "not-random", "canonicalTarget": &canonical_c },
                { "id": ID_C, "canonicalTarget": &missing },
                { "id": ID_D, "canonicalTarget": &canonical_d },
                { "id": ID_E, "canonicalTarget": &canonical_e },
                { "id": ID_F, "canonicalTarget": &canonical_f }
            ]
        }))
        .unwrap();

        let (store, repaired) = repair_store_bytes(&bytes, canonical_target);

        assert!(repaired);
        assert_eq!(
            store.entries,
            vec![
                RecentFileEntryV1::new(ID_A, &canonical_a),
                RecentFileEntryV1::new(ID_D, &canonical_d),
                RecentFileEntryV1::new(ID_E, &canonical_e),
                RecentFileEntryV1::new(ID_F, &canonical_f),
            ]
        );
        assert_eq!(
            serde_json::to_value(store).unwrap(),
            json!({
                "version": 1,
                "entries": [
                    { "id": ID_A, "canonicalTarget": &canonical_a },
                    { "id": ID_D, "canonicalTarget": &canonical_d },
                    { "id": ID_E, "canonicalTarget": &canonical_e },
                    { "id": ID_F, "canonicalTarget": &canonical_f }
                ]
            })
        );
    }

    #[test]
    fn invalid_envelopes_and_oversized_documents_repair_to_empty_v1() {
        for bytes in [
            br#"{"version":2,"entries":[]}"#.as_slice(),
            br#"{"version":1,"entries":[],"extra":true}"#.as_slice(),
            br#"{"version":1,"entries":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonicalTarget":"/docs/a.md","extra":true}]}"#.as_slice(),
            b"not json".as_slice(),
            vec![b' '; 64 * 1024 + 1].as_slice(),
        ] {
            let (store, repaired) = repair_store_bytes(bytes, canonical_target);
            assert!(repaired);
            assert_eq!(store, RecentFileStoreV1::empty());
        }
    }

    #[test]
    fn promotion_deduplicates_by_canonical_target_and_evicts_after_five() {
        let mut store = RecentFileStoreV1::empty();
        let mut ids = VecDeque::from([ID_A, ID_B, ID_C, ID_D, ID_E, ID_F]);
        let mut next_id = || Ok(ids.pop_front().unwrap().to_string());

        for target in ["a.md", "b.md", "c.html", "d.md", "e.md", "f.md"] {
            store
                .promote(absolute_path(Path::new("docs").join(target)), &mut next_id)
                .unwrap();
        }

        assert_eq!(
            store
                .entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec![ID_F, ID_E, ID_D, ID_C, ID_B]
        );

        store
            .promote(
                absolute_path(Path::new("docs").join("c.html")),
                &mut next_id,
            )
            .unwrap();
        assert_eq!(
            store
                .entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec![ID_C, ID_F, ID_E, ID_D, ID_B]
        );
    }

    #[test]
    fn complete_store_serialization_rejects_duplicate_ids_and_targets() {
        let duplicate_id = RecentFileStoreV1 {
            version: 1,
            entries: vec![
                RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md")),
                RecentFileEntryV1::new(ID_A, absolute_path("docs/b.md")),
            ],
        };
        let duplicate_target = RecentFileStoreV1 {
            version: 1,
            entries: vec![
                RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md")),
                RecentFileEntryV1::new(ID_B, absolute_path("docs/a.md")),
            ],
        };

        assert!(serialize_complete_store(&duplicate_id).is_err());
        assert!(serialize_complete_store(&duplicate_target).is_err());
    }

    fn opaque_id(value: usize) -> String {
        format!("{value:032x}")
    }

    #[test]
    fn pending_receipts_expire_at_thirty_seconds_and_evict_the_oldest_at_thirty_two() {
        let mut runtime = RecentRuntime::default();
        let issued_at = Duration::from_secs(4);

        for index in 0..33 {
            runtime
                .issue(
                    "main",
                    absolute_path(format!("docs/{index}.md")),
                    None,
                    issued_at,
                    opaque_id(index * 2 + 1),
                    opaque_id(index * 2 + 2),
                )
                .unwrap();
        }

        assert_eq!(runtime.pending_len(), 32);
        assert!(runtime
            .take_receipt(&opaque_id(1), "main", issued_at)
            .is_none());
        let newest = runtime
            .take_receipt(&opaque_id(65), "main", issued_at)
            .expect("newest receipt remains live");
        assert_eq!(newest.commit_operation_id, opaque_id(66));

        runtime.prune(Duration::from_secs(34));
        assert_eq!(runtime.pending_len(), 0);
    }

    #[test]
    fn receipt_discard_owner_close_shutdown_and_replay_never_cross_owner_boundaries() {
        let mut runtime = RecentRuntime::default();
        let now = Duration::from_secs(1);
        runtime
            .issue(
                "main",
                absolute_path("docs/a.md"),
                None,
                now,
                opaque_id(1),
                opaque_id(2),
            )
            .unwrap();
        runtime
            .issue(
                "editor",
                absolute_path("docs/b.md"),
                None,
                now,
                opaque_id(3),
                opaque_id(4),
            )
            .unwrap();
        runtime
            .issue(
                "main",
                absolute_path("docs/c.md"),
                None,
                now,
                opaque_id(5),
                opaque_id(6),
            )
            .unwrap();

        assert!(!runtime.discard_receipt(&opaque_id(1), "editor", now));
        assert!(runtime.discard_receipt(&opaque_id(1), "main", now));
        assert!(!runtime.discard_receipt(&opaque_id(1), "main", now));

        runtime.remove_owner("main", now);
        assert_eq!(runtime.pending_len(), 1);
        assert!(runtime.take_receipt(&opaque_id(3), "editor", now).is_some());
        assert!(runtime.take_receipt(&opaque_id(5), "main", now).is_none());

        runtime
            .issue(
                "editor",
                absolute_path("docs/d.md"),
                None,
                now,
                opaque_id(7),
                opaque_id(8),
            )
            .unwrap();
        runtime.shutdown(now);
        assert_eq!(runtime.pending_len(), 0);
        assert!(runtime.take_receipt(&opaque_id(7), "editor", now).is_none());
    }

    #[test]
    fn terminal_outcomes_are_owner_bound_capped_at_sixty_four_and_expire_at_two_minutes() {
        let mut runtime = RecentRuntime::default();
        let now = Duration::from_secs(10);

        runtime
            .issue(
                "main",
                absolute_path("docs/pending.md"),
                None,
                now,
                opaque_id(1),
                opaque_id(2),
            )
            .unwrap();
        assert_eq!(
            runtime.status("main", &opaque_id(2), now),
            super::RuntimeOpenStatus::Pending
        );
        assert_eq!(
            runtime.status("editor", &opaque_id(2), now),
            super::RuntimeOpenStatus::Unknown
        );

        for index in 0..65 {
            runtime
                .retain_outcome(
                    "main",
                    opaque_id(100 + index),
                    TerminalOpenOutcome::NotCommitted {
                        message: format!("failure-{index}"),
                    },
                    now,
                )
                .unwrap();
        }

        assert_eq!(runtime.outcome_len(), 64);
        assert_eq!(
            runtime.status("main", &opaque_id(100), now),
            super::RuntimeOpenStatus::Unknown
        );
        assert_eq!(
            runtime.status("main", &opaque_id(164), now),
            super::RuntimeOpenStatus::NotCommitted {
                message: "failure-64".to_string(),
            }
        );
        assert_eq!(
            runtime.status("editor", &opaque_id(164), now),
            super::RuntimeOpenStatus::Unknown
        );

        runtime.prune(Duration::from_secs(130));
        assert_eq!(runtime.outcome_len(), 0);
    }

    struct SequenceIdSource {
        ids: Mutex<VecDeque<String>>,
    }

    impl SequenceIdSource {
        fn new(ids: impl IntoIterator<Item = String>) -> Self {
            Self {
                ids: Mutex::new(ids.into_iter().collect()),
            }
        }
    }

    impl OpaqueIdSource for SequenceIdSource {
        fn next_id(&self) -> Result<String, String> {
            self.ids
                .lock()
                .map_err(|_| "test ID source is poisoned".to_string())?
                .pop_front()
                .ok_or_else(|| "test ID source is exhausted".to_string())
        }
    }

    #[derive(Default)]
    struct TestClock {
        now: Mutex<Duration>,
    }

    impl MonotonicClock for TestClock {
        fn now(&self) -> Duration {
            *self.now.lock().unwrap()
        }
    }

    #[derive(Default)]
    struct FailingReplacer;

    impl RecentStoreAtomicReplacer for FailingReplacer {
        fn replace_complete_image(&self, _staged: &Path, _active: &Path) -> io::Result<()> {
            Err(io::Error::other("injected replacement failure"))
        }
    }

    struct PausingReplacer {
        pause_next: AtomicBool,
        entered: Sender<()>,
        release: Mutex<Receiver<()>>,
    }

    impl PausingReplacer {
        fn new() -> (Arc<Self>, Receiver<()>, Sender<()>) {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            (
                Arc::new(Self {
                    pause_next: AtomicBool::new(false),
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                }),
                entered_rx,
                release_tx,
            )
        }

        fn pause_next_replacement(&self) {
            self.pause_next.store(true, Ordering::SeqCst);
        }
    }

    impl RecentStoreAtomicReplacer for PausingReplacer {
        fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
            if self.pause_next.swap(false, Ordering::SeqCst) {
                self.entered
                    .send(())
                    .map_err(|_| io::Error::other("replacement entry receiver dropped"))?;
                self.release
                    .lock()
                    .map_err(|_| io::Error::other("replacement release gate poisoned"))?
                    .recv()
                    .map_err(|_| io::Error::other("replacement release sender dropped"))?;
            }
            SystemRecentStoreAtomicReplacer.replace_complete_image(staged, active)
        }
    }

    struct PausingRollbackFailingReplacer {
        calls: AtomicUsize,
        entered: Sender<()>,
        release: Mutex<Receiver<()>>,
    }

    impl PausingRollbackFailingReplacer {
        fn new() -> (Arc<Self>, Receiver<()>, Sender<()>) {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            (
                Arc::new(Self {
                    calls: AtomicUsize::new(0),
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                }),
                entered_rx,
                release_tx,
            )
        }
    }

    impl RecentStoreAtomicReplacer for PausingRollbackFailingReplacer {
        fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    self.entered
                        .send(())
                        .map_err(|_| io::Error::other("replacement entry receiver dropped"))?;
                    self.release
                        .lock()
                        .map_err(|_| io::Error::other("replacement release gate poisoned"))?
                        .recv()
                        .map_err(|_| io::Error::other("replacement release sender dropped"))?;
                    SystemRecentStoreAtomicReplacer.replace_complete_image(staged, active)
                }
                _ => Err(io::Error::other("injected rollback replacement failure")),
            }
        }
    }

    fn store_with(
        root: PathBuf,
        replacer: Arc<dyn RecentStoreAtomicReplacer>,
        retry_interval: Duration,
        lock_timeout: Duration,
    ) -> RecentStore {
        RecentStore::with_ports(
            root,
            replacer,
            Arc::new(SequenceIdSource::new((1..=32).map(opaque_id))),
            retry_interval,
            lock_timeout,
        )
    }

    fn state_with_ids(
        root: PathBuf,
        replacer: Arc<dyn RecentStoreAtomicReplacer>,
        ids: impl IntoIterator<Item = String>,
    ) -> RecentFilesState {
        let ids: Arc<dyn OpaqueIdSource> = Arc::new(SequenceIdSource::new(ids));
        let store = RecentStore::with_ports(
            root,
            replacer,
            Arc::clone(&ids),
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        RecentFilesState::with_ports(store, ids, Arc::new(TestClock::default()))
    }

    fn state_with(root: PathBuf, replacer: Arc<dyn RecentStoreAtomicReplacer>) -> RecentFilesState {
        state_with_ids(root, replacer, (1..=128).map(opaque_id))
    }

    fn commit_document(
        recent: &RecentFilesState,
        owner_window: &str,
        document: &Path,
        authorization: &FileAuthorizationSession,
    ) -> RecentFilesSnapshot {
        let identifiers = recent.issue_open(owner_window, document).unwrap();
        match recent
            .commit_open(&identifiers.open_receipt, owner_window, authorization)
            .unwrap()
        {
            OpenCommitResult::Committed { recent_files } => recent_files,
            OpenCommitResult::NotCommitted { message } => {
                panic!("test setup commit failed: {message}")
            }
        }
    }

    fn recent_files_child_command(action: &str, root: &Path) -> Command {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("recent_files::tests::recent_files_child_process_harness")
            .arg("--nocapture")
            .env("MMD_RECENT_FILES_CHILD_ACTION", action)
            .env("MMD_RECENT_FILES_CHILD_ROOT", root);
        command
    }

    fn wait_until_created(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "child process did not become ready"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_for_optional_child_start_gate() {
        let Some(start_path) = env::var_os("MMD_RECENT_FILES_CHILD_START") else {
            return;
        };
        let ready_path = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_READY").unwrap());
        fs::write(ready_path, b"ready").unwrap();
        wait_until_created(Path::new(&start_path));
    }

    fn spawn_gated_child(command: &mut Command, ready_path: &Path, start_path: &Path) -> Child {
        command
            .env("MMD_RECENT_FILES_CHILD_READY", ready_path)
            .env("MMD_RECENT_FILES_CHILD_START", start_path)
            .spawn()
            .unwrap()
    }

    fn assert_child_success(child: Child) {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "child failed\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn load_strict_store(store: &RecentStore) -> RecentFileStoreV1 {
        let persisted: RecentFileStoreV1 =
            serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
        assert!(serialize_complete_store(&persisted).is_ok());
        persisted
    }

    #[test]
    fn recent_files_child_process_harness() {
        let Ok(action) = env::var("MMD_RECENT_FILES_CHILD_ACTION") else {
            return;
        };
        let root = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_ROOT").unwrap());

        match action.as_str() {
            "hold-lock" => {
                let store = RecentStore::new(root);
                store.ensure_storage().unwrap();
                let lock = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(store.lock_path())
                    .unwrap();
                lock.lock_exclusive().unwrap();
                fs::write(
                    env::var_os("MMD_RECENT_FILES_CHILD_READY").unwrap(),
                    b"ready",
                )
                .unwrap();
                let hold_millis = env::var("MMD_RECENT_FILES_CHILD_HOLD_MS")
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                thread::sleep(Duration::from_millis(hold_millis));
                lock.unlock().unwrap();
            }
            "commit" => {
                let target = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_TARGET").unwrap());
                let recent = RecentFilesState::new(root);
                let authorization = FileAuthorizationSession::default();
                let identifiers = recent.issue_open("child", target).unwrap();
                wait_for_optional_child_start_gate();
                assert!(matches!(
                    recent
                        .commit_open(&identifiers.open_receipt, "child", &authorization)
                        .unwrap(),
                    OpenCommitResult::Committed { .. }
                ));
            }
            "clear" => {
                let recent = RecentFilesState::new(root);
                wait_for_optional_child_start_gate();
                assert!(recent.clear().unwrap().entries.is_empty());
            }
            "remove" => {
                let entry_id = env::var("MMD_RECENT_FILES_CHILD_ENTRY_ID").unwrap();
                let recent = RecentFilesState::new(root);
                wait_for_optional_child_start_gate();
                recent.remove(&entry_id).unwrap();
            }
            other => panic!("unknown child action: {other}"),
        }
    }

    #[test]
    fn committed_open_promotes_once_retains_status_and_publishes_only_exact_authority() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        let sibling = directory.path().join("sibling.md");
        fs::write(&document, "# document").unwrap();
        fs::write(&sibling, "# sibling").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &canonical_document).unwrap();

        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
        let committed = recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap();

        let snapshot = match committed {
            OpenCommitResult::Committed { recent_files } => recent_files,
            OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
        };
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].display_name, "document.md");
        assert_eq!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::Committed {
                recent_files: snapshot.clone(),
            }
        );
        assert!(recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .is_err());
        assert_eq!(
            authorization
                .exact_write_grant_snapshot_for_test(&canonical_document)
                .unwrap(),
            Some((crate::path_auth::GrantStatus::Active, 1))
        );
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&sibling.canonicalize().unwrap())
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn recent_target_ignores_the_original_alias_after_it_is_retargeted() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        let alias = directory.path().join("alias.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        symlink(&first, &alias).unwrap();
        let canonical_first = first.canonicalize().unwrap();
        let canonical_second = second.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let initial = commit_document(&recent, "main", &alias, &authorization);
        let entry_id = initial.entries[0].id.clone();

        fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();
        let ((prepared_path, prepared_content), identifiers) = recent
            .prepare_recent_open("main", &entry_id, |path| {
                Ok((path.to_path_buf(), fs::read_to_string(path).unwrap()))
            })
            .unwrap();

        assert_eq!(prepared_path, canonical_first);
        assert_eq!(prepared_content, "# first");
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_second)
            .unwrap()
            .is_none());
        let committed = recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap();
        let reopened = match committed {
            OpenCommitResult::Committed { recent_files } => recent_files,
            OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
        };
        assert_eq!(reopened.entries.len(), 1);
        assert_eq!(reopened.entries[0].id, entry_id);
        assert_eq!(
            authorization
                .exact_write_grant_snapshot_for_test(&canonical_first)
                .unwrap(),
            Some((crate::path_auth::GrantStatus::Active, 2))
        );
    }

    #[cfg(unix)]
    #[test]
    fn recent_target_rejects_a_stored_canonical_path_retargeted_to_a_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let recorded = directory.path().join("recorded.md");
        let retargeted = directory.path().join("retargeted.md");
        fs::write(&recorded, "# recorded").unwrap();
        fs::write(&retargeted, "# retargeted").unwrap();
        let canonical_retargeted = retargeted.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let initial = commit_document(&recent, "main", &recorded, &authorization);
        let entry_id = initial.entries[0].id.clone();
        fs::remove_file(&recorded).unwrap();
        symlink(&retargeted, &recorded).unwrap();
        let response_called = AtomicBool::new(false);

        let result = recent.prepare_recent_open("main", &entry_id, |_| {
            response_called.store(true, Ordering::SeqCst);
            Ok(())
        });

        assert!(result.is_err());
        assert!(!response_called.load(Ordering::SeqCst));
        assert!(recent.list().unwrap().entries.is_empty());
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_retargeted)
            .unwrap()
            .is_none());
    }

    #[test]
    fn recent_target_accepts_a_supported_replacement_at_the_same_canonical_path() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# original").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let initial = commit_document(&recent, "main", &document, &authorization);
        let entry_id = initial.entries[0].id.clone();
        fs::remove_file(&document).unwrap();
        fs::write(&document, "# replacement").unwrap();

        let ((prepared_path, prepared_content), identifiers) = recent
            .prepare_recent_open("main", &entry_id, |path| {
                Ok((path.to_path_buf(), fs::read_to_string(path).unwrap()))
            })
            .unwrap();

        assert_eq!(prepared_path, canonical_document);
        assert_eq!(prepared_content, "# replacement");
        let committed = recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap();
        let reopened = match committed {
            OpenCommitResult::Committed { recent_files } => recent_files,
            OpenCommitResult::NotCommitted { message } => panic!("unexpected failure: {message}"),
        };
        assert_eq!(reopened.entries.len(), 1);
        assert_eq!(reopened.entries[0].id, entry_id);
        assert_eq!(
            authorization
                .exact_write_grant_snapshot_for_test(&canonical_document)
                .unwrap(),
            Some((crate::path_auth::GrantStatus::Active, 2))
        );
    }

    #[test]
    fn unlock_failure_after_commit_preserves_committed_result_status_and_exact_grant() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let mut recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        recent.store.fail_unlock = true;
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &canonical_document).unwrap();

        let committed = catch_unwind(AssertUnwindSafe(|| {
            recent.commit_open(&identifiers.open_receipt, "main", &authorization)
        }))
        .expect("post-commit unlock failure must not panic")
        .unwrap();

        let snapshot = match committed {
            OpenCommitResult::Committed { recent_files } => recent_files,
            OpenCommitResult::NotCommitted { message } => {
                panic!("post-commit unlock failure reported not_committed: {message}")
            }
        };
        let persisted: RecentFileStoreV1 =
            serde_json::from_slice(&fs::read(recent.store.store_path()).unwrap()).unwrap();
        assert_eq!(persisted.entries.len(), 1);
        assert_eq!(
            persisted.entries[0].canonical_target,
            canonical_document.to_string_lossy()
        );
        assert_eq!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::Committed {
                recent_files: snapshot,
            }
        );
        assert_eq!(
            authorization
                .exact_write_grant_snapshot_for_test(&canonical_document)
                .unwrap(),
            Some((crate::path_auth::GrantStatus::Active, 1))
        );
    }

    #[test]
    fn unlock_failure_does_not_replace_the_primary_operation_error() {
        let directory = tempdir().unwrap();
        let mut store = store_with(
            directory.path().to_path_buf(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        store.fail_unlock = true;

        let result: Result<(), String> =
            store.with_exclusive_lock(|| Err("primary operation failure".to_string()));

        assert_eq!(result.unwrap_err(), "primary operation failure");
    }

    #[test]
    fn same_process_commit_then_clear_is_serialized_without_lost_state() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
        let recent = Arc::new(state_with(
            directory.path().join("app-data"),
            replacer.clone(),
        ));
        let authorization = Arc::new(FileAuthorizationSession::default());
        let identifiers = recent.issue_open("main", &document).unwrap();
        replacer.pause_next_replacement();

        let commit_recent = Arc::clone(&recent);
        let commit_authorization = Arc::clone(&authorization);
        let open_receipt = identifiers.open_receipt;
        let commit_thread = thread::spawn(move || {
            commit_recent.commit_open(&open_receipt, "main", &commit_authorization)
        });
        replacement_entered
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (clear_started_tx, clear_started_rx) = mpsc::channel();
        let (clear_done_tx, clear_done_rx) = mpsc::channel();
        let clear_recent = Arc::clone(&recent);
        let clear_thread = thread::spawn(move || {
            clear_started_tx.send(()).unwrap();
            let result = clear_recent.clear();
            clear_done_tx.send(()).unwrap();
            result
        });
        clear_started_rx.recv().unwrap();
        assert!(clear_done_rx
            .recv_timeout(Duration::from_millis(40))
            .is_err());

        release_replacement.send(()).unwrap();
        assert!(matches!(
            commit_thread.join().unwrap().unwrap(),
            OpenCommitResult::Committed { .. }
        ));
        assert!(clear_thread.join().unwrap().unwrap().entries.is_empty());
        assert!(recent.list().unwrap().entries.is_empty());
    }

    #[test]
    fn same_process_commit_then_remove_reloads_before_removing_without_lost_promotion() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
        let recent = Arc::new(state_with(
            directory.path().join("app-data"),
            replacer.clone(),
        ));
        let authorization = Arc::new(FileAuthorizationSession::default());
        let first_snapshot = commit_document(&recent, "main", &first, &authorization);
        let first_id = first_snapshot.entries[0].id.clone();
        let identifiers = recent.issue_open("main", &second).unwrap();
        replacer.pause_next_replacement();

        let commit_recent = Arc::clone(&recent);
        let commit_authorization = Arc::clone(&authorization);
        let open_receipt = identifiers.open_receipt;
        let commit_thread = thread::spawn(move || {
            commit_recent.commit_open(&open_receipt, "main", &commit_authorization)
        });
        replacement_entered
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (remove_started_tx, remove_started_rx) = mpsc::channel();
        let (remove_done_tx, remove_done_rx) = mpsc::channel();
        let remove_recent = Arc::clone(&recent);
        let remove_thread = thread::spawn(move || {
            remove_started_tx.send(()).unwrap();
            let result = remove_recent.remove(&first_id);
            remove_done_tx.send(()).unwrap();
            result
        });
        remove_started_rx.recv().unwrap();
        assert!(remove_done_rx
            .recv_timeout(Duration::from_millis(40))
            .is_err());

        release_replacement.send(()).unwrap();
        assert!(matches!(
            commit_thread.join().unwrap().unwrap(),
            OpenCommitResult::Committed { .. }
        ));
        let removed = remove_thread.join().unwrap().unwrap();
        assert_eq!(removed.entries.len(), 1);
        assert_eq!(removed.entries[0].display_name, "second.md");
        assert_eq!(recent.list().unwrap(), removed);
    }

    #[test]
    fn same_process_clear_then_remove_is_serialized_to_one_empty_store() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
        let recent = Arc::new(state_with(
            directory.path().join("app-data"),
            replacer.clone(),
        ));
        let authorization = FileAuthorizationSession::default();
        commit_document(&recent, "main", &first, &authorization);
        let snapshot = commit_document(&recent, "main", &second, &authorization);
        let first_id = snapshot
            .entries
            .iter()
            .find(|entry| entry.display_name == "first.md")
            .unwrap()
            .id
            .clone();
        replacer.pause_next_replacement();

        let clear_recent = Arc::clone(&recent);
        let clear_thread = thread::spawn(move || clear_recent.clear());
        replacement_entered
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (remove_started_tx, remove_started_rx) = mpsc::channel();
        let (remove_done_tx, remove_done_rx) = mpsc::channel();
        let remove_recent = Arc::clone(&recent);
        let remove_thread = thread::spawn(move || {
            remove_started_tx.send(()).unwrap();
            let result = remove_recent.remove(&first_id);
            remove_done_tx.send(()).unwrap();
            result
        });
        remove_started_rx.recv().unwrap();
        assert!(remove_done_rx
            .recv_timeout(Duration::from_millis(40))
            .is_err());

        release_replacement.send(()).unwrap();
        assert!(clear_thread.join().unwrap().unwrap().entries.is_empty());
        assert!(remove_thread.join().unwrap().unwrap().entries.is_empty());
        assert!(recent.list().unwrap().entries.is_empty());
        let persisted: RecentFileStoreV1 =
            serde_json::from_slice(&fs::read(recent.store.store_path()).unwrap()).unwrap();
        assert_eq!(persisted, RecentFileStoreV1::empty());
    }

    #[test]
    fn committed_open_obeys_mru_fs2_authorization_lock_order() {
        use crate::path_auth::lock_order_test_probe::{trace, LockEvent};

        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &document).unwrap();

        let mut published_asset_target = None;
        let (result, events) = trace(|| {
            recent.commit_open_with_post_commit(
                &identifiers.open_receipt,
                "main",
                &authorization,
                |target| {
                    crate::path_auth::lock_order_test_probe::assert_no_locks_held();
                    published_asset_target = Some(target.to_path_buf());
                },
            )
        });

        assert!(matches!(
            result.unwrap(),
            OpenCommitResult::Committed { .. }
        ));
        assert_eq!(
            published_asset_target,
            Some(document.canonicalize().unwrap())
        );
        assert_eq!(
            events,
            vec![
                LockEvent::RecentRuntimeAcquired,
                LockEvent::RecentFs2Acquired,
                LockEvent::AuthorizationAcquired,
                LockEvent::AuthorizationReleased,
                LockEvent::RecentFs2Released,
                LockEvent::RecentRuntimeReleased,
            ]
        );
    }

    #[test]
    fn committed_workspace_open_does_not_authorize_a_replacement_root() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let displaced = directory.path().join("displaced");
        let document = root.join("note.md");
        let asset = root.join("image.png");
        fs::create_dir(&root).unwrap();
        fs::write(&document, "authorized content").unwrap();
        fs::write(&asset, b"authorized image").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, root.clone()).unwrap();
        let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let identifiers = recent
            .issue_workspace_open(
                "main",
                opened
                    .workspace_authorization()
                    .expect("workspace reads carry their authorization"),
            )
            .unwrap();
        drop(opened);

        assert!(matches!(
            recent
                .commit_open(
                    &identifiers.open_receipt,
                    "main",
                    state.file_authorization()
                )
                .unwrap(),
            OpenCommitResult::Committed { .. }
        ));
        assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &asset.canonicalize().unwrap()).unwrap());

        fs::rename(&canonical_root, &displaced).unwrap();
        fs::create_dir(&canonical_root).unwrap();
        fs::write(canonical_root.join("note.md"), "external secret").unwrap();
        fs::write(canonical_root.join("image.png"), b"external image").unwrap();
        let replacement_document = canonical_root.join("note.md");
        let replacement_asset = canonical_root.join("image.png").canonicalize().unwrap();

        assert!(ensure_authorized_existing_file_inner(&state, &replacement_document).is_err());
        assert!(open_authorized_existing_file_inner(&state, &replacement_document).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &replacement_document).is_err());
        assert!(state
            .file_authorization()
            .with_exact_write_authority(&replacement_document, |_, _| Ok(()))
            .is_err());
        assert!(!is_authorized_image_path(&state, &replacement_asset).unwrap());
    }

    #[test]
    fn workspace_commit_does_not_transfer_write_authority_to_a_replaced_file() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let document = root.join("note.md");
        let displaced = root.join("displaced.md");
        fs::create_dir(&root).unwrap();
        fs::write(&document, "authorized content").unwrap();
        let state = Arc::new(AppState::default());
        authorize_directory_root_inner(&state, root).unwrap();
        let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
        let (replacer, replacement_entered, release_replacement) = PausingReplacer::new();
        let recent = Arc::new(state_with(
            directory.path().join("app-data"),
            replacer.clone(),
        ));
        let identifiers = recent
            .issue_workspace_open(
                "main",
                opened
                    .workspace_authorization()
                    .expect("workspace reads carry their authorization"),
            )
            .unwrap();
        drop(opened);
        replacer.pause_next_replacement();
        let commit_recent = recent.clone();
        let commit_state = state.clone();
        let open_receipt = identifiers.open_receipt;
        let commit = thread::spawn(move || {
            commit_recent.commit_open(&open_receipt, "main", commit_state.file_authorization())
        });
        replacement_entered
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        fs::rename(&document, &displaced).unwrap();
        fs::write(&document, "replacement content").unwrap();
        release_replacement.send(()).unwrap();

        assert!(matches!(
            commit.join().unwrap().unwrap(),
            OpenCommitResult::NotCommitted { .. }
        ));
        assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
        assert!(state
            .file_authorization()
            .with_exact_write_authority(&document, |_, _| Ok(()))
            .is_err());
        assert!(recent.list().unwrap().entries.is_empty());
    }

    #[test]
    fn workspace_commit_reports_indeterminate_when_recent_store_rollback_fails() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let document = root.join("note.md");
        let displaced = root.join("displaced.md");
        fs::create_dir(&root).unwrap();
        fs::write(&document, "authorized content").unwrap();
        let state = Arc::new(AppState::default());
        authorize_directory_root_inner(&state, root).unwrap();
        let opened = open_authorized_existing_file_inner(&state, &document).unwrap();
        let (replacer, replacement_entered, release_replacement) =
            PausingRollbackFailingReplacer::new();
        let recent = Arc::new(state_with(directory.path().join("app-data"), replacer));
        let identifiers = recent
            .issue_workspace_open(
                "main",
                opened
                    .workspace_authorization()
                    .expect("workspace reads carry their authorization"),
            )
            .unwrap();
        drop(opened);
        let commit_recent = recent.clone();
        let commit_state = state.clone();
        let open_receipt = identifiers.open_receipt;
        let commit = thread::spawn(move || {
            commit_recent.commit_open(&open_receipt, "main", commit_state.file_authorization())
        });
        replacement_entered
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        fs::rename(&document, &displaced).unwrap();
        fs::write(&document, "replacement content").unwrap();
        release_replacement.send(()).unwrap();

        let error = commit.join().unwrap().unwrap_err();
        assert!(error.contains("indeterminate"));
        assert!(matches!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::Unknown
        ));
        assert_eq!(recent.list().unwrap().entries.len(), 1);
        assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
    }

    #[test]
    fn replacement_failure_is_terminal_not_committed_and_publishes_no_grant() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with(directory.path().join("app-data"), Arc::new(FailingReplacer));
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &canonical_document).unwrap();

        assert!(matches!(
            recent
                .commit_open(&identifiers.open_receipt, "main", &authorization)
                .unwrap(),
            OpenCommitResult::NotCommitted { .. }
        ));
        assert!(matches!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::NotCommitted { .. }
        ));
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
    }

    #[test]
    fn pre_commit_target_revalidation_failure_is_not_committed_and_grants_nothing() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &document).unwrap();
        fs::remove_file(&document).unwrap();

        assert!(matches!(
            recent
                .commit_open(&identifiers.open_receipt, "main", &authorization)
                .unwrap(),
            OpenCommitResult::NotCommitted { .. }
        ));
        assert!(matches!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::NotCommitted { .. }
        ));
        assert!(!recent.store.store_path().exists());
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
    }

    #[test]
    fn pre_commit_terminal_outcome_reservation_failure_cannot_publish_store_or_grant() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &document).unwrap();
        recent.runtime.lock().unwrap().next_sequence = u64::MAX;

        let error = recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap_err();

        assert!(error.contains("insertion sequence is exhausted"));
        assert_eq!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::Unknown
        );
        assert!(!recent.store.store_path().exists());
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
    }

    #[test]
    fn pre_commit_promotion_id_exhaustion_is_not_committed_and_grants_nothing() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with_ids(
            directory.path().join("app-data"),
            Arc::new(SystemRecentStoreAtomicReplacer),
            (1..=2).map(opaque_id),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &document).unwrap();

        assert!(matches!(
            recent
                .commit_open(&identifiers.open_receipt, "main", &authorization)
                .unwrap(),
            OpenCommitResult::NotCommitted { .. }
        ));
        assert!(matches!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::NotCommitted { .. }
        ));
        assert!(!recent.store.store_path().exists());
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
    }

    #[test]
    fn pre_commit_staging_name_exhaustion_is_not_committed_and_grants_nothing() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        fs::create_dir_all(&root).unwrap();
        for id in (4..=11).map(opaque_id) {
            fs::write(
                root.join(format!("{}.tmp-{id}", super::STORE_FILE_NAME)),
                b"collision",
            )
            .unwrap();
        }
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_document = document.canonicalize().unwrap();
        let recent = state_with_ids(
            root,
            Arc::new(SystemRecentStoreAtomicReplacer),
            (1..=11).map(opaque_id),
        );
        let authorization = FileAuthorizationSession::default();
        let identifiers = recent.issue_open("main", &document).unwrap();

        assert!(matches!(
            recent
                .commit_open(&identifiers.open_receipt, "main", &authorization)
                .unwrap(),
            OpenCommitResult::NotCommitted { .. }
        ));
        assert!(matches!(
            recent
                .status("main", &identifiers.commit_operation_id)
                .unwrap(),
            OpenCommitStatus::NotCommitted { .. }
        ));
        assert!(!recent.store.store_path().exists());
        assert!(authorization
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .is_none());
    }

    #[test]
    fn pre_commit_persistence_faults_preserve_prior_store_and_publish_no_new_grant() {
        for fault in [
            PersistFault::Serialize,
            PersistFault::CreateStagedFile,
            PersistFault::WriteStagedFile,
            PersistFault::SyncStagedFile,
            PersistFault::ReparseStagedFile,
        ] {
            let directory = tempdir().unwrap();
            let app_data = directory.path().join("app-data");
            let first = directory.path().join("first.md");
            let second = directory.path().join("second.md");
            fs::write(&first, "# first").unwrap();
            fs::write(&second, "# second").unwrap();
            let canonical_first = first.canonicalize().unwrap();
            let canonical_second = second.canonicalize().unwrap();
            let mut recent =
                state_with(app_data.clone(), Arc::new(SystemRecentStoreAtomicReplacer));
            let authorization = FileAuthorizationSession::default();
            let prior = commit_document(&recent, "main", &first, &authorization);
            let prior_bytes = fs::read(recent.store.store_path()).unwrap();
            recent.store.persist_fault = Some(fault);
            let identifiers = recent.issue_open("main", &second).unwrap();

            assert!(matches!(
                recent
                    .commit_open(&identifiers.open_receipt, "main", &authorization)
                    .unwrap(),
                OpenCommitResult::NotCommitted { .. }
            ));
            assert!(matches!(
                recent
                    .status("main", &identifiers.commit_operation_id)
                    .unwrap(),
                OpenCommitStatus::NotCommitted { .. }
            ));
            assert_eq!(fs::read(recent.store.store_path()).unwrap(), prior_bytes);
            assert_eq!(recent.list().unwrap(), prior);
            assert_eq!(load_strict_store(&recent.store).entries.len(), 1);
            assert_eq!(
                authorization
                    .exact_write_grant_snapshot_for_test(&canonical_first)
                    .unwrap(),
                Some((crate::path_auth::GrantStatus::Active, 1)),
                "prior grant changed for {fault:?}"
            );
            assert!(authorization
                .exact_write_grant_snapshot_for_test(&canonical_second)
                .unwrap()
                .is_none());
            assert!(fs::read_dir(&app_data).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));
        }
    }

    #[test]
    fn listing_repairs_stale_entries_to_a_private_complete_v1_image() {
        let directory = tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        let document = directory.path().join("notes.md");
        fs::write(&document, "# Notes").unwrap();
        let canonical = document.canonicalize().unwrap();
        let store = store_with(
            app_data.clone(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        fs::write(
            store.store_path(),
            serde_json::to_vec(&json!({
                "version": 1,
                "entries": [
                    { "id": ID_A, "canonicalTarget": canonical },
                    { "id": ID_B, "canonicalTarget": directory.path().join("missing.md") }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let snapshot = store.list().unwrap();

        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].id, ID_A);
        assert_eq!(snapshot.entries[0].display_name, "notes.md");
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
        assert_eq!(persisted["version"], 1);
        assert_eq!(persisted["entries"].as_array().unwrap().len(), 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&app_data).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(store.store_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(store.lock_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn replacement_failure_preserves_the_complete_prior_image_and_removes_staging() {
        let directory = tempdir().unwrap();
        let active_store = store_with(
            directory.path().to_path_buf(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        let prior = RecentFileStoreV1 {
            version: 1,
            entries: vec![RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md"))],
        };
        active_store.persist(&prior).unwrap();
        let prior_bytes = fs::read(active_store.store_path()).unwrap();

        let failing_store = store_with(
            directory.path().to_path_buf(),
            Arc::new(FailingReplacer),
            Duration::from_millis(1),
            Duration::from_millis(100),
        );
        let next = RecentFileStoreV1 {
            version: 1,
            entries: vec![RecentFileEntryV1::new(ID_B, absolute_path("docs/b.md"))],
        };

        assert!(failing_store.persist(&next).is_err());
        assert_eq!(fs::read(failing_store.store_path()).unwrap(), prior_bytes);
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")));
    }

    #[test]
    fn fs2_lock_waits_for_release_and_times_out_without_mutating_the_store() {
        let directory = tempdir().unwrap();
        let store = store_with(
            directory.path().to_path_buf(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(5),
            Duration::from_millis(80),
        );
        store.ensure_storage().unwrap();
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(store.lock_path())
            .unwrap();
        lock.lock_exclusive().unwrap();
        let started = Instant::now();

        let error = store.list().unwrap_err();

        assert!(error.contains("busy"));
        assert!(started.elapsed() >= Duration::from_millis(75));
        assert!(!store.store_path().exists());
        lock.unlock().unwrap();

        let waiting_store = store_with(
            directory.path().to_path_buf(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(5),
            Duration::from_secs(2),
        );
        let lock = Arc::new(lock);
        lock.lock_exclusive().unwrap();
        let releasing_lock = Arc::clone(&lock);
        let (release_started_tx, release_started_rx) = mpsc::channel();
        let release = thread::spawn(move || {
            release_started_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(30));
            releasing_lock.unlock().unwrap();
        });
        release_started_rx.recv().unwrap();
        let snapshot = waiting_store.list().unwrap();
        release.join().unwrap();
        assert!(snapshot.entries.is_empty());
    }

    #[test]
    fn fs2_lock_contention_waits_and_times_out_across_real_processes() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        let ready = directory.path().join("child-ready");
        let store = store_with(
            root.clone(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(5),
            Duration::from_millis(500),
        );

        let mut wait_command = recent_files_child_command("hold-lock", &root);
        let wait_child = wait_command
            .env("MMD_RECENT_FILES_CHILD_READY", &ready)
            .env("MMD_RECENT_FILES_CHILD_HOLD_MS", "120")
            .spawn()
            .unwrap();
        wait_until_created(&ready);
        let started = Instant::now();
        assert!(store.list().unwrap().entries.is_empty());
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert_child_success(wait_child);

        fs::remove_file(&ready).unwrap();
        let timeout_store = store_with(
            root.clone(),
            Arc::new(SystemRecentStoreAtomicReplacer),
            Duration::from_millis(5),
            Duration::from_millis(80),
        );
        let mut timeout_command = recent_files_child_command("hold-lock", &root);
        let timeout_child = timeout_command
            .env("MMD_RECENT_FILES_CHILD_READY", &ready)
            .env("MMD_RECENT_FILES_CHILD_HOLD_MS", "250")
            .spawn()
            .unwrap();
        wait_until_created(&ready);
        let started = Instant::now();
        let error = timeout_store.list().unwrap_err();
        assert!(error.contains("busy"));
        assert!(started.elapsed() >= Duration::from_millis(75));
        assert_child_success(timeout_child);
    }

    #[test]
    fn concurrent_process_commits_reload_under_lock_without_lost_updates() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();

        let mut first_command = recent_files_child_command("commit", &root);
        let first_child = first_command
            .env("MMD_RECENT_FILES_CHILD_TARGET", &first)
            .spawn()
            .unwrap();
        let mut second_command = recent_files_child_command("commit", &root);
        let second_child = second_command
            .env("MMD_RECENT_FILES_CHILD_TARGET", &second)
            .spawn()
            .unwrap();
        assert_child_success(first_child);
        assert_child_success(second_child);

        let store = RecentStore::new(root);
        let snapshot = store.list().unwrap();
        assert_eq!(
            snapshot
                .entries
                .iter()
                .map(|entry| entry.display_name.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["first.md", "second.md"]),
        );
        let persisted: RecentFileStoreV1 =
            serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
        assert_eq!(persisted.entries.len(), 2);
        assert!(serialize_complete_store(&persisted).is_ok());
    }

    #[test]
    fn cross_process_commit_and_clear_have_only_valid_serial_outcomes() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let seed_recent = RecentFilesState::new(root.clone());
        commit_document(
            &seed_recent,
            "seed",
            &first,
            &FileAuthorizationSession::default(),
        );

        let start = directory.path().join("race-start");
        let commit_ready = directory.path().join("commit-ready");
        let clear_ready = directory.path().join("clear-ready");
        let mut commit_command = recent_files_child_command("commit", &root);
        commit_command.env("MMD_RECENT_FILES_CHILD_TARGET", &second);
        let commit_child = spawn_gated_child(&mut commit_command, &commit_ready, &start);
        let mut clear_command = recent_files_child_command("clear", &root);
        let clear_child = spawn_gated_child(&mut clear_command, &clear_ready, &start);
        wait_until_created(&commit_ready);
        wait_until_created(&clear_ready);
        fs::write(&start, b"start").unwrap();
        assert_child_success(commit_child);
        assert_child_success(clear_child);

        let store = RecentStore::new(root);
        let snapshot = store.list().unwrap();
        let names = snapshot
            .entries
            .iter()
            .map(|entry| entry.display_name.as_str())
            .collect::<Vec<_>>();
        assert!(names.is_empty() || names == ["second.md"]);
        assert!(!names.contains(&"first.md"));
        assert_eq!(load_strict_store(&store).entries.len(), names.len());
    }

    #[test]
    fn cross_process_commit_and_remove_reload_without_losing_either_update() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let seed_recent = RecentFilesState::new(root.clone());
        let seeded = commit_document(
            &seed_recent,
            "seed",
            &first,
            &FileAuthorizationSession::default(),
        );
        let first_id = seeded.entries[0].id.clone();

        let start = directory.path().join("race-start");
        let commit_ready = directory.path().join("commit-ready");
        let remove_ready = directory.path().join("remove-ready");
        let mut commit_command = recent_files_child_command("commit", &root);
        commit_command.env("MMD_RECENT_FILES_CHILD_TARGET", &second);
        let commit_child = spawn_gated_child(&mut commit_command, &commit_ready, &start);
        let mut remove_command = recent_files_child_command("remove", &root);
        remove_command.env("MMD_RECENT_FILES_CHILD_ENTRY_ID", first_id);
        let remove_child = spawn_gated_child(&mut remove_command, &remove_ready, &start);
        wait_until_created(&commit_ready);
        wait_until_created(&remove_ready);
        fs::write(&start, b"start").unwrap();
        assert_child_success(commit_child);
        assert_child_success(remove_child);

        let store = RecentStore::new(root);
        let snapshot = store.list().unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].display_name, "second.md");
        let persisted = load_strict_store(&store);
        assert_eq!(persisted.entries.len(), 1);
        assert_eq!(
            persisted.entries[0].canonical_target,
            second.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn cross_process_clear_and_remove_converge_to_one_complete_empty_store() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("app-data");
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let seed_recent = RecentFilesState::new(root.clone());
        let authorization = FileAuthorizationSession::default();
        commit_document(&seed_recent, "seed", &first, &authorization);
        let seeded = commit_document(&seed_recent, "seed", &second, &authorization);
        let first_id = seeded
            .entries
            .iter()
            .find(|entry| entry.display_name == "first.md")
            .unwrap()
            .id
            .clone();

        let start = directory.path().join("race-start");
        let clear_ready = directory.path().join("clear-ready");
        let remove_ready = directory.path().join("remove-ready");
        let mut clear_command = recent_files_child_command("clear", &root);
        let clear_child = spawn_gated_child(&mut clear_command, &clear_ready, &start);
        let mut remove_command = recent_files_child_command("remove", &root);
        remove_command.env("MMD_RECENT_FILES_CHILD_ENTRY_ID", first_id);
        let remove_child = spawn_gated_child(&mut remove_command, &remove_ready, &start);
        wait_until_created(&clear_ready);
        wait_until_created(&remove_ready);
        fs::write(&start, b"start").unwrap();
        assert_child_success(clear_child);
        assert_child_success(remove_child);

        let store = RecentStore::new(root);
        assert!(store.list().unwrap().entries.is_empty());
        assert_eq!(load_strict_store(&store), RecentFileStoreV1::empty());
    }
}
