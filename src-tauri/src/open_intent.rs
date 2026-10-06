use std::path::PathBuf;

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
    #[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
    pub(crate) fn id(self) -> OpenIntentId {
        self.id
    }

    #[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
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
    #[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
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
    #[allow(dead_code)] // 构造后无读取方；字段保留打开意图的完整语义
    id: OpenIntentId,
    #[allow(dead_code)] // 同上
    source: OpenIntentSource,
    target: ConsumedOpenIntentTarget,
}

#[derive(Debug)]
pub(crate) enum ConsumedOpenIntentTarget {
    CandidatePath(PathBuf),
    SessionRestore,
}

impl ConsumedOpenIntent {
    #[cfg(test)]
    pub(crate) fn id(&self) -> OpenIntentId {
        self.id
    }

    #[cfg(test)]
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

mod coordinator;

pub(crate) use coordinator::OpenIntentCoordinator;

#[cfg(test)]
mod cli_tests;
#[cfg(test)]
mod tests;

mod cli;

#[cfg(test)]
pub(crate) use cli::parse_open_intent_args;
