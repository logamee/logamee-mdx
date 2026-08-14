use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::recent_files::is_retryable_lock_contention;

const STORE_VERSION: u8 = 1;
const STORE_FILE_NAME: &str = "workspace-session-v1.json";
const LOCK_FILE_NAME: &str = "workspace-session-v1.lock";
const MAX_STORE_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const STAGING_ATTEMPTS: usize = 8;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceSessionRecord {
    version: u8,
    workspace_root: String,
    active_path: Option<String>,
}

impl WorkspaceSessionRecord {
    pub(crate) fn new(workspace_root: String, active_path: Option<String>) -> Self {
        Self {
            version: STORE_VERSION,
            workspace_root,
            active_path,
        }
    }

    pub(crate) fn workspace_root(&self) -> &str {
        &self.workspace_root
    }

    pub(crate) fn active_path(&self) -> Option<&str> {
        self.active_path.as_deref()
    }

    pub(crate) fn without_active_path(&self) -> Self {
        Self::new(self.workspace_root.clone(), None)
    }

    fn is_valid(&self) -> bool {
        self.version == STORE_VERSION
            && valid_persisted_path(&self.workspace_root)
            && self.active_path.as_deref().is_none_or(valid_persisted_path)
    }
}

pub(crate) trait WorkspaceSessionAtomicReplacer: Send + Sync {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()>;
}

pub(crate) struct SystemWorkspaceSessionAtomicReplacer;

impl WorkspaceSessionAtomicReplacer for SystemWorkspaceSessionAtomicReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        replace_file_atomically(staged, active)
    }
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

pub(crate) struct WorkspaceSessionState {
    store: WorkspaceSessionStore,
}

impl WorkspaceSessionState {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            store: WorkspaceSessionStore::new(root),
        }
    }

    pub(crate) fn load(&self) -> Result<Option<WorkspaceSessionRecord>, String> {
        self.store.load()
    }

    pub(crate) fn save(&self, record: &WorkspaceSessionRecord) -> Result<(), String> {
        self.store.save(record)
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        self.store.clear()
    }
}

pub(crate) struct WorkspaceSessionStore {
    root: PathBuf,
    store_path: PathBuf,
    lock_path: PathBuf,
    replacer: Box<dyn WorkspaceSessionAtomicReplacer>,
    retry_interval: Duration,
    lock_timeout: Duration,
}

impl WorkspaceSessionStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self::with_replacer(
            root,
            Box::new(SystemWorkspaceSessionAtomicReplacer),
            Duration::from_millis(25),
            Duration::from_secs(2),
        )
    }

    #[cfg(test)]
    fn with_test_replacer(
        root: PathBuf,
        replacer: Box<dyn WorkspaceSessionAtomicReplacer>,
    ) -> Self {
        Self::with_replacer(
            root,
            replacer,
            Duration::from_millis(1),
            Duration::from_millis(50),
        )
    }

    fn with_replacer(
        root: PathBuf,
        replacer: Box<dyn WorkspaceSessionAtomicReplacer>,
        retry_interval: Duration,
        lock_timeout: Duration,
    ) -> Self {
        Self {
            store_path: root.join(STORE_FILE_NAME),
            lock_path: root.join(LOCK_FILE_NAME),
            root,
            replacer,
            retry_interval,
            lock_timeout,
        }
    }

    #[cfg(test)]
    pub(crate) fn store_path(&self) -> &Path {
        &self.store_path
    }

    pub(crate) fn load(&self) -> Result<Option<WorkspaceSessionRecord>, String> {
        self.with_exclusive_lock(|| {
            let bytes = match read_bounded(&self.store_path, MAX_STORE_BYTES) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(format!("Cannot read workspace session: {error}")),
            };
            if bytes.len() > MAX_STORE_BYTES {
                self.clear_locked()?;
                return Ok(None);
            }
            let record = match serde_json::from_slice::<WorkspaceSessionRecord>(&bytes) {
                Ok(record) if record.is_valid() => record,
                _ => {
                    self.clear_locked()?;
                    return Ok(None);
                }
            };
            Ok(Some(record))
        })
    }

    pub(crate) fn save(&self, record: &WorkspaceSessionRecord) -> Result<(), String> {
        self.with_exclusive_lock(|| self.persist_locked(record))
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        self.with_exclusive_lock(|| self.clear_locked())
    }

    fn ensure_storage(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("Cannot create workspace session storage: {error}"))?;
        set_private_directory_permissions(&self.root)
            .map_err(|error| format!("Cannot secure workspace session storage: {error}"))?;

        let lock = open_private_file(&self.lock_path, true)
            .map_err(|error| format!("Cannot open workspace session lock: {error}"))?;
        drop(lock);
        if self.store_path.exists() {
            set_private_file_permissions(&self.store_path)
                .map_err(|error| format!("Cannot secure workspace session store: {error}"))?;
        }
        Ok(())
    }

    fn with_exclusive_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_storage()?;
        let lock = open_private_file(&self.lock_path, true)
            .map_err(|error| format!("Cannot open workspace session lock: {error}"))?;
        let started = Instant::now();
        loop {
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if is_retryable_lock_contention(&error) => {
                    let elapsed = started.elapsed();
                    if elapsed >= self.lock_timeout {
                        return Err("Workspace session store is busy".to_string());
                    }
                    thread::sleep(self.retry_interval.min(self.lock_timeout - elapsed));
                }
                Err(error) => return Err(format!("Cannot lock workspace session store: {error}")),
            }
        }

        let result = operation();
        let _ = FileExt::unlock(&lock);
        drop(lock);
        result
    }

    fn persist_locked(&self, record: &WorkspaceSessionRecord) -> Result<(), String> {
        let bytes = serialize_complete_record(record)?;
        let (staged_path, mut staged_file) = self.create_staged_file()?;
        let result = (|| {
            staged_file
                .write_all(&bytes)
                .map_err(|error| format!("Cannot stage workspace session: {error}"))?;
            staged_file
                .sync_all()
                .map_err(|error| format!("Cannot stage workspace session: {error}"))?;
            drop(staged_file);

            let staged_bytes = read_bounded(&staged_path, MAX_STORE_BYTES)
                .map_err(|error| format!("Cannot verify staged workspace session: {error}"))?;
            let reparsed: WorkspaceSessionRecord = serde_json::from_slice(&staged_bytes)
                .map_err(|error| format!("Cannot verify staged workspace session: {error}"))?;
            if reparsed != *record || !reparsed.is_valid() {
                return Err("Staged workspace session image failed strict verification".to_string());
            }

            self.replacer
                .replace_complete_image(&staged_path, &self.store_path)
                .map_err(|error| format!("Cannot replace workspace session store: {error}"))?;
            let _ = set_private_file_permissions(&self.store_path);
            let _ = sync_parent_directory(&self.root);
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&staged_path);
        }
        result
    }

    fn clear_locked(&self) -> Result<(), String> {
        match fs::remove_file(&self.store_path) {
            Ok(()) => {
                let _ = sync_parent_directory(&self.root);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Cannot clear workspace session: {error}")),
        }
    }

    fn create_staged_file(&self) -> Result<(PathBuf, File), String> {
        for _ in 0..STAGING_ATTEMPTS {
            let id = random_staging_id()?;
            let path = self.root.join(format!("{STORE_FILE_NAME}.tmp-{id}"));
            match open_private_file(&path, false) {
                Ok(file) => return Ok((path, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("Cannot create staged workspace session: {error}"));
                }
            }
        }
        Err("Cannot allocate a unique workspace session staging path".to_string())
    }
}

fn random_staging_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        format!("Cannot generate workspace session staging identifier: {error}")
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn read_bounded(path: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn serialize_complete_record(record: &WorkspaceSessionRecord) -> Result<Vec<u8>, String> {
    if !record.is_valid() {
        return Err("Workspace session record is invalid".to_string());
    }
    let bytes = serde_json::to_vec(record)
        .map_err(|error| format!("Cannot serialize workspace session: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Workspace session store exceeds its size limit".to_string());
    }
    Ok(bytes)
}

fn valid_persisted_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= MAX_PATH_BYTES && Path::new(path).is_absolute()
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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        fs::OpenOptions,
        io,
        path::Path,
        time::{Duration, Instant},
    };

    use fs2::FileExt;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        WorkspaceSessionAtomicReplacer, WorkspaceSessionRecord, WorkspaceSessionStore,
        MAX_STORE_BYTES, STORE_FILE_NAME,
    };

    struct FailingReplacer;

    impl WorkspaceSessionAtomicReplacer for FailingReplacer {
        fn replace_complete_image(&self, _staged: &Path, _active: &Path) -> io::Result<()> {
            Err(io::Error::other("injected replacement failure"))
        }
    }

    fn absolute_path(relative: impl AsRef<Path>) -> String {
        #[cfg(windows)]
        let root = Path::new(r"C:\");
        #[cfg(not(windows))]
        let root = Path::new("/");

        root.join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn save_and_recreate_store_preserves_the_versioned_canonical_paths() {
        let directory = tempdir().unwrap();
        let store = WorkspaceSessionStore::new(directory.path().to_path_buf());
        let workspace_root = absolute_path("workspace");
        let active_path = absolute_path("workspace/notes.md");
        let record = WorkspaceSessionRecord::new(workspace_root.clone(), Some(active_path.clone()));

        store.save(&record).unwrap();

        let recreated = WorkspaceSessionStore::new(directory.path().to_path_buf());
        assert_eq!(recreated.load().unwrap(), Some(record));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(directory.path().join(STORE_FILE_NAME)).unwrap()
            )
            .unwrap(),
            json!({
                "version": 1,
                "workspace_root": workspace_root,
                "active_path": active_path,
            })
        );
    }

    #[test]
    fn corrupt_oversized_and_unknown_version_records_are_cleared() {
        let mut valid_record_with_padding = serde_json::to_vec(&WorkspaceSessionRecord::new(
            absolute_path("workspace"),
            None,
        ))
        .unwrap();
        let padding = MAX_STORE_BYTES + 1 - valid_record_with_padding.len();
        valid_record_with_padding.extend(vec![b' '; padding]);
        let records = vec![
            br#"not json"#.to_vec(),
            br#"{\"version\":2,\"workspace_root\":\"/workspace\",\"active_path\":null}"#.to_vec(),
            br#"{\"version\":1,\"workspace_root\":\"relative\",\"active_path\":null}"#.to_vec(),
            br#"{\"version\":1,\"workspace_root\":\"/workspace\",\"active_path\":null,\"extra\":true}"#.to_vec(),
            vec![b'x'; MAX_STORE_BYTES + 1],
            valid_record_with_padding,
        ];
        for bytes in records {
            let directory = tempdir().unwrap();
            let store = WorkspaceSessionStore::new(directory.path().to_path_buf());
            fs::write(store.store_path(), bytes).unwrap();

            assert_eq!(store.load().unwrap(), None);
            assert!(!store.store_path().exists());
        }
    }

    #[test]
    fn failed_persistence_keeps_the_last_complete_session_image() {
        let directory = tempdir().unwrap();
        let original = WorkspaceSessionRecord::new(
            absolute_path("workspace"),
            Some(absolute_path("workspace/notes.md")),
        );
        let replacement = WorkspaceSessionRecord::new(
            absolute_path("other-workspace"),
            Some(absolute_path("other-workspace/next.md")),
        );
        let healthy = WorkspaceSessionStore::new(directory.path().to_path_buf());
        healthy.save(&original).unwrap();

        let failing = WorkspaceSessionStore::with_test_replacer(
            directory.path().to_path_buf(),
            Box::new(FailingReplacer),
        );
        assert!(failing.save(&replacement).is_err());

        assert_eq!(healthy.load().unwrap(), Some(original));
    }

    #[test]
    fn lock_contention_retries_until_the_workspace_session_store_is_busy() {
        let directory = tempdir().unwrap();
        let store = WorkspaceSessionStore::with_replacer(
            directory.path().to_path_buf(),
            Box::new(super::SystemWorkspaceSessionAtomicReplacer),
            Duration::from_millis(5),
            Duration::from_millis(50),
        );
        store.ensure_storage().unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&store.lock_path)
            .unwrap();
        lock.lock_exclusive().unwrap();
        let started = Instant::now();

        let error = store.load().unwrap_err();

        assert_eq!(error, "Workspace session store is busy");
        assert!(started.elapsed() >= Duration::from_millis(45));
        lock.unlock().unwrap();
    }
}
