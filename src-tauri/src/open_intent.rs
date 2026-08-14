use std::{
    collections::VecDeque,
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

pub(crate) const DEFAULT_OPEN_INTENT_CAPACITY: usize = 32;

/// Identifies the delivery channel, not the trust level, of a request to open a file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentSource {
    StartupArguments,
    SecondaryInstance,
    OpenedEvent,
    DragDrop,
    SessionRestore,
}

/// An opaque handle to an intent kept by [`OpenIntentCoordinator`].
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) struct OpenIntentId(u64);

impl OpenIntentId {
    const WIRE_PREFIX: &'static str = "open-intent-";

    pub(crate) fn to_wire(self) -> String {
        format!("{}{}", Self::WIRE_PREFIX, self.0)
    }

    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        let sequence = value.strip_prefix(Self::WIRE_PREFIX)?.parse::<u64>().ok()?;
        (sequence != 0).then_some(Self(sequence))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OpenIntentHead {
    id: OpenIntentId,
    source: OpenIntentSource,
}

impl OpenIntentHead {
    pub(crate) fn id(self) -> OpenIntentId {
        self.id
    }

    pub(crate) fn source(self) -> OpenIntentSource {
        self.source
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpenIntentPreview {
    id: OpenIntentId,
    source: OpenIntentSource,
    target: OpenIntentPreviewTarget,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentPreviewTarget {
    CandidatePath(PathBuf),
    SessionRestore,
}

impl OpenIntentPreview {
    pub(crate) fn id(&self) -> OpenIntentId {
        self.id
    }

    pub(crate) fn source(&self) -> OpenIntentSource {
        self.source
    }

    pub(crate) fn target(&self) -> &OpenIntentPreviewTarget {
        &self.target
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentEnqueueOutcome {
    Enqueued(OpenIntentHead),
    Coalesced(OpenIntentHead),
}

impl OpenIntentEnqueueOutcome {
    pub(crate) fn head(self) -> OpenIntentHead {
        match self {
            Self::Enqueued(head) | Self::Coalesced(head) => head,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentParseError {
    MissingTarget,
    MultipleTargets,
    UnexpectedOption,
    InvalidWorkingDirectory,
    EmptyTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentEnqueueError {
    Parse(OpenIntentParseError),
    InvalidCandidatePath,
    QueueFull,
}

#[derive(Debug)]
pub(crate) struct ConsumedOpenIntent {
    id: OpenIntentId,
    source: OpenIntentSource,
    target: ConsumedOpenIntentTarget,
}

#[derive(Debug)]
pub(crate) enum ConsumedOpenIntentTarget {
    CandidatePath(PathBuf),
    SessionRestore,
}

impl ConsumedOpenIntent {
    pub(crate) fn id(&self) -> OpenIntentId {
        self.id
    }

    pub(crate) fn source(&self) -> OpenIntentSource {
        self.source
    }

    // This candidate is only a hint. Authorization and file access remain later steps.
    pub(crate) fn target(&self) -> &ConsumedOpenIntentTarget {
        &self.target
    }
}

#[derive(Debug)]
struct PendingOpenIntent {
    id: OpenIntentId,
    source: OpenIntentSource,
    target: PendingOpenIntentTarget,
}

#[derive(Debug)]
enum PendingOpenIntentTarget {
    CandidatePath(PathBuf),
    SessionRestore,
}

impl PendingOpenIntent {
    fn head(&self) -> OpenIntentHead {
        OpenIntentHead {
            id: self.id,
            source: self.source,
        }
    }

    fn preview(&self) -> OpenIntentPreview {
        OpenIntentPreview {
            id: self.id,
            source: self.source,
            target: match &self.target {
                PendingOpenIntentTarget::CandidatePath(path) => {
                    OpenIntentPreviewTarget::CandidatePath(path.clone())
                }
                PendingOpenIntentTarget::SessionRestore => OpenIntentPreviewTarget::SessionRestore,
            },
        }
    }
}

#[derive(Debug)]
struct OpenIntentQueue {
    next_id: u64,
    pending: VecDeque<PendingOpenIntent>,
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

    pub(crate) fn peek_head(&self) -> Option<OpenIntentHead> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .front()
            .map(PendingOpenIntent::head)
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

pub(crate) fn parse_open_intent_args<I, S>(
    args: I,
    forwarded_cwd: &Path,
) -> Result<PathBuf, OpenIntentParseError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if !forwarded_cwd.is_absolute() {
        return Err(OpenIntentParseError::InvalidWorkingDirectory);
    }
    let mut arguments = args.into_iter();
    let _program_name = arguments.next();
    let mut target: Option<OsString> = None;
    let mut literal_target = false;

    for argument in arguments {
        let argument = argument.as_ref();
        if !literal_target && argument == OsStr::new("--") {
            literal_target = true;
            continue;
        }
        if !literal_target && starts_with_dash(argument) {
            return Err(OpenIntentParseError::UnexpectedOption);
        }
        if target.replace(argument.to_os_string()).is_some() {
            return Err(OpenIntentParseError::MultipleTargets);
        }
    }

    let target = target.ok_or(OpenIntentParseError::MissingTarget)?;
    if target.is_empty() {
        return Err(OpenIntentParseError::EmptyTarget);
    }
    let target = PathBuf::from(target);
    let candidate = if target.is_absolute() {
        target
    } else {
        forwarded_cwd.join(target)
    };
    Ok(normalize_lexically(&candidate))
}

fn starts_with_dash(value: &OsStr) -> bool {
    value.to_string_lossy().starts_with('-')
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(segment) => normalized.push(segment),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        path::{Path, PathBuf},
        sync::Arc,
        thread,
    };

    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn work_root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\work")
        } else {
            PathBuf::from("/work")
        }
    }

    #[test]
    fn parser_discards_program_name_and_resolves_one_relative_target() {
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "notes/../draft.md"]), &work_root()),
            Ok(work_root().join("draft.md"))
        );
    }

    #[test]
    fn parser_requires_double_dash_for_dash_prefixed_filename() {
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "-draft.md"]), &work_root()),
            Err(OpenIntentParseError::UnexpectedOption)
        );
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "--", "-draft.md"]), &work_root()),
            Ok(work_root().join("-draft.md"))
        );
    }

    #[test]
    fn opaque_ids_round_trip_only_through_the_strict_wire_format() {
        let id = OpenIntentId(42);
        assert_eq!(id.to_wire(), "open-intent-42");
        assert_eq!(OpenIntentId::from_wire("open-intent-42"), Some(id));
        assert_eq!(OpenIntentId::from_wire("42"), None);
        assert_eq!(OpenIntentId::from_wire("open-intent-0"), None);
    }

    #[test]
    fn parser_rejects_missing_multiple_and_option_arguments() {
        assert_eq!(
            parse_open_intent_args(args(&["mmd"]), &work_root()),
            Err(OpenIntentParseError::MissingTarget)
        );
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "a.md", "b.md"]), &work_root()),
            Err(OpenIntentParseError::MultipleTargets)
        );
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "--help"]), &work_root()),
            Err(OpenIntentParseError::UnexpectedOption)
        );
        assert_eq!(
            parse_open_intent_args(args(&["mmd", "draft.md"]), Path::new("relative")),
            Err(OpenIntentParseError::InvalidWorkingDirectory)
        );
        assert_eq!(
            parse_open_intent_args(args(&["mmd", ""]), &work_root()),
            Err(OpenIntentParseError::EmptyTarget)
        );
    }

    #[test]
    fn queue_is_fifo_and_only_consumes_the_matching_head() {
        let coordinator = OpenIntentCoordinator::new(2);
        let first = coordinator
            .enqueue_args(
                args(&["mmd", "one.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap()
            .head();
        let second = coordinator
            .enqueue_args(
                args(&["mmd", "two.md"]),
                &work_root(),
                OpenIntentSource::SecondaryInstance,
            )
            .unwrap()
            .head();

        assert_eq!(coordinator.peek_head(), Some(first));
        let preview = coordinator.peek_preview().unwrap();
        assert_eq!(preview.id(), first.id());
        assert_eq!(preview.source(), OpenIntentSource::StartupArguments);
        assert_eq!(
            preview.target(),
            &OpenIntentPreviewTarget::CandidatePath(work_root().join("one.md"))
        );
        assert_eq!(first.source(), OpenIntentSource::StartupArguments);
        assert!(!coordinator.discard_matching_head(second.id()));
        let consumed = coordinator.consume_matching_head(first.id()).unwrap();
        assert_eq!(consumed.id(), first.id());
        assert_eq!(consumed.source(), OpenIntentSource::StartupArguments);
        assert!(matches!(
            consumed.target(),
            ConsumedOpenIntentTarget::CandidatePath(path) if path == &work_root().join("one.md")
        ));
        assert_eq!(coordinator.peek_head(), Some(second));
    }

    #[test]
    fn opaque_session_restore_waits_behind_startup_arguments_without_a_path_payload() {
        let coordinator = OpenIntentCoordinator::new(2);
        let startup = coordinator
            .enqueue_args(
                args(&["mmd", "startup.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap()
            .head();
        let restore = coordinator.enqueue_session_restore().unwrap().head();

        assert_eq!(coordinator.peek_head(), Some(startup));
        let startup = coordinator.consume_matching_head(startup.id()).unwrap();
        assert!(matches!(
            startup.target(),
            ConsumedOpenIntentTarget::CandidatePath(path) if path == &work_root().join("startup.md")
        ));
        assert_eq!(coordinator.peek_head(), Some(restore));
        let preview = coordinator.peek_preview().unwrap();
        assert_eq!(preview.source(), OpenIntentSource::SessionRestore);
        assert_eq!(preview.target(), &OpenIntentPreviewTarget::SessionRestore);
        let restore = coordinator.consume_matching_head(restore.id()).unwrap();
        assert!(matches!(
            restore.target(),
            ConsumedOpenIntentTarget::SessionRestore
        ));
    }

    #[test]
    fn session_restore_coalesces_without_displacing_other_pending_requests() {
        let coordinator = OpenIntentCoordinator::new(3);
        let startup = coordinator
            .enqueue_args(
                args(&["mmd", "startup.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap()
            .head();
        let restore = coordinator.enqueue_session_restore().unwrap().head();

        assert_eq!(
            coordinator.enqueue_session_restore(),
            Ok(OpenIntentEnqueueOutcome::Coalesced(restore))
        );
        assert_eq!(coordinator.peek_head(), Some(startup));
    }

    #[test]
    fn opened_file_urls_enqueue_only_absolute_candidates() {
        let coordinator = OpenIntentCoordinator::new(2);
        let preview = coordinator
            .enqueue_path(work_root().join("opened.md"), OpenIntentSource::OpenedEvent)
            .unwrap()
            .head();
        assert_eq!(coordinator.peek_head(), Some(preview));
        assert_eq!(
            coordinator.enqueue_path(PathBuf::from("relative.md"), OpenIntentSource::OpenedEvent,),
            Err(OpenIntentEnqueueError::InvalidCandidatePath)
        );
    }

    #[test]
    fn pending_duplicate_targets_coalesce_across_delivery_sources() {
        let coordinator = OpenIntentCoordinator::new(3);
        let first = coordinator
            .enqueue_args(
                args(&["mmd", "same.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap()
            .head();
        let duplicate = coordinator
            .enqueue_args(
                args(&["mmd", "./same.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap();
        assert_eq!(duplicate, OpenIntentEnqueueOutcome::Coalesced(first));

        let other_source = coordinator
            .enqueue_args(
                args(&["mmd", "same.md"]),
                &work_root(),
                OpenIntentSource::SecondaryInstance,
            )
            .unwrap();
        assert_eq!(other_source, OpenIntentEnqueueOutcome::Coalesced(first));
    }

    #[test]
    fn queue_is_bounded_without_evicting_pending_intents() {
        let coordinator = OpenIntentCoordinator::new(1);
        let first = coordinator
            .enqueue_args(
                args(&["mmd", "one.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments,
            )
            .unwrap()
            .head();
        assert_eq!(
            coordinator.enqueue_args(
                args(&["mmd", "two.md"]),
                &work_root(),
                OpenIntentSource::StartupArguments
            ),
            Err(OpenIntentEnqueueError::QueueFull)
        );
        assert_eq!(coordinator.peek_head(), Some(first));
    }

    #[test]
    fn concurrent_enqueue_keeps_every_distinct_intent() {
        let coordinator = Arc::new(OpenIntentCoordinator::new(16));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let coordinator = Arc::clone(&coordinator);
                thread::spawn(move || {
                    coordinator.enqueue_args(
                        vec![OsString::from("mmd"), OsString::from(format!("{index}.md"))],
                        &work_root(),
                        OpenIntentSource::SecondaryInstance,
                    )
                })
            })
            .collect();

        for worker in workers {
            assert!(matches!(
                worker.join().unwrap(),
                Ok(OpenIntentEnqueueOutcome::Enqueued(_))
            ));
        }
        let mut consumed = 0;
        while let Some(head) = coordinator.peek_head() {
            assert!(coordinator.consume_matching_head(head.id()).is_some());
            consumed += 1;
        }
        assert_eq!(consumed, 8);
    }
}
