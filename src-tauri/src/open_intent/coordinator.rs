//! Bounded open-intent queue and its coordinator.
use std::{
    collections::VecDeque,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::{
    ConsumedOpenIntent, ConsumedOpenIntentTarget, OpenIntentEnqueueError, OpenIntentEnqueueOutcome,
    OpenIntentId, OpenIntentPreview, OpenIntentSource, PendingOpenIntent,
    PendingOpenIntentTarget,
    DEFAULT_OPEN_INTENT_CAPACITY,
};
#[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
use super::OpenIntentHead;
use super::cli::{normalize_lexically, parse_open_intent_args};

#[derive(Debug)]
struct OpenIntentQueue {
    next_id: u64,
    pending: VecDeque<PendingOpenIntent>,
    explicit_open_requested: bool,
}

/// A bounded FIFO of untrusted requests to open a single path.
///
/// The coordinator only parses argv and performs lexical path joining. In particular it never
/// accesses, canonicalizes, classifies, or authorizes a candidate path.
#[derive(Debug)]
pub(crate) struct OpenIntentCoordinator {
    capacity: usize,
    queue: Mutex<OpenIntentQueue>,
}

impl Default for OpenIntentCoordinator {
    fn default() -> Self {
        Self::new(DEFAULT_OPEN_INTENT_CAPACITY)
    }
}

impl OpenIntentCoordinator {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            queue: Mutex::new(OpenIntentQueue {
                next_id: 1,
                pending: VecDeque::new(),
                explicit_open_requested: false,
            }),
        }
    }

    pub(crate) fn enqueue_args<I, S>(
        &self,
        args: I,
        forwarded_cwd: &Path,
        source: OpenIntentSource,
    ) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let candidate_path =
            parse_open_intent_args(args, forwarded_cwd).map_err(OpenIntentEnqueueError::Parse)?;
        self.enqueue_candidate(candidate_path, source)
    }

    pub(crate) fn enqueue_path(
        &self,
        candidate_path: PathBuf,
        source: OpenIntentSource,
    ) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError> {
        if !candidate_path.is_absolute() {
            return Err(OpenIntentEnqueueError::InvalidCandidatePath);
        }
        self.enqueue_candidate(normalize_lexically(&candidate_path), source)
    }

    /// Enqueues restoration without reading its persisted record or touching the filesystem.
    /// The record is loaded only after this opaque intent reaches the queue head.
    pub(crate) fn enqueue_session_restore(
        &self,
    ) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError> {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(intent) = queue
            .pending
            .iter()
            .find(|intent| matches!(intent.target, PendingOpenIntentTarget::SessionRestore))
        {
            return Ok(OpenIntentEnqueueOutcome::Coalesced(intent.head()));
        }
        if queue.pending.len() == self.capacity {
            return Err(OpenIntentEnqueueError::QueueFull);
        }

        let id = OpenIntentId(queue.next_id);
        queue.next_id = queue.next_id.wrapping_add(1).max(1);
        let intent = PendingOpenIntent {
            id,
            source: OpenIntentSource::SessionRestore,
            target: PendingOpenIntentTarget::SessionRestore,
        };
        let head = intent.head();
        queue.pending.push_back(intent);
        Ok(OpenIntentEnqueueOutcome::Enqueued(head))
    }

    fn enqueue_candidate(
        &self,
        candidate_path: PathBuf,
        source: OpenIntentSource,
    ) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError> {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Every explicit open (startup arguments, file association, drag-drop, or a second
        // instance) takes priority over automatic session restore. Remember that one arrived so
        // a session-restore request — or an already-enqueued restore intent — can be suppressed,
        // even when the explicit open is delivered after the restore request (for example the
        // macOS `Opened` event or a second instance racing the startup restore).
        queue.explicit_open_requested = true;

        if let Some(intent) = queue.pending.iter().find(|intent| {
            matches!(
                &intent.target,
                PendingOpenIntentTarget::CandidatePath(existing) if existing == &candidate_path
            )
        }) {
            return Ok(OpenIntentEnqueueOutcome::Coalesced(intent.head()));
        }
        if queue.pending.len() == self.capacity {
            return Err(OpenIntentEnqueueError::QueueFull);
        }

        let id = OpenIntentId(queue.next_id);
        queue.next_id = queue.next_id.wrapping_add(1).max(1);
        let intent = PendingOpenIntent {
            id,
            source,
            target: PendingOpenIntentTarget::CandidatePath(candidate_path),
        };
        let head = intent.head();
        queue.pending.push_back(intent);
        Ok(OpenIntentEnqueueOutcome::Enqueued(head))
    }

    #[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
    pub(crate) fn peek_head(&self) -> Option<OpenIntentHead> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .front()
            .map(PendingOpenIntent::head)
    }

    pub(crate) fn has_explicit_open_request(&self) -> bool {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .explicit_open_requested
    }

    pub(crate) fn peek_preview(&self) -> Option<OpenIntentPreview> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .front()
            .map(PendingOpenIntent::preview)
    }

    #[cfg(feature = "packaged-lifecycle-e2e")]
    pub(crate) fn preview_for_id(&self, id: OpenIntentId) -> Option<OpenIntentPreview> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .iter()
            .find(|intent| intent.id == id)
            .map(PendingOpenIntent::preview)
    }

    pub(crate) fn consume_matching_head(&self, id: OpenIntentId) -> Option<ConsumedOpenIntent> {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.pending.front().map(|intent| intent.id) != Some(id) {
            return None;
        }
        let intent = queue.pending.pop_front()?;
        Some(ConsumedOpenIntent {
            id: intent.id,
            source: intent.source,
            target: match intent.target {
                PendingOpenIntentTarget::CandidatePath(path) => {
                    ConsumedOpenIntentTarget::CandidatePath(path)
                }
                PendingOpenIntentTarget::SessionRestore => ConsumedOpenIntentTarget::SessionRestore,
            },
        })
    }

    pub(crate) fn discard_matching_head(&self, id: OpenIntentId) -> bool {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.pending.front().map(|intent| intent.id) != Some(id) {
            return false;
        }
        queue.pending.pop_front();
        true
    }
}
