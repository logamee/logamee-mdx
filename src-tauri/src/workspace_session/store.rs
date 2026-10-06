//! Persistent workspace-session store with atomic replacement.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self, Read, Write},
    thread,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use crate::private_fs::{open_private_file, read_bounded, set_private_directory_permissions, set_private_file_permissions, sync_parent_directory};

use crate::recent_files::is_retryable_try_lock_error;

use super::{
    SystemWorkspaceSessionAtomicReplacer, WorkspaceSessionAtomicReplacer, WorkspaceSessionRecord,
    LOCK_FILE_NAME, MAX_STORE_BYTES, STAGING_ATTEMPTS, STORE_FILE_NAME,
};

pub(crate) struct WorkspaceSessionStore {
    pub(crate) root: PathBuf,
    pub(crate) store_path: PathBuf,
    pub(crate) lock_path: PathBuf,
    pub(crate) replacer: Box<dyn WorkspaceSessionAtomicReplacer>,
    pub(crate) retry_interval: Duration,
    pub(crate) lock_timeout: Duration,
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
    pub(crate) fn with_test_replacer(
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

    pub(crate) fn with_replacer(
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

    pub(crate) fn ensure_storage(&self) -> Result<(), String> {
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
            match lock.try_lock() {
                Ok(()) => break,
                Err(error) if is_retryable_try_lock_error(&error) => {
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
        let _ = lock.unlock();
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
