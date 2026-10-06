//! Persistent recent-file store operations.
use super::*;
use crate::private_fs::sync_parent_directory;


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

    pub(super) fn with_ports(
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

    pub(super) fn store_path(&self) -> &Path {
        &self.store_path
    }

    pub(super) fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    pub(super) fn unlock(&self, lock: &File) -> io::Result<()> {
        #[cfg(test)]
        if self.fail_unlock {
            return Err(io::Error::other("injected unlock failure"));
        }
        lock.unlock()
    }

    #[cfg(test)]
    pub(super) fn inject_persist_fault(&self, fault: PersistFault) -> Result<(), String> {
        if self.persist_fault == Some(fault) {
            Err(format!("injected persistence fault at {fault:?}"))
        } else {
            Ok(())
        }
    }

    pub(super) fn ensure_storage(&self) -> Result<(), String> {
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

    pub(super) fn list(&self) -> Result<RecentFilesSnapshot, String> {
        self.with_exclusive_lock(|| {
            let store = self.load_repaired_locked()?;
            store.snapshot()
        })
    }

    #[cfg(test)]
    pub(super) fn remove(&self, entry_id: &str) -> Result<RecentFilesSnapshot, String> {
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

    pub(super) fn clear(&self) -> Result<RecentFilesSnapshot, String> {
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
    pub(super) fn persist(&self, store: &RecentFileStoreV1) -> Result<(), String> {
        self.with_exclusive_lock(|| self.persist_locked(store))
    }

    pub(super) fn with_current_store<T>(
        &self,
        operation: impl FnOnce(RecentFileStoreV1) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_exclusive_lock(|| operation(self.load_repaired_locked()?))
    }

    pub(super) fn with_exclusive_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_storage()?;
        let lock = open_private_file(self.lock_path(), true)
            .map_err(|error| format!("Cannot open recent files lock: {error}"))?;
        let started = Instant::now();
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(error) if is_retryable_try_lock_error(&error) => {
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

    pub(super) fn persist_locked(&self, store: &RecentFileStoreV1) -> Result<(), String> {
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

    pub(super) fn load_repaired_locked(&self) -> Result<RecentFileStoreV1, String> {
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

    pub(super) fn create_staged_file(&self) -> Result<(PathBuf, File), String> {
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
