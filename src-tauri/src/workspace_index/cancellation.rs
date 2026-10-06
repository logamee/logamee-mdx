//! Cooperative cancellation for long-running index operations.
use std::{
    sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}},
    time::Instant,
};

#[derive(Debug)]
struct CancellationState {
    cancelled: AtomicBool,
    checks_before_cancel: AtomicUsize,
    deadline: Option<Instant>,
}

#[derive(Clone, Debug)]
pub struct CancellationToken(Arc<CancellationState>);

impl Default for CancellationToken {
    fn default() -> Self {
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            checks_before_cancel: AtomicUsize::new(usize::MAX),
            deadline: None,
        }))
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_deadline(deadline: Instant) -> Self {
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            checks_before_cancel: AtomicUsize::new(usize::MAX),
            deadline: Some(deadline),
        }))
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }

    /// Deterministic cancellation hook for benchmarks and tests. Production callers
    /// normally clone the token and call `cancel` from their request-stop path.
    pub fn cancel_after_checks(&self, checks: usize) {
        self.0.checks_before_cancel.store(checks, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        if self
            .0
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.cancel();
        }
        if self.0.cancelled.load(Ordering::Acquire) {
            return true;
        }
        let reached_zero = self
            .0
            .checks_before_cancel
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                if remaining != usize::MAX && remaining > 0 {
                    Some(remaining - 1)
                } else {
                    None
                }
            })
            .is_err();
        if reached_zero && self.0.checks_before_cancel.load(Ordering::Acquire) == 0 {
            self.cancel();
            return true;
        }
        false
    }
}
