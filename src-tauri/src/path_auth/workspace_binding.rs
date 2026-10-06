//! Workspace root binding and grant-currency predicates.
use super::*;

#[derive(Default)]
pub(crate) struct AuthorizationState {
    pub(crate) workspaces: HashMap<WorkspaceToken, WorkspaceGrant>,
    pub(crate) workspace_document_origins: HashMap<DocumentGrantId, WorkspaceToken>,
    pub(crate) document_origin_identities: HashMap<DocumentGrantId, String>,
    pub(crate) grants: HashMap<GrantKey, GrantLedger>,
    pub(crate) pending_save_authorities: HashMap<DocumentGrantId, PendingSaveReservation>,
    pub(crate) pending_workspace_authorities: HashMap<WorkspaceToken, PendingWorkspaceReservation>,
    pub(crate) next_workspace_token_id: u64,
    pub(crate) next_document_grant_id: u64,
    pub(crate) next_preview_lease_id: u64,
    pub(crate) next_grant_sequence: u64,
    pub(crate) authorization_generation: u64,
}

pub(crate) struct WorkspaceCandidate {
    pub(crate) root: PathBuf,
    pub(crate) root_binding: WorkspaceRootBinding,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WorkspaceToken(pub(crate) u64);

pub(crate) struct WorkspaceGrant {
    pub(crate) root: PathBuf,
    pub(crate) root_identity: String,
}

#[derive(Clone)]
pub(crate) struct AuthorizedWorkspace {
    pub(crate) token: WorkspaceToken,
    pub(crate) root: PathBuf,
    pub(crate) root_binding: WorkspaceRootBinding,
}

pub(crate) struct AuthorizedReadFile {
    pub(crate) path: PathBuf,
    pub(crate) file: fs::File,
    pub(crate) workspace_authorization: Option<WorkspaceReadAuthorization>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceReadAuthorization {
    pub(crate) path: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) relative: PathBuf,
    pub(crate) token: WorkspaceToken,
    pub(crate) root_binding: WorkspaceRootBinding,
    pub(crate) file_binding: Arc<fs::File>,
    pub(crate) file_identity: String,
}

#[derive(Clone)]
pub(crate) struct WorkspaceRootBinding {
    pub(crate) identity: String,
    pub(crate) handle: Arc<fs::File>,
}

impl WorkspaceRootBinding {
    pub(crate) fn capture(root: &Path) -> Result<Self, String> {
        let handle = Arc::new(
            open_directory_without_following_links(root)
                .map_err(|error| format!("Could not bind the workspace root: {error}"))?,
        );
        let identity = opened_file_platform_identity(&handle)
            .map_err(|error| format!("Could not identify the workspace root: {error}"))?;
        Ok(Self { identity, handle })
    }

    pub(crate) fn is_current(&self, root: &Path) -> bool {
        open_directory_without_following_links(root)
            .and_then(|handle| opened_file_platform_identity(&handle))
            .is_ok_and(|identity| identity == self.identity)
    }

    pub(crate) fn same_object(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    pub(crate) fn open_regular_file(&self, relative: &Path) -> std::io::Result<fs::File> {
        open_regular_file_beneath_directory(&self.handle, relative)
    }
}
