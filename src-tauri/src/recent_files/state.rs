//! Public recent-files state facade.
use super::*;

pub(crate) struct OpenReceiptIdentifiers {
    pub(crate) open_receipt: String,
    pub(crate) commit_operation_id: String,
}

pub(crate) struct RecentFilesState {
    pub(crate) runtime: Mutex<RecentRuntime>,
    pub(crate) store: RecentStore,
    pub(crate) id_source: Arc<dyn OpaqueIdSource>,
    pub(crate) clock: Arc<dyn MonotonicClock>,
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
    pub(crate) fn with_ports(
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

}
