//! Terminal-outcome retention and settlement.
use super::*;

impl RecentRuntime {
    #[cfg(test)]
    pub(super) fn retain_outcome(
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

    pub(super) fn prepare_terminal_outcome(
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

    pub(super) fn apply_terminal_outcome(
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

    pub(super) fn status(
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

    pub(super) fn remove_owner(&mut self, owner_window: &str, now: Duration) {
        self.prune(now);
        self.pending_receipts
            .retain(|_, pending| pending.owner_window != owner_window);
        self.terminal_outcomes
            .retain(|_, record| record.owner_window != owner_window);
    }

    pub(super) fn shutdown(&mut self, now: Duration) {
        self.prune(now);
        self.pending_receipts.clear();
        self.terminal_outcomes.clear();
    }

    pub(super) fn prune(&mut self, now: Duration) {
        self.pending_receipts
            .retain(|_, pending| elapsed_since(now, pending.issued_at) < PENDING_RECEIPT_TTL);
        self.terminal_outcomes
            .retain(|_, record| elapsed_since(now, record.finished_at) < TERMINAL_OUTCOME_TTL);
    }

    pub(super) fn operation_id_in_use(&self, commit_operation_id: &str) -> bool {
        self.terminal_outcomes.contains_key(commit_operation_id)
            || self
                .pending_receipts
                .values()
                .any(|pending| pending.commit_operation_id == commit_operation_id)
    }

    pub(super) fn allocate_sequence(&mut self) -> Result<u64, String> {
        let sequence = self.next_sequence;
        self.next_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| "Recent file insertion sequence is exhausted".to_string())?;
        Ok(sequence)
    }

    #[cfg(test)]
    pub(super) fn pending_len(&self) -> usize {
        self.pending_receipts.len()
    }

    #[cfg(test)]
    pub(super) fn outcome_len(&self) -> usize {
        self.terminal_outcomes.len()
    }
}
