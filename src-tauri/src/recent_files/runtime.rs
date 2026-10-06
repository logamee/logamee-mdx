//! Open-receipt runtime state machine.
use super::*;

#[derive(Clone)]
pub(crate) struct PendingOpenReceipt {
    pub(crate) canonical_target: String,
    pub(crate) workspace_authorization: Option<WorkspaceReadAuthorization>,
    pub(crate) commit_operation_id: String,
    pub(crate) owner_window: String,
    pub(crate) issued_at: Duration,
    pub(crate) insertion_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TerminalOpenOutcome {
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeOpenStatus {
    Pending,
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalOutcomeRecord {
    pub(crate) owner_window: String,
    pub(crate) outcome: TerminalOpenOutcome,
    pub(crate) finished_at: Duration,
    pub(crate) insertion_sequence: u64,
}

pub(crate) struct PreparedTerminalOutcome {
    pub(crate) commit_operation_id: String,
    pub(crate) owner_window: String,
    pub(crate) finished_at: Duration,
    pub(crate) insertion_sequence: u64,
}

#[derive(Default)]
pub(crate) struct RecentRuntime {
    pub(crate) pending_receipts: HashMap<String, PendingOpenReceipt>,
    pub(crate) terminal_outcomes: HashMap<String, TerminalOutcomeRecord>,
    pub(crate) next_sequence: u64,
}

#[cfg(test)]
pub(crate) struct RecentRuntimeGuard<'a> {
    inner: Option<std::sync::MutexGuard<'a, RecentRuntime>>,
}

#[cfg(not(test))]
pub(crate) type RecentRuntimeGuard<'a> = std::sync::MutexGuard<'a, RecentRuntime>;

#[cfg(test)]
impl<'a> RecentRuntimeGuard<'a> {
    pub(super) fn new(inner: std::sync::MutexGuard<'a, RecentRuntime>) -> Self {
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
    pub(super) fn issue(
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

    pub(super) fn take_receipt(
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

    pub(super) fn discard_receipt(&mut self, open_receipt: &str, owner_window: &str, now: Duration) -> bool {
        self.take_receipt(open_receipt, owner_window, now).is_some()
    }

}
