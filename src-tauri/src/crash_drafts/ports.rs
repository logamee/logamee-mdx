//! Draft write port and clock contracts.
use super::*;

pub(crate) trait DraftClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ExpectedDraftState<V> {
    Absent,
    Exact(V),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftObservation<V> {
    Missing,
    Present {
        bytes: Vec<u8>,
        size: u64,
        version: V,
        version_token: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftWriteOutcome<V> {
    ConfirmedCommitted {
        version: V,
        version_token: String,
        recovery_paths: Vec<PathBuf>,
    },
    ConfirmedNotCommitted {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DraftDeleteOutcome<V> {
    ConfirmedDeleted,
    ConfirmedNotDeleted {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<V>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}

pub(crate) trait DraftWritePort: Send + Sync {
    type Version: Clone + Debug + Eq + Send + Sync;

    /// Returns at most `max_bytes + 1` bytes while capturing the exact file version.
    fn observe(
        &self,
        path: &Path,
        max_bytes: usize,
    ) -> Result<DraftObservation<Self::Version>, String>;

    /// Adapter errors after mutation begins must be represented by a four-state outcome.
    fn persist(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: ExpectedDraftState<Self::Version>,
    ) -> DraftWriteOutcome<Self::Version>;

    /// Deletes only the exact observed version; path-only deletion is forbidden.
    fn remove_exact(
        &self,
        destination: &Path,
        expected: &Self::Version,
    ) -> DraftDeleteOutcome<Self::Version>;
}

