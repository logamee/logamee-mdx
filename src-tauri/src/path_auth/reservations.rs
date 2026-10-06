//! Pending save/workspace reservations and prepared types.
use super::*;

pub(crate) struct PendingSaveReservation {
    pub(crate) path: PathBuf,
    pub(crate) mutations: Vec<PreparedGrantMutation>,
}

pub(crate) struct PendingWorkspaceReservation {
    pub(crate) owner_window: String,
    pub(crate) candidate: WorkspaceCandidate,
    pub(crate) expires_at: Instant,
}
