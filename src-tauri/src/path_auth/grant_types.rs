//! Grant keys, ledger and reservation types.
use super::*;

pub(crate) enum WorkspaceSnapshotSource<'a> {
    Candidate(&'a WorkspaceCandidate),
    Authorized(&'a AuthorizedWorkspace),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct DocumentGrantId(pub(crate) u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct PreviewLeaseId {
    pub(crate) generation: u64,
    pub(crate) document: PathBuf,
    pub(crate) authority_anchor: Option<PathBuf>,
}

impl PreviewLeaseId {
    #[cfg(test)]
    pub(crate) fn references_path(&self, path: &Path) -> bool {
        self.document == path || self.authority_anchor.as_deref() == Some(path)
    }

    pub(crate) fn intersects_prefix(&self, prefix: &Path) -> bool {
        path_is_under(&self.document, prefix)
            || self
                .authority_anchor
                .as_deref()
                .is_some_and(|anchor| path_is_under(anchor, prefix))
    }
}

pub(crate) enum PreviewRetirementError {
    AuthorizationUnavailable(String),
    #[cfg(test)]
    Recoverable(String),
}

impl PreviewRetirementError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::AuthorizationUnavailable(message) => message,
            #[cfg(test)]
            Self::Recoverable(message) => message,
        }
    }
}

pub(crate) struct AuthorizedFile {
    pub(crate) path: PathBuf,
    #[cfg(test)]
    pub(crate) origin: GrantOrigin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingSaveAuthority {
    pub(crate) path: PathBuf,
    pub(crate) id: DocumentGrantId,
    pub(crate) generation: u64,
}

pub(crate) struct SaveAuthorizationScope<'a> {
    pub(crate) state: &'a mut AuthorizationState,
    pub(crate) path: PathBuf,
}

pub(crate) struct SaveIdentityOrigins {
    pub(crate) document_ids: Vec<DocumentGrantId>,
    pub(crate) settlement_generation: Option<u64>,
}
