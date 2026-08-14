use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use crate::{
    commands::{
        open_directory_without_following_links, open_regular_file_beneath_directory,
        open_regular_file_without_following_links, opened_file_platform_identity,
    },
    state::AppState,
};

const MAX_PENDING_SAVE_AUTHORITIES: usize = 1;
const MAX_PENDING_WORKSPACE_AUTHORITIES: usize = 32;
const PENDING_WORKSPACE_AUTHORITY_TTL: Duration = Duration::from_secs(5 * 60);

#[path = "workspace_snapshot.rs"]
pub(crate) mod workspace_snapshot;

#[cfg(test)]
use std::ops::{Deref, DerefMut};

#[derive(Default)]
pub(crate) struct FileAuthorizationSession {
    inner: Mutex<AuthorizationState>,
    #[cfg(test)]
    next_save_publish_error: Mutex<Option<String>>,
    #[cfg(test)]
    next_preview_retirement_error: Mutex<Option<String>>,
    #[cfg(test)]
    next_preview_retirement_unavailable_error: Mutex<Option<String>>,
}

#[cfg(test)]
struct AuthorizationGuard<'a> {
    inner: Option<MutexGuard<'a, AuthorizationState>>,
}

#[cfg(not(test))]
type AuthorizationGuard<'a> = MutexGuard<'a, AuthorizationState>;

#[cfg(test)]
impl<'a> AuthorizationGuard<'a> {
    fn new(inner: MutexGuard<'a, AuthorizationState>) -> Self {
        lock_order_test_probe::authorization_acquired();
        Self { inner: Some(inner) }
    }
}

#[cfg(test)]
impl Deref for AuthorizationGuard<'_> {
    type Target = AuthorizationState;

    fn deref(&self) -> &Self::Target {
        self.inner
            .as_deref()
            .expect("authorization guard is active")
    }
}

#[cfg(test)]
impl DerefMut for AuthorizationGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_deref_mut()
            .expect("authorization guard is active")
    }
}

#[cfg(test)]
impl Drop for AuthorizationGuard<'_> {
    fn drop(&mut self) {
        self.inner.take();
        lock_order_test_probe::authorization_released();
    }
}

#[cfg(test)]
pub(crate) mod lock_order_test_probe {
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum LockEvent {
        RecentRuntimeAcquired,
        RecentRuntimeReleased,
        RecentFs2Acquired,
        RecentFs2Released,
        AuthorizationAcquired,
        AuthorizationReleased,
        HtmlSitesAcquired,
        HtmlSitesReleased,
    }

    #[derive(Default)]
    struct TraceState {
        events: Vec<LockEvent>,
        recent_runtime_depth: usize,
        recent_fs2_depth: usize,
        authorization_depth: usize,
        html_sites_depth: usize,
        violation: Option<&'static str>,
    }

    thread_local! {
        static TRACE: RefCell<Option<TraceState>> = const { RefCell::new(None) };
    }

    pub(crate) fn trace<T>(operation: impl FnOnce() -> T) -> (T, Vec<LockEvent>) {
        TRACE.with(|trace| {
            assert!(
                trace.borrow().is_none(),
                "lock-order traces cannot be nested"
            );
            *trace.borrow_mut() = Some(TraceState::default());
        });
        let result = operation();
        let state = TRACE.with(|trace| {
            trace
                .borrow_mut()
                .take()
                .expect("lock-order trace is active")
        });
        assert_eq!(state.authorization_depth, 0);
        assert_eq!(state.html_sites_depth, 0);
        assert_eq!(state.recent_runtime_depth, 0);
        assert_eq!(state.recent_fs2_depth, 0);
        assert!(
            state.violation.is_none(),
            "{}",
            state.violation.unwrap_or("")
        );
        (result, state.events)
    }

    pub(crate) fn authorization_acquired() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.html_sites_depth > 0 {
                state.violation = Some("authorization acquired while HTML sites guard was held");
            }
            if state.recent_runtime_depth > 0 && state.recent_fs2_depth == 0 {
                state.violation = Some("authorization acquired before fs2 while MRU was held");
            }
            state.authorization_depth += 1;
            state.events.push(LockEvent::AuthorizationAcquired);
        });
    }

    pub(crate) fn authorization_released() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            state.authorization_depth -= 1;
            state.events.push(LockEvent::AuthorizationReleased);
        });
    }

    pub(crate) fn html_sites_acquired() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.authorization_depth > 0 {
                state.violation = Some("HTML sites guard acquired while authorization was held");
            }
            if state.recent_runtime_depth > 0 {
                state.violation = Some("HTML sites guard acquired while MRU was held");
            }
            state.html_sites_depth += 1;
            state.events.push(LockEvent::HtmlSitesAcquired);
        });
    }

    pub(crate) fn html_sites_released() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            state.html_sites_depth -= 1;
            state.events.push(LockEvent::HtmlSitesReleased);
        });
    }

    pub(crate) fn recent_runtime_acquired() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.authorization_depth > 0
                || state.html_sites_depth > 0
                || state.recent_fs2_depth > 0
            {
                state.violation = Some("MRU acquired while a later-order lock was held");
            }
            state.recent_runtime_depth += 1;
            state.events.push(LockEvent::RecentRuntimeAcquired);
        });
    }

    pub(crate) fn recent_runtime_released() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.recent_fs2_depth > 0 || state.authorization_depth > 0 {
                state.violation = Some("MRU released before later-order locks");
            }
            state.recent_runtime_depth -= 1;
            state.events.push(LockEvent::RecentRuntimeReleased);
        });
    }

    pub(crate) fn recent_fs2_acquired() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.recent_runtime_depth == 0
                || state.authorization_depth > 0
                || state.html_sites_depth > 0
            {
                state.violation = Some("fs2 acquired outside the MRU lock order");
            }
            state.recent_fs2_depth += 1;
            state.events.push(LockEvent::RecentFs2Acquired);
        });
    }

    pub(crate) fn recent_fs2_released() {
        TRACE.with(|trace| {
            let mut trace = trace.borrow_mut();
            let Some(state) = trace.as_mut() else {
                return;
            };
            if state.authorization_depth > 0 {
                state.violation = Some("fs2 released before authorization");
            }
            state.recent_fs2_depth -= 1;
            state.events.push(LockEvent::RecentFs2Released);
        });
    }

    pub(crate) fn assert_no_locks_held() {
        TRACE.with(|trace| {
            let trace = trace.borrow();
            let state = trace.as_ref().expect("lock-order trace is active");
            assert_eq!(state.authorization_depth, 0);
            assert_eq!(state.html_sites_depth, 0);
            assert_eq!(state.recent_runtime_depth, 0);
            assert_eq!(state.recent_fs2_depth, 0);
        });
    }

    pub(crate) fn assert_authorization_held_without_html_sites() {
        TRACE.with(|trace| {
            let trace = trace.borrow();
            let state = trace.as_ref().expect("lock-order trace is active");
            assert_eq!(state.authorization_depth, 1);
            assert_eq!(state.html_sites_depth, 0);
        });
    }
}

#[derive(Default)]
struct AuthorizationState {
    workspaces: HashMap<WorkspaceToken, WorkspaceGrant>,
    workspace_document_origins: HashMap<DocumentGrantId, WorkspaceToken>,
    document_origin_identities: HashMap<DocumentGrantId, String>,
    grants: HashMap<GrantKey, GrantLedger>,
    pending_save_authorities: HashMap<DocumentGrantId, PendingSaveReservation>,
    pending_workspace_authorities: HashMap<WorkspaceToken, PendingWorkspaceReservation>,
    next_workspace_token_id: u64,
    next_document_grant_id: u64,
    next_preview_lease_id: u64,
    next_grant_sequence: u64,
    authorization_generation: u64,
}

pub(crate) struct WorkspaceCandidate {
    root: PathBuf,
    root_binding: WorkspaceRootBinding,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WorkspaceToken(u64);

struct WorkspaceGrant {
    root: PathBuf,
    root_identity: String,
}

#[derive(Clone)]
pub(crate) struct AuthorizedWorkspace {
    token: WorkspaceToken,
    root: PathBuf,
    root_binding: WorkspaceRootBinding,
}

pub(crate) struct AuthorizedReadFile {
    path: PathBuf,
    file: fs::File,
    workspace_authorization: Option<WorkspaceReadAuthorization>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceReadAuthorization {
    path: PathBuf,
    root: PathBuf,
    relative: PathBuf,
    token: WorkspaceToken,
    root_binding: WorkspaceRootBinding,
    file_binding: Arc<fs::File>,
    file_identity: String,
}

#[derive(Clone)]
struct WorkspaceRootBinding {
    identity: String,
    handle: Arc<fs::File>,
}

impl WorkspaceRootBinding {
    fn capture(root: &Path) -> Result<Self, String> {
        let handle = Arc::new(
            open_directory_without_following_links(root)
                .map_err(|error| format!("Could not bind the workspace root: {error}"))?,
        );
        let identity = opened_file_platform_identity(&handle)
            .map_err(|error| format!("Could not identify the workspace root: {error}"))?;
        Ok(Self { identity, handle })
    }

    fn is_current(&self, root: &Path) -> bool {
        open_directory_without_following_links(root)
            .and_then(|handle| opened_file_platform_identity(&handle))
            .is_ok_and(|identity| identity == self.identity)
    }

    fn same_object(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    fn open_regular_file(&self, relative: &Path) -> std::io::Result<fs::File> {
        open_regular_file_beneath_directory(&self.handle, relative)
    }
}

fn capture_current_workspace_binding(
    workspace: &WorkspaceGrant,
    root: &Path,
) -> Option<WorkspaceRootBinding> {
    if workspace.root != root {
        return None;
    }
    let binding = WorkspaceRootBinding::capture(root).ok()?;
    (binding.identity == workspace.root_identity).then_some(binding)
}

fn directory_read_grant_is_current(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> bool {
    ledger.origins.keys().any(|origin| {
        let GrantOrigin::Workspace(token) = origin else {
            return false;
        };
        state
            .workspaces
            .get(token)
            .is_some_and(|workspace| capture_current_workspace_binding(workspace, root).is_some())
    })
}

fn current_workspace_binding_for_directory_grant(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> Option<(WorkspaceToken, WorkspaceRootBinding)> {
    ledger.origins.keys().find_map(|origin| {
        let GrantOrigin::Workspace(token) = origin else {
            return None;
        };
        state.workspaces.get(token).and_then(|workspace| {
            capture_current_workspace_binding(workspace, root).map(|binding| (*token, binding))
        })
    })
}

#[cfg(test)]
fn current_workspace_token_for_path(
    state: &AuthorizationState,
    path: &Path,
) -> Option<WorkspaceToken> {
    state
        .grants
        .iter()
        .filter_map(|(key, ledger)| {
            let GrantKey::DirectoryRead(root) = key else {
                return None;
            };
            if !ledger.is_active() || !path_is_under(path, root) {
                return None;
            }
            current_workspace_binding_for_directory_grant(state, root, ledger)
                .map(|(token, _)| (root.components().count(), token))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, token)| token)
}

fn internal_asset_grant_is_current(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> bool {
    ledger.origins.keys().any(|origin| match origin {
        GrantOrigin::Preview(lease) => state.preview_lease_is_active_and_supported(lease),
        _ => grant_origin_is_current_for_path(state, root, origin),
    })
}

fn workspace_origin_is_current(
    state: &AuthorizationState,
    token: &WorkspaceToken,
    path: &Path,
) -> bool {
    state.workspaces.get(token).is_some_and(|workspace| {
        path_is_under(path, &workspace.root)
            && capture_current_workspace_binding(workspace, &workspace.root).is_some()
    })
}

fn grant_origin_is_current_for_path(
    state: &AuthorizationState,
    path: &Path,
    origin: &GrantOrigin,
) -> bool {
    match origin {
        GrantOrigin::Workspace(token) => workspace_origin_is_current(state, token, path),
        GrantOrigin::OpenDocument(id) => state
            .workspace_document_origins
            .get(id)
            .is_none_or(|token| workspace_origin_is_current(state, token, path)),
        GrantOrigin::SaveAs(_) | GrantOrigin::CreatedDocument(_) => true,
        GrantOrigin::Preview(_) => false,
    }
}

fn current_file_identity_for_origin(
    state: &AuthorizationState,
    path: &Path,
    workspace_token: Option<&WorkspaceToken>,
) -> Option<String> {
    let file = if let Some(token) = workspace_token {
        let workspace = state.workspaces.get(token)?;
        let binding = capture_current_workspace_binding(workspace, &workspace.root)?;
        let relative = path.strip_prefix(&workspace.root).ok()?;
        binding.open_regular_file(relative).ok()?
    } else {
        open_regular_file_without_following_links(path).ok()?
    };
    opened_file_platform_identity(&file).ok()
}

fn exact_origin_is_current_for_path(
    state: &AuthorizationState,
    path: &Path,
    origin: &GrantOrigin,
) -> bool {
    if !grant_origin_is_current_for_path(state, path, origin) {
        return false;
    }
    let GrantOrigin::OpenDocument(id) = origin else {
        return true;
    };
    state
        .document_origin_identities
        .get(id)
        .is_none_or(|expected| {
            current_file_identity_for_origin(state, path, state.workspace_document_origins.get(id))
                .is_some_and(|current| current == *expected)
        })
}

enum ExactReadAuthority {
    Path,
    Identity(String),
}

fn exact_read_authority(
    state: &AuthorizationState,
    path: &Path,
    ledger: &GrantLedger,
) -> Option<ExactReadAuthority> {
    if !ledger.is_active() {
        return None;
    }
    let mut expected_identity = None;
    for origin in ledger.origins.keys() {
        if !exact_origin_is_current_for_path(state, path, origin) {
            continue;
        }
        match origin {
            GrantOrigin::OpenDocument(id) => {
                if let Some(identity) = state.document_origin_identities.get(id) {
                    expected_identity.get_or_insert_with(|| identity.clone());
                } else {
                    return Some(ExactReadAuthority::Path);
                }
            }
            GrantOrigin::SaveAs(_) | GrantOrigin::CreatedDocument(_) => {
                return Some(ExactReadAuthority::Path);
            }
            GrantOrigin::Workspace(_) | GrantOrigin::Preview(_) => {}
        }
    }
    expected_identity.map(ExactReadAuthority::Identity)
}

fn exact_grant_is_current(state: &AuthorizationState, path: &Path, ledger: &GrantLedger) -> bool {
    exact_read_authority(state, path, ledger).is_some()
}

fn active_authority_origins_for_path(
    state: &AuthorizationState,
    path: &Path,
) -> HashSet<GrantOrigin> {
    let mut origins = HashSet::new();
    for (key, ledger) in &state.grants {
        if !ledger.is_active() {
            continue;
        }
        match key {
            GrantKey::ExactReadWrite(granted_path) if granted_path == path => {
                origins.extend(
                    ledger
                        .origins
                        .keys()
                        .filter(|origin| exact_origin_is_current_for_path(state, path, origin))
                        .cloned(),
                );
            }
            GrantKey::DirectoryRead(root)
                if path_is_under(path, root)
                    && directory_read_grant_is_current(state, root, ledger) =>
            {
                origins.extend(
                    ledger
                        .origins
                        .keys()
                        .filter(|origin| grant_origin_is_current_for_path(state, path, origin))
                        .cloned(),
                );
            }
            _ => {}
        }
    }
    origins
}

fn ledger_shares_current_origin(
    state: &AuthorizationState,
    path: &Path,
    ledger: &GrantLedger,
    origins: &HashSet<GrantOrigin>,
) -> bool {
    ledger.origins.keys().any(|origin| {
        origins.contains(origin) && grant_origin_is_current_for_path(state, path, origin)
    })
}

fn workspace_read_authorization_is_current(
    state: &AuthorizationState,
    authorization: &WorkspaceReadAuthorization,
) -> bool {
    if !opened_file_platform_identity(&authorization.file_binding)
        .is_ok_and(|identity| identity == authorization.file_identity)
    {
        return false;
    }
    let workspace_is_current =
        state
            .workspaces
            .get(&authorization.token)
            .is_some_and(|workspace| {
                workspace.root == authorization.root
                    && workspace.root_identity == authorization.root_binding.identity
                    && authorization.root_binding.is_current(&authorization.root)
            });
    let relative_matches = authorization
        .path
        .strip_prefix(&authorization.root)
        .is_ok_and(|relative| relative == authorization.relative);
    if !workspace_is_current || !relative_matches {
        return false;
    }
    authorization
        .root_binding
        .open_regular_file(&authorization.relative)
        .and_then(|file| opened_file_platform_identity(&file))
        .is_ok_and(|identity| identity == authorization.file_identity)
}

pub(crate) struct RenamedWorkspaceEntry {
    workspace: AuthorizedWorkspace,
    old_path: PathBuf,
    new_path: PathBuf,
    is_file: bool,
}

pub(crate) struct DeletedWorkspaceEntry {
    workspace: AuthorizedWorkspace,
    deleted_path: PathBuf,
    #[cfg(test)]
    is_file: bool,
}

pub(crate) enum AuthorizedRenameOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed(RenamedWorkspaceEntry),
    RecoveryRequired {
        renamed: RenamedWorkspaceEntry,
        recovery_message: String,
    },
    Indeterminate {
        attempted: RenamedWorkspaceEntry,
        recovery_message: String,
    },
}

pub(crate) enum RenameErrorObservation {
    ConfirmedNotCommitted,
    ConfirmedCommitted,
    Indeterminate { message: String },
}

enum RenameWorkspaceEntryAuthorizationOutcome {
    Committed {
        renamed: RenamedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
    },
    AwaitingObservation {
        attempted: RenamedWorkspaceEntry,
        transitioned_grants: HashSet<GrantKey>,
        operation_error: String,
    },
    ConfirmedNotCommitted {
        message: String,
    },
    Indeterminate {
        attempted: RenamedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
        operation_error: String,
        observation_message: String,
    },
}

pub(crate) enum AuthorizedDeleteOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed(DeletedWorkspaceEntry),
    RecoveryRequired {
        deleted: DeletedWorkspaceEntry,
        recovery_message: String,
    },
    Indeterminate {
        attempted: DeletedWorkspaceEntry,
        recovery_message: String,
    },
}

#[cfg(test)]
pub(crate) enum DeleteFileObservation {
    Present,
    Missing,
}

pub(crate) enum TrashAuthorizationDisposition {
    ConfirmedCommitted,
    ConfirmedNotCommitted { message: String },
    Indeterminate { message: String },
}

enum DeleteWorkspaceEntryAuthorizationOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed {
        deleted: DeletedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
    },
    Indeterminate {
        attempted: DeletedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
        operation_error: String,
    },
}

pub(crate) enum AuthorizedWriteOutcome {
    Committed(PathBuf),
    Indeterminate {
        path: PathBuf,
        recovery_message: String,
    },
}

#[derive(Clone, Copy)]
pub(crate) enum WorkspaceSnapshotSource<'a> {
    Candidate(&'a WorkspaceCandidate),
    Authorized(&'a AuthorizedWorkspace),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct DocumentGrantId(u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct PreviewLeaseId {
    generation: u64,
    document: PathBuf,
    authority_anchor: Option<PathBuf>,
}

impl PreviewLeaseId {
    fn references_path(&self, path: &Path) -> bool {
        self.document == path || self.authority_anchor.as_deref() == Some(path)
    }

    fn intersects_prefix(&self, prefix: &Path) -> bool {
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
    path: PathBuf,
    #[cfg(test)]
    origin: GrantOrigin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingSaveAuthority {
    path: PathBuf,
    id: DocumentGrantId,
    generation: u64,
}

pub(crate) struct SaveAuthorizationScope<'a> {
    state: &'a mut AuthorizationState,
    path: PathBuf,
}

pub(crate) struct SaveIdentityOrigins {
    document_ids: Vec<DocumentGrantId>,
    settlement_generation: Option<u64>,
}

impl SaveAuthorizationScope<'_> {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state.authorization_generation
    }

    pub(crate) fn has_exact_write_authority(&self) -> bool {
        self.state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &self.path && exact_grant_is_current(self.state, file, ledger))
        })
    }

    pub(crate) fn matches_pending(&self, pending: &PendingSaveAuthority) -> bool {
        pending.path == self.path
            && pending.generation == self.state.authorization_generation
            && self
                .state
                .pending_save_authorities
                .get(&pending.id)
                .is_some_and(|reservation| reservation.path == self.path)
    }

    pub(crate) fn capture_identity_origins(&self) -> Result<SaveIdentityOrigins, String> {
        let document_ids = self
            .state
            .grants
            .get(&GrantKey::ExactReadWrite(self.path.clone()))
            .into_iter()
            .filter(|ledger| ledger.is_active())
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::OpenDocument(id)
                    if self.state.document_origin_identities.contains_key(id)
                        && exact_origin_is_current_for_path(self.state, &self.path, origin) =>
                {
                    Some(*id)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let settlement_generation = if document_ids.is_empty() {
            None
        } else {
            Some(self.state.next_authorization_generation()?)
        };
        Ok(SaveIdentityOrigins {
            document_ids,
            settlement_generation,
        })
    }

    pub(crate) fn settle_identity_origins(
        &mut self,
        origins: &SaveIdentityOrigins,
        platform_identity: &str,
    ) {
        let changes = origins.document_ids.iter().any(|id| {
            self.state
                .document_origin_identities
                .get(id)
                .is_some_and(|identity| identity != platform_identity)
        });
        if !changes {
            return;
        }
        self.state.authorization_generation = origins
            .settlement_generation
            .expect("identity-bound save origins reserve their settlement generation");
        for id in &origins.document_ids {
            if let Some(identity) = self.state.document_origin_identities.get_mut(id) {
                *identity = platform_identity.to_string();
            }
        }
    }

    pub(crate) fn publish_pending(&mut self, pending: &PendingSaveAuthority) {
        debug_assert!(self.matches_pending(pending));
        let reservation = self
            .state
            .pending_save_authorities
            .remove(&pending.id)
            .expect("pending save reservation was checked while authorization was held");
        self.state.authorization_generation += 1;
        for mutation in reservation.mutations {
            match mutation {
                PreparedGrantMutation::Existing { key, origin } => {
                    let ledger = self
                        .state
                        .grants
                        .get_mut(&key)
                        .expect("pending save grant retains its reserved ledger");
                    ledger.origins.insert(origin, 1);
                    ledger.status = GrantStatus::Active;
                }
                PreparedGrantMutation::New { key, ledger } => {
                    let replaced = self.state.grants.insert(key, ledger);
                    debug_assert!(replaced.is_none());
                }
            }
        }
    }

    pub(crate) fn invalidate_pending(&mut self, pending: &PendingSaveAuthority) {
        if self
            .state
            .pending_save_authorities
            .remove(&pending.id)
            .is_some()
            && pending.generation == self.state.authorization_generation
        {
            self.state.authorization_generation += 1;
        }
    }
}

pub(crate) struct AuthorizedPreviewScope {
    document: PathBuf,
    root: PathBuf,
    lease: PreviewLeaseId,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum GrantOrigin {
    Workspace(WorkspaceToken),
    OpenDocument(DocumentGrantId),
    SaveAs(DocumentGrantId),
    CreatedDocument(DocumentGrantId),
    Preview(PreviewLeaseId),
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizationEvidenceGrant {
    pub(crate) kind: &'static str,
    pub(crate) path: String,
    pub(crate) origin: &'static str,
    pub(crate) status: &'static str,
    pub(crate) count: usize,
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizationEvidenceSnapshot {
    pub(crate) generation: u64,
    pub(crate) pending_workspace_receipts: usize,
    pub(crate) grants: Vec<AuthorizationEvidenceGrant>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum GrantKey {
    ExactReadWrite(PathBuf),
    DirectoryRead(PathBuf),
    InternalAsset(PathBuf),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GrantStatus {
    Active,
    Suspended,
}

struct GrantLedger {
    origins: HashMap<GrantOrigin, usize>,
    status: GrantStatus,
    first_granted_sequence: u64,
}

enum PreparedGrantMutation {
    Existing { key: GrantKey, origin: GrantOrigin },
    New { key: GrantKey, ledger: GrantLedger },
}

struct PendingSaveReservation {
    path: PathBuf,
    mutations: Vec<PreparedGrantMutation>,
}

struct PendingWorkspaceReservation {
    owner_window: String,
    candidate: WorkspaceCandidate,
    expires_at: Instant,
}

pub(crate) struct PreparedWorkspaceAuthorization<S> {
    pub(crate) workspace: AuthorizedWorkspace,
    pub(crate) snapshot: S,
    pub(crate) receipt: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreparedWorkspaceSettlement {
    Applied,
    Discarded,
    Expired,
    Unknown,
}

pub(crate) struct PreparedOpenDocumentGrant<'a> {
    state: AuthorizationGuard<'a>,
    mutations: Vec<PreparedGrantMutation>,
    workspace_authorization: Option<WorkspaceReadAuthorization>,
    workspace_document_origin: Option<(DocumentGrantId, WorkspaceToken)>,
    document_origin_identity: Option<(DocumentGrantId, String)>,
    next_document_grant_id: u64,
    next_grant_sequence: u64,
    next_authorization_generation: u64,
}

impl PreparedOpenDocumentGrant<'_> {
    pub(crate) fn apply(mut self) -> Result<(), String> {
        if self
            .workspace_authorization
            .as_ref()
            .is_some_and(|authorization| {
                !workspace_read_authorization_is_current(&self.state, authorization)
            })
        {
            return Err("Workspace file identity changed before open was committed".to_string());
        }
        self.state.next_document_grant_id = self.next_document_grant_id;
        self.state.next_grant_sequence = self.next_grant_sequence;
        self.state.authorization_generation = self.next_authorization_generation;
        for mutation in self.mutations {
            match mutation {
                PreparedGrantMutation::Existing { key, origin } => {
                    let ledger = self
                        .state
                        .grants
                        .get_mut(&key)
                        .expect("prepared grant retains the authorization lock");
                    ledger.origins.insert(origin, 1);
                    ledger.status = GrantStatus::Active;
                }
                PreparedGrantMutation::New { key, ledger } => {
                    let replaced = self.state.grants.insert(key, ledger);
                    debug_assert!(replaced.is_none());
                }
            }
        }
        if let Some((document_id, workspace_token)) = self.workspace_document_origin {
            let replaced = self
                .state
                .workspace_document_origins
                .insert(document_id, workspace_token);
            debug_assert!(replaced.is_none());
        }
        if let Some((document_id, file_identity)) = self.document_origin_identity {
            let replaced = self
                .state
                .document_origin_identities
                .insert(document_id, file_identity);
            debug_assert!(replaced.is_none());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RevokeOriginMode {
    All,
}

pub(crate) fn canonicalize_existing_path(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    fs::canonicalize(path.as_ref())
}

pub(crate) fn normalize_existing_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    canonicalize_existing_path(path).map_err(|err| format!("Cannot access path: {err}"))
}

pub(crate) fn normalize_parent_for_new_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = path.as_ref();
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Parent directory traversal is not allowed".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Path has no file name".to_string())?;
    let parent = normalize_existing_path(parent)?;
    Ok(parent.join(file_name))
}

pub(crate) fn normalize_file_for_write(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = path.as_ref();
    if path.exists() {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Destination is not a file".into());
        }
        Ok(canonical)
    } else {
        normalize_parent_for_new_path(path)
    }
}

pub(crate) fn path_is_under(child: &Path, root: &Path) -> bool {
    child == root || child.starts_with(root)
}

fn reject_symlink_components_below_root(path: &Path, root: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Cannot access workspace entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            let parent = current
                .parent()
                .ok_or_else(|| "Workspace entry path is invalid".to_string())?;
            let canonical_parent = normalize_existing_path(parent)?;
            if path_is_under(&canonical_parent, root) {
                return Err("Symbolic links cannot be modified as workspace entries".into());
            }
        }
    }
    Ok(())
}

impl AuthorizedWorkspace {
    fn new(token: WorkspaceToken, root: PathBuf, root_binding: WorkspaceRootBinding) -> Self {
        Self {
            token,
            root,
            root_binding,
        }
    }

    #[cfg(test)]
    pub(crate) fn token(&self) -> &WorkspaceToken {
        &self.token
    }

    pub(crate) fn wire_token(&self) -> String {
        self.token.to_wire()
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn clone_root_handle(&self) -> std::io::Result<fs::File> {
        self.root_binding.handle.try_clone()
    }

    pub(crate) fn open_regular_file(&self, path: &Path) -> std::io::Result<fs::File> {
        let relative = path.strip_prefix(&self.root).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "file is outside the authorized workspace root",
            )
        })?;
        self.root_binding.open_regular_file(relative)
    }

    #[cfg(test)]
    fn into_root(self) -> PathBuf {
        self.root
    }
}

impl AuthorizedReadFile {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn into_parts(self) -> (PathBuf, fs::File) {
        (self.path, self.file)
    }

    pub(crate) fn workspace_authorization(&self) -> Option<&WorkspaceReadAuthorization> {
        self.workspace_authorization.as_ref()
    }
}

impl WorkspaceReadAuthorization {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn wire_token(&self) -> String {
        self.token.to_wire()
    }

    pub(crate) fn retained_file_binding(&self) -> Arc<fs::File> {
        self.file_binding.clone()
    }
}

impl RenamedWorkspaceEntry {
    pub(crate) fn workspace(&self) -> &AuthorizedWorkspace {
        &self.workspace
    }

    pub(crate) fn old_path(&self) -> &Path {
        &self.old_path
    }

    pub(crate) fn new_path(&self) -> &Path {
        &self.new_path
    }

    pub(crate) fn is_file(&self) -> bool {
        self.is_file
    }
}

impl DeletedWorkspaceEntry {
    pub(crate) fn workspace(&self) -> &AuthorizedWorkspace {
        &self.workspace
    }

    pub(crate) fn deleted_path(&self) -> &Path {
        &self.deleted_path
    }

    #[cfg(test)]
    pub(crate) fn is_file(&self) -> bool {
        self.is_file
    }
}

impl WorkspaceToken {
    const WIRE_PREFIX: &'static str = "workspace-";
    const RECEIPT_PREFIX: &'static str = "workspace-open-";

    fn to_wire(self) -> String {
        format!("{}{id}", Self::WIRE_PREFIX, id = self.0)
    }

    fn from_wire(value: &str) -> Result<Self, String> {
        let id = value
            .strip_prefix(Self::WIRE_PREFIX)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Invalid workspace token".to_string())?
            .parse::<u64>()
            .map_err(|_| "Invalid workspace token".to_string())?;
        let token = Self(id);
        if token.to_wire() != value {
            return Err("Invalid workspace token".to_string());
        }
        Ok(token)
    }

    fn to_receipt(self) -> String {
        format!("{}{id}", Self::RECEIPT_PREFIX, id = self.0)
    }

    fn from_receipt(value: &str) -> Result<Self, String> {
        let id = value
            .strip_prefix(Self::RECEIPT_PREFIX)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Invalid workspace open receipt".to_string())?
            .parse::<u64>()
            .map_err(|_| "Invalid workspace open receipt".to_string())?;
        Ok(Self(id))
    }
}

impl AuthorizedFile {
    fn new(path: PathBuf, origin: GrantOrigin) -> Self {
        #[cfg(not(test))]
        let _ = &origin;
        Self {
            path,
            #[cfg(test)]
            origin,
        }
    }

    #[cfg(test)]
    fn origin(&self) -> &GrantOrigin {
        &self.origin
    }

    pub(crate) fn into_path(self) -> PathBuf {
        self.path
    }
}

impl AuthorizedPreviewScope {
    pub(crate) fn document(&self) -> &Path {
        &self.document
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn lease(&self) -> &PreviewLeaseId {
        &self.lease
    }

    pub(crate) fn into_parts(self) -> (PathBuf, PathBuf, PreviewLeaseId) {
        (self.document, self.root, self.lease)
    }
}

impl GrantKey {
    fn path(&self) -> &Path {
        match self {
            Self::ExactReadWrite(path) | Self::DirectoryRead(path) | Self::InternalAsset(path) => {
                path
            }
        }
    }

    fn relocated(self, old_prefix: &Path, new_prefix: &Path) -> Self {
        fn relocated_path(path: PathBuf, old_prefix: &Path, new_prefix: &Path) -> PathBuf {
            match path.strip_prefix(old_prefix) {
                Ok(suffix) => new_prefix.join(suffix),
                Err(_) => path,
            }
        }

        match self {
            Self::ExactReadWrite(path) => {
                Self::ExactReadWrite(relocated_path(path, old_prefix, new_prefix))
            }
            Self::DirectoryRead(path) => {
                Self::DirectoryRead(relocated_path(path, old_prefix, new_prefix))
            }
            Self::InternalAsset(path) => {
                Self::InternalAsset(relocated_path(path, old_prefix, new_prefix))
            }
        }
    }
}

impl GrantLedger {
    fn new(origin: GrantOrigin, first_granted_sequence: u64) -> Self {
        Self {
            origins: HashMap::from([(origin, 1)]),
            status: GrantStatus::Active,
            first_granted_sequence,
        }
    }

    fn try_new(origin: GrantOrigin, first_granted_sequence: u64) -> Result<Self, String> {
        let mut origins = HashMap::new();
        origins
            .try_reserve(1)
            .map_err(|_| "Cannot reserve document grant origin".to_string())?;
        origins.insert(origin, 1);
        Ok(Self {
            origins,
            status: GrantStatus::Active,
            first_granted_sequence,
        })
    }

    fn is_active(&self) -> bool {
        self.status == GrantStatus::Active && !self.origins.is_empty()
    }

    fn add_origin(&mut self, origin: GrantOrigin) {
        let count = self.origins.entry(origin).or_default();
        *count = count.saturating_add(1);
        self.status = GrantStatus::Active;
    }

    fn revoke_origin(&mut self, origin: &GrantOrigin, mode: RevokeOriginMode) {
        let remove = match (self.origins.get_mut(origin), mode) {
            (Some(_), RevokeOriginMode::All) => true,
            (None, _) => false,
        };
        if remove {
            self.origins.remove(origin);
        }
    }

    fn suspend(&mut self) {
        self.status = GrantStatus::Suspended;
    }

    fn merge(&mut self, other: Self) {
        match (self.status, other.status) {
            (GrantStatus::Suspended, GrantStatus::Active) => {
                *self = other;
                return;
            }
            (GrantStatus::Active, GrantStatus::Suspended) => return,
            _ => {}
        }
        self.first_granted_sequence = self
            .first_granted_sequence
            .min(other.first_granted_sequence);
        for (origin, count) in other.origins {
            let current = self.origins.entry(origin).or_default();
            *current = current.saturating_add(count);
        }
    }
}

impl AuthorizationState {
    fn next_authorization_generation(&self) -> Result<u64, String> {
        self.authorization_generation
            .checked_add(1)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())
    }

    fn advance_authorization_generation(&mut self) -> Result<(), String> {
        self.authorization_generation = self.next_authorization_generation()?;
        Ok(())
    }

    fn allocate_workspace_token(&mut self) -> Result<WorkspaceToken, String> {
        let id = self.next_workspace_token_id;
        self.next_workspace_token_id = id
            .checked_add(1)
            .ok_or_else(|| "Workspace authorization identifier space is exhausted".to_string())?;
        Ok(WorkspaceToken(id))
    }

    fn allocate_document_grant_id(&mut self) -> Result<DocumentGrantId, String> {
        let id = self.next_document_grant_id;
        self.next_document_grant_id = id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        Ok(DocumentGrantId(id))
    }

    fn allocate_preview_lease(
        &mut self,
        document: PathBuf,
        authority_anchor: Option<PathBuf>,
    ) -> Result<PreviewLeaseId, String> {
        let generation = self.next_preview_lease_id;
        self.next_preview_lease_id = generation
            .checked_add(1)
            .ok_or_else(|| "HTML preview lease identifier space is exhausted".to_string())?;
        Ok(PreviewLeaseId {
            generation,
            document,
            authority_anchor,
        })
    }

    fn grant(&mut self, key: GrantKey, origin: GrantOrigin) -> Result<(), String> {
        self.advance_authorization_generation()?;
        if let Some(ledger) = self.grants.get_mut(&key) {
            ledger.add_origin(origin);
            return Ok(());
        }
        let sequence = self.next_grant_sequence;
        self.next_grant_sequence = self.next_grant_sequence.saturating_add(1);
        self.grants.insert(key, GrantLedger::new(origin, sequence));
        Ok(())
    }

    fn grant_once(&mut self, key: GrantKey, origin: GrantOrigin) -> Result<(), String> {
        if self.grants.get(&key).is_some_and(|ledger| {
            ledger.status == GrantStatus::Active && ledger.origins.contains_key(&origin)
        }) {
            return Ok(());
        }
        self.advance_authorization_generation()?;
        if let Some(ledger) = self.grants.get_mut(&key) {
            ledger.origins.entry(origin).or_insert(1);
            ledger.status = GrantStatus::Active;
            return Ok(());
        }
        let sequence = self.next_grant_sequence;
        self.next_grant_sequence = self.next_grant_sequence.saturating_add(1);
        self.grants.insert(key, GrantLedger::new(origin, sequence));
        Ok(())
    }

    fn revoke_origin_raw(&mut self, origin: &GrantOrigin, mode: RevokeOriginMode) {
        for ledger in self.grants.values_mut() {
            ledger.revoke_origin(origin, mode);
        }
        self.grants.retain(|_, ledger| !ledger.origins.is_empty());
        if let GrantOrigin::Workspace(token) = origin {
            self.workspaces.remove(token);
        }
        if let GrantOrigin::OpenDocument(id) = origin {
            self.workspace_document_origins.remove(id);
            self.document_origin_identities.remove(id);
        }
    }

    #[cfg(test)]
    fn revoke_origin(
        &mut self,
        origin: &GrantOrigin,
        mode: RevokeOriginMode,
    ) -> Result<bool, String> {
        let changes = self
            .grants
            .values()
            .any(|ledger| ledger.origins.contains_key(origin))
            || matches!(origin, GrantOrigin::Workspace(token) if self.workspaces.contains_key(token));
        if !changes {
            return Ok(false);
        }
        self.advance_authorization_generation()?;
        self.revoke_origin_raw(origin, mode);
        Ok(true)
    }

    fn unsupported_preview_leases(&self) -> HashSet<PreviewLeaseId> {
        let preview_leases = self
            .grants
            .values()
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::Preview(lease) => Some(lease.clone()),
                _ => None,
            })
            .collect::<HashSet<_>>();

        preview_leases
            .into_iter()
            .filter(|lease| !self.preview_lease_is_supported(lease))
            .collect()
    }

    fn preview_lease_is_supported(&self, lease: &PreviewLeaseId) -> bool {
        let authority_document = lease.authority_anchor.as_deref().unwrap_or(&lease.document);
        let authority_origins = active_authority_origins_for_path(self, authority_document);

        self.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && matches!(key, GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                    if path_is_under(&lease.document, root)
                        && path_is_under(authority_document, root))
                && ledger_shares_current_origin(self, key.path(), ledger, &authority_origins)
        })
    }

    fn preview_lease_is_active_and_supported(&self, lease: &PreviewLeaseId) -> bool {
        let origin = GrantOrigin::Preview(lease.clone());
        self.grants
            .values()
            .any(|ledger| ledger.is_active() && ledger.origins.contains_key(&origin))
            && self.preview_lease_is_supported(lease)
    }

    #[cfg(test)]
    fn revoke_origin_and_unsupported_previews(
        &mut self,
        origin: &GrantOrigin,
        mode: RevokeOriginMode,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        self.revoke_origin(origin, mode)?;
        let mut invalidated = self.unsupported_preview_leases();
        if let GrantOrigin::Preview(lease) = origin {
            invalidated.insert(lease.clone());
        }
        for lease in &invalidated {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated)
    }

    fn relocate_path_prefix(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        self.relocate_path_prefix_with_identity(old_prefix, new_prefix, None)
    }

    fn relocate_path_prefix_with_identity(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: Option<&str>,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        if old_prefix == new_prefix {
            return Ok(HashSet::new());
        }
        let unbound_documents = if expected_identity.is_some() {
            let document_ids = self
                .grants
                .iter()
                .filter(|(key, ledger)| {
                    ledger.is_active()
                        && matches!(key, GrantKey::ExactReadWrite(path) if path_is_under(path, old_prefix))
                })
                .flat_map(|(_, ledger)| ledger.origins.keys())
                .filter_map(|origin| match origin {
                    GrantOrigin::OpenDocument(id) => Some(*id),
                    _ => None,
                })
                .collect::<HashSet<_>>();
            let unbound = document_ids
                .iter()
                .filter(|id| !self.document_origin_identities.contains_key(id))
                .copied()
                .collect::<Vec<_>>();
            self.document_origin_identities
                .try_reserve(unbound.len())
                .map_err(|_| "Cannot reserve renamed document identity provenance".to_string())?;
            unbound
        } else {
            Vec::new()
        };
        let invalidates_preview = self.grants.values().any(|ledger| {
            ledger.origins.keys().any(|origin| {
                matches!(origin, GrantOrigin::Preview(lease)
                    if lease.intersects_prefix(old_prefix) || lease.intersects_prefix(new_prefix))
            })
        });
        let changes = self
            .workspaces
            .values()
            .any(|workspace| path_is_under(&workspace.root, old_prefix))
            || self
                .grants
                .keys()
                .any(|key| path_is_under(key.path(), old_prefix))
            || invalidates_preview;
        if !changes {
            return Ok(HashSet::new());
        }
        self.advance_authorization_generation()?;
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger
                    .origins
                    .keys()
                    .filter_map(move |origin| match origin {
                        GrantOrigin::Preview(lease)
                            if path_is_under(key.path(), old_prefix)
                                || path_is_under(key.path(), new_prefix)
                                || lease.intersects_prefix(old_prefix)
                                || lease.intersects_prefix(new_prefix) =>
                        {
                            Some(lease.clone())
                        }
                        _ => None,
                    })
            })
            .collect::<HashSet<_>>();
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        for workspace in self.workspaces.values_mut() {
            if let Ok(suffix) = workspace.root.strip_prefix(old_prefix) {
                workspace.root = new_prefix.join(suffix);
            }
        }
        let grants = std::mem::take(&mut self.grants);
        for (key, ledger) in grants {
            let relocated_key = key.relocated(old_prefix, new_prefix);
            if let Some(existing) = self.grants.get_mut(&relocated_key) {
                existing.merge(ledger);
            } else {
                self.grants.insert(relocated_key, ledger);
            }
        }
        if let Some(expected_identity) = expected_identity {
            for document_id in unbound_documents {
                self.document_origin_identities
                    .insert(document_id, expected_identity.to_string());
            }
        }
        Ok(invalidated_preview_leases)
    }

    fn suspend_write_path(&mut self, path: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidated_preview_leases = self
            .grants
            .values()
            .flat_map(|ledger| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease) if lease.references_path(path) => {
                        Some(lease.clone())
                    }
                    _ => None,
                })
            })
            .collect::<HashSet<_>>();

        let suspends_grant = self
            .grants
            .get(&GrantKey::ExactReadWrite(path.to_path_buf()))
            .is_some_and(|ledger| ledger.status == GrantStatus::Active);
        if !suspends_grant && invalidated_preview_leases.is_empty() {
            return Ok(invalidated_preview_leases);
        }
        self.advance_authorization_generation()?;

        if let Some(ledger) = self
            .grants
            .get_mut(&GrantKey::ExactReadWrite(path.to_path_buf()))
        {
            ledger.suspend();
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated_preview_leases)
    }

    fn suspend_rename_path_prefixes(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<GrantKey>, String> {
        let is_affected =
            |path: &Path| path_is_under(path, old_prefix) || path_is_under(path, new_prefix);
        let affected = self
            .grants
            .iter()
            .filter_map(|(key, ledger)| {
                (matches!(
                    key,
                    GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
                ) && is_affected(key.path())
                    && ledger.status == GrantStatus::Active)
                    .then_some(key.clone())
            })
            .collect::<HashSet<_>>();
        if affected.is_empty() {
            return Ok(affected);
        }
        self.advance_authorization_generation()?;
        let mut transitioned_grants = HashSet::new();
        for (key, ledger) in &mut self.grants {
            if matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && is_affected(key.path())
                && ledger.status == GrantStatus::Active
            {
                ledger.suspend();
                transitioned_grants.insert(key.clone());
            }
        }
        Ok(transitioned_grants)
    }

    fn restore_rename_grants(
        &mut self,
        transitioned_grants: &HashSet<GrantKey>,
    ) -> Result<(), String> {
        let changes = transitioned_grants.iter().any(|key| {
            self.grants.get(key).is_some_and(|ledger| {
                ledger.status == GrantStatus::Suspended && !ledger.origins.is_empty()
            })
        });
        if !changes {
            return Ok(());
        }
        self.advance_authorization_generation()?;
        for key in transitioned_grants {
            if let Some(ledger) = self.grants.get_mut(key) {
                if ledger.status == GrantStatus::Suspended && !ledger.origins.is_empty() {
                    ledger.status = GrantStatus::Active;
                }
            }
        }
        Ok(())
    }

    fn finalize_indeterminate_rename(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let _ = self.suspend_rename_path_prefixes(old_prefix, new_prefix)?;
        let is_affected =
            |path: &Path| path_is_under(path, old_prefix) || path_is_under(path, new_prefix);
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease)
                        if is_affected(key.path())
                            || lease.intersects_prefix(old_prefix)
                            || lease.intersects_prefix(new_prefix) =>
                    {
                        Some(lease.clone())
                    }
                    _ => None,
                })
            })
            .collect::<HashSet<_>>();
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated_preview_leases)
    }

    fn suspend_delete_path_prefix(
        &mut self,
        prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease)
                        if path_is_under(key.path(), prefix) || lease.intersects_prefix(prefix) =>
                    {
                        Some(lease.clone())
                    }
                    _ => None,
                })
            })
            .collect::<HashSet<_>>();

        let suspends_grant = self.grants.iter().any(|(key, ledger)| {
            matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && path_is_under(key.path(), prefix)
                && ledger.status == GrantStatus::Active
        });
        if !suspends_grant && invalidated_preview_leases.is_empty() {
            return Ok(invalidated_preview_leases);
        }
        self.advance_authorization_generation()?;

        for (key, ledger) in &mut self.grants {
            if matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && path_is_under(key.path(), prefix)
            {
                ledger.suspend();
            }
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated_preview_leases)
    }

    fn revoke_path_prefix(&mut self, prefix: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidates_preview = self.grants.values().any(|ledger| {
            ledger.origins.keys().any(|origin| {
                matches!(origin, GrantOrigin::Preview(lease) if lease.intersects_prefix(prefix))
            })
        });
        let changes = self
            .grants
            .keys()
            .any(|key| path_is_under(key.path(), prefix))
            || self
                .workspaces
                .values()
                .any(|workspace| path_is_under(&workspace.root, prefix))
            || invalidates_preview;
        if !changes {
            return Ok(HashSet::new());
        }
        self.advance_authorization_generation()?;
        let mut invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger
                    .origins
                    .keys()
                    .filter_map(move |origin| match origin {
                        GrantOrigin::Preview(lease)
                            if path_is_under(key.path(), prefix)
                                || lease.intersects_prefix(prefix) =>
                        {
                            Some(lease.clone())
                        }
                        _ => None,
                    })
            })
            .collect::<HashSet<_>>();
        let origins = self
            .grants
            .iter()
            .filter(|(key, _)| path_is_under(key.path(), prefix))
            .flat_map(|(_, ledger)| ledger.origins.keys().cloned())
            .collect::<HashSet<_>>();
        for origin in origins {
            self.revoke_origin_raw(&origin, RevokeOriginMode::All);
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        self.grants
            .retain(|key, _| !path_is_under(key.path(), prefix));
        self.workspaces
            .retain(|_, workspace| !path_is_under(&workspace.root, prefix));
        let unsupported = self.unsupported_preview_leases();
        for lease in &unsupported {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        invalidated_preview_leases.extend(unsupported);
        Ok(invalidated_preview_leases)
    }
}

impl FileAuthorizationSession {
    fn lock(&self) -> Result<AuthorizationGuard<'_>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Authorization state is poisoned".to_string())?;
        #[cfg(test)]
        {
            Ok(AuthorizationGuard::new(guard))
        }
        #[cfg(not(test))]
        {
            Ok(guard)
        }
    }

    pub(crate) fn authorization_generation(&self) -> Result<u64, String> {
        Ok(self.lock()?.authorization_generation)
    }

    #[cfg(feature = "packaged-lifecycle-e2e")]
    pub(crate) fn evidence_snapshot(&self) -> Result<AuthorizationEvidenceSnapshot, String> {
        let state = self.lock()?;
        let mut grants = state
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                let (kind, path) = match key {
                    GrantKey::ExactReadWrite(path) => ("exact_rw", path),
                    GrantKey::DirectoryRead(path) => ("directory_read", path),
                    GrantKey::InternalAsset(path) => ("internal_asset", path),
                };
                ledger.origins.iter().map(move |(origin, count)| {
                    let origin = match origin {
                        GrantOrigin::Workspace(_) => "workspace",
                        GrantOrigin::OpenDocument(_) => "open_document",
                        GrantOrigin::SaveAs(_) => "save_as",
                        GrantOrigin::CreatedDocument(_) => "created_document",
                        GrantOrigin::Preview(_) => "preview",
                    };
                    AuthorizationEvidenceGrant {
                        kind,
                        path: path.to_string_lossy().into_owned(),
                        origin,
                        status: match ledger.status {
                            GrantStatus::Active => "active",
                            GrantStatus::Suspended => "suspended",
                        },
                        count: *count,
                    }
                })
            })
            .collect::<Vec<_>>();
        grants.sort_by(|left, right| {
            (
                left.kind,
                left.path.as_str(),
                left.origin,
                left.status,
                left.count,
            )
                .cmp(&(
                    right.kind,
                    right.path.as_str(),
                    right.origin,
                    right.status,
                    right.count,
                ))
        });
        let mut aggregated: Vec<AuthorizationEvidenceGrant> = Vec::with_capacity(grants.len());
        for grant in grants {
            if let Some(existing) = aggregated.last_mut().filter(|existing| {
                existing.kind == grant.kind
                    && existing.path == grant.path
                    && existing.origin == grant.origin
                    && existing.status == grant.status
            }) {
                existing.count = existing.count.saturating_add(grant.count);
            } else {
                aggregated.push(grant);
            }
        }
        Ok(AuthorizationEvidenceSnapshot {
            generation: state.authorization_generation,
            pending_workspace_receipts: state.pending_workspace_authorities.len(),
            grants: aggregated,
        })
    }

    #[cfg(test)]
    pub(crate) fn set_authorization_generation_for_test(
        &self,
        generation: u64,
    ) -> Result<(), String> {
        self.lock()?.authorization_generation = generation;
        Ok(())
    }

    pub(crate) fn with_save_authorization_scope<T>(
        &self,
        path: impl AsRef<Path>,
        operation: impl FnOnce(&mut SaveAuthorizationScope<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = normalize_file_for_write(path)?;
        let mut state = self.lock()?;
        operation(&mut SaveAuthorizationScope {
            state: &mut state,
            path,
        })
    }

    pub(crate) fn with_exact_write_authority<T>(
        &self,
        path: impl AsRef<Path>,
        operation: impl FnOnce(&Path, u64) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if !state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &path && exact_grant_is_current(&state, file, ledger))
        }) {
            return Err("Destination file has not been explicitly authorized by open, workspace selection, or save-as".into());
        }
        operation(&path, state.authorization_generation)
    }

    pub(crate) fn reserve_pending_save_authority(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PendingSaveAuthority, String> {
        let path = normalize_file_for_write(path)?;
        let mut state = self.lock()?;
        state
            .authorization_generation
            .checked_add(2)
            .ok_or_else(|| {
                "Authorization generation cannot reserve a save-as transition".to_string()
            })?;
        let id = DocumentGrantId(state.next_document_grant_id);
        let next_document_grant_id = state
            .next_document_grant_id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        let origin = GrantOrigin::SaveAs(id);
        let mut keys = vec![GrantKey::ExactReadWrite(path.clone())];
        if let Some(parent) = path.parent() {
            keys.push(GrantKey::InternalAsset(parent.to_path_buf()));
        }
        let new_grant_count = keys
            .iter()
            .filter(|key| !state.grants.contains_key(*key))
            .count();
        state
            .grants
            .try_reserve(new_grant_count)
            .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
        state
            .pending_save_authorities
            .try_reserve(1)
            .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
        let mut mutations = Vec::new();
        mutations
            .try_reserve_exact(keys.len())
            .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
        let mut next_grant_sequence = state.next_grant_sequence;
        for key in keys {
            if let Some(ledger) = state.grants.get_mut(&key) {
                ledger
                    .origins
                    .try_reserve(1)
                    .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
                mutations.push(PreparedGrantMutation::Existing {
                    key,
                    origin: origin.clone(),
                });
            } else {
                mutations.push(PreparedGrantMutation::New {
                    key,
                    ledger: GrantLedger::try_new(origin.clone(), next_grant_sequence)?,
                });
                next_grant_sequence = next_grant_sequence
                    .checked_add(1)
                    .ok_or_else(|| "Document grant sequence is exhausted".to_string())?;
            }
        }
        state.authorization_generation += 1;
        let generation = state.authorization_generation;
        state.next_document_grant_id = next_document_grant_id;
        state.next_grant_sequence = next_grant_sequence;
        if state.pending_save_authorities.len() >= MAX_PENDING_SAVE_AUTHORITIES {
            state.pending_save_authorities.clear();
        }
        state.pending_save_authorities.insert(
            id,
            PendingSaveReservation {
                path: path.clone(),
                mutations,
            },
        );
        Ok(PendingSaveAuthority {
            path,
            id,
            generation,
        })
    }

    pub(crate) fn cancel_pending_save_authority(
        &self,
        pending: &PendingSaveAuthority,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let removed = state.pending_save_authorities.remove(&pending.id).is_some();
        if removed && pending.generation == state.authorization_generation {
            state.authorization_generation += 1;
        }
        Ok(removed)
    }

    #[cfg(test)]
    pub(crate) fn pending_save_authority_count_for_test(&self) -> Result<usize, String> {
        let count = self.lock()?.pending_save_authorities.len();
        debug_assert!(count <= MAX_PENDING_SAVE_AUTHORITIES);
        Ok(count)
    }

    #[cfg(test)]
    pub(crate) fn expire_workspace_authority_for_test(&self, receipt: &str) -> Result<(), String> {
        let token = WorkspaceToken::from_receipt(receipt)?;
        let mut state = self.lock()?;
        let pending = state
            .pending_workspace_authorities
            .get_mut(&token)
            .ok_or_else(|| "Workspace open receipt is unknown".to_string())?;
        pending.expires_at = Instant::now();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn pending_workspace_authority_count_for_test(&self) -> Result<usize, String> {
        Ok(self.lock()?.pending_workspace_authorities.len())
    }

    #[cfg(test)]
    pub(crate) fn state_fingerprint_for_test(&self) -> String {
        let state = match self.inner.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut workspaces = state
            .workspaces
            .iter()
            .map(|(token, workspace)| format!("{token:?}:{}", workspace.root.display()))
            .collect::<Vec<_>>();
        workspaces.sort();
        let mut workspace_document_origins = state
            .workspace_document_origins
            .iter()
            .map(|(document, workspace)| format!("{document:?}:{workspace:?}"))
            .collect::<Vec<_>>();
        workspace_document_origins.sort();
        let mut document_origin_identities = state
            .document_origin_identities
            .iter()
            .map(|(document, identity)| format!("{document:?}:{identity}"))
            .collect::<Vec<_>>();
        document_origin_identities.sort();
        let mut grants = state
            .grants
            .iter()
            .map(|(key, ledger)| {
                let mut origins = ledger
                    .origins
                    .iter()
                    .map(|(origin, count)| format!("{origin:?}:{count}"))
                    .collect::<Vec<_>>();
                origins.sort();
                format!(
                    "{key:?}:{:?}:{}:{origins:?}",
                    ledger.status, ledger.first_granted_sequence
                )
            })
            .collect::<Vec<_>>();
        grants.sort();
        format!(
            "workspaces={workspaces:?};workspace_document_origins={workspace_document_origins:?};document_origin_identities={document_origin_identities:?};grants={grants:?};counters={:?}",
            (
                state.next_workspace_token_id,
                state.next_document_grant_id,
                state.next_preview_lease_id,
                state.next_grant_sequence,
                state.authorization_generation,
            )
        )
    }

    #[cfg(test)]
    pub(crate) fn exact_write_grant_snapshot_for_test(
        &self,
        path: &Path,
    ) -> Result<Option<(GrantStatus, usize)>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .get(&GrantKey::ExactReadWrite(path.to_path_buf()))
            .map(|ledger| (ledger.status, ledger.origins.values().sum())))
    }

    #[cfg(test)]
    pub(crate) fn internal_asset_grant_snapshot_for_test(
        &self,
        path: &Path,
    ) -> Result<Option<(GrantStatus, usize)>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .get(&GrantKey::InternalAsset(path.to_path_buf()))
            .map(|ledger| (ledger.status, ledger.origins.values().sum())))
    }

    #[cfg(test)]
    pub(crate) fn preview_lease_snapshot(&self) -> Result<HashSet<PreviewLeaseId>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .values()
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::Preview(lease) => Some(lease.clone()),
                _ => None,
            })
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn fail_next_preview_retirement(
        &self,
        error: impl Into<String>,
    ) -> Result<(), String> {
        *self
            .next_preview_retirement_error
            .lock()
            .map_err(|_| "Preview retirement test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_next_preview_retirement_as_unavailable(
        &self,
        error: impl Into<String>,
    ) -> Result<(), String> {
        *self
            .next_preview_retirement_unavailable_error
            .lock()
            .map_err(|_| "Preview retirement unavailable test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_next_save_publish(&self, error: impl Into<String>) -> Result<(), String> {
        *self
            .next_save_publish_error
            .lock()
            .map_err(|_| "Save publication test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }

    fn workspace_candidate(&self, root: impl AsRef<Path>) -> Result<WorkspaceCandidate, String> {
        let root = normalize_existing_path(root)?;
        if !root.is_dir() {
            return Err("Authorized root must be a directory".into());
        }
        let root_binding = WorkspaceRootBinding::capture(&root)?;
        Ok(WorkspaceCandidate { root, root_binding })
    }

    #[cfg(test)]
    pub(crate) fn workspace_candidate_for_test(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<WorkspaceCandidate, String> {
        self.workspace_candidate(root)
    }

    pub(crate) fn open_workspace<S>(
        &self,
        root: impl AsRef<Path>,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, S), String> {
        let candidate = self.workspace_candidate(root)?;
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let mut state = self.lock()?;
        transport(&candidate.root)?;
        let workspace = Self::publish_workspace(&mut state, candidate)?;
        Ok((workspace, snapshot))
    }

    pub(crate) fn open_resource_directory(
        &self,
        root: impl AsRef<Path>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<AuthorizedWorkspace, String> {
        self.open_workspace(root, |_| Ok(()), transport)
            .map(|(authorization, ())| authorization)
    }

    pub(crate) fn open_workspace_at_canonical_root<S>(
        &self,
        root: impl AsRef<Path>,
        expected_root: &Path,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, S), String> {
        let candidate = self.workspace_candidate(root)?;
        if candidate.root != expected_root {
            return Err("Saved workspace root changed while being restored".to_string());
        }
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let mut state = self.lock()?;
        transport(&candidate.root)?;
        let workspace = Self::publish_workspace(&mut state, candidate)?;
        Ok((workspace, snapshot))
    }

    pub(crate) fn prepare_workspace_authorization<S>(
        &self,
        owner_window: &str,
        root: impl AsRef<Path>,
        expected_root: Option<&Path>,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
    ) -> Result<PreparedWorkspaceAuthorization<S>, String> {
        let candidate = self.workspace_candidate(root)?;
        if expected_root.is_some_and(|expected| candidate.root != expected) {
            return Err("Saved workspace root changed while being restored".to_string());
        }
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let now = Instant::now();
        let mut state = self.lock()?;
        state
            .pending_workspace_authorities
            .retain(|_, pending| pending.expires_at > now);
        if state.pending_workspace_authorities.len() >= MAX_PENDING_WORKSPACE_AUTHORITIES {
            return Err("Too many workspace opens are awaiting completion".to_string());
        }
        let token = state.allocate_workspace_token()?;
        let workspace = AuthorizedWorkspace::new(
            token,
            candidate.root.clone(),
            candidate.root_binding.clone(),
        );
        let receipt = token.to_receipt();
        state.pending_workspace_authorities.insert(
            token,
            PendingWorkspaceReservation {
                owner_window: owner_window.to_string(),
                candidate,
                expires_at: now + PENDING_WORKSPACE_AUTHORITY_TTL,
            },
        );
        Ok(PreparedWorkspaceAuthorization {
            workspace,
            snapshot,
            receipt,
        })
    }

    pub(crate) fn settle_workspace_authorization(
        &self,
        owner_window: &str,
        receipt: &str,
        applied: bool,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PreparedWorkspaceSettlement, String> {
        let token = WorkspaceToken::from_receipt(receipt)?;
        if token.to_receipt() != receipt {
            return Err("Invalid workspace open receipt".to_string());
        }
        let now = Instant::now();
        let mut state = self.lock()?;
        let target_expired = state
            .pending_workspace_authorities
            .get(&token)
            .is_some_and(|pending| pending.expires_at <= now);
        state
            .pending_workspace_authorities
            .retain(|_, pending| pending.expires_at > now);
        if target_expired {
            return Ok(PreparedWorkspaceSettlement::Expired);
        }
        let Some(pending) = state.pending_workspace_authorities.get(&token) else {
            return Ok(PreparedWorkspaceSettlement::Unknown);
        };
        if pending.owner_window != owner_window {
            return Err("Workspace open receipt belongs to another window".to_string());
        }
        let pending = state
            .pending_workspace_authorities
            .remove(&token)
            .expect("workspace reservation was checked while authorization was held");
        if !applied {
            return Ok(PreparedWorkspaceSettlement::Discarded);
        }

        let current = self.workspace_candidate(&pending.candidate.root)?;
        if current.root != pending.candidate.root
            || !current
                .root_binding
                .same_object(&pending.candidate.root_binding)
        {
            return Err("Workspace root changed before the open was applied".to_string());
        }
        let workspace = Self::publish_workspace_with_token(&mut state, token, current)?;
        if let Err(error) = transport(workspace.root()) {
            let origin = GrantOrigin::Workspace(token);
            state.revoke_origin_raw(&origin, RevokeOriginMode::All);
            return Err(error);
        }
        Ok(PreparedWorkspaceSettlement::Applied)
    }

    fn publish_workspace(
        state: &mut AuthorizationState,
        candidate: WorkspaceCandidate,
    ) -> Result<AuthorizedWorkspace, String> {
        let token = state.allocate_workspace_token()?;
        Self::publish_workspace_with_token(state, token, candidate)
    }

    fn publish_workspace_with_token(
        state: &mut AuthorizationState,
        token: WorkspaceToken,
        candidate: WorkspaceCandidate,
    ) -> Result<AuthorizedWorkspace, String> {
        if !candidate.root_binding.is_current(&candidate.root) {
            return Err("Workspace root changed before authorization was published".to_string());
        }
        state
            .authorization_generation
            .checked_add(2)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())?;
        let origin = GrantOrigin::Workspace(token);
        state.grant(
            GrantKey::DirectoryRead(candidate.root.clone()),
            origin.clone(),
        )?;
        state.grant(GrantKey::InternalAsset(candidate.root.clone()), origin)?;
        state.workspaces.insert(
            token,
            WorkspaceGrant {
                root: candidate.root.clone(),
                root_identity: candidate.root_binding.identity.clone(),
            },
        );
        Ok(AuthorizedWorkspace::new(
            token,
            candidate.root,
            candidate.root_binding,
        ))
    }

    #[cfg(test)]
    fn authorize_directory_root_with<F>(
        &self,
        root: impl AsRef<Path>,
        before_commit: F,
    ) -> Result<AuthorizedWorkspace, String>
    where
        F: FnOnce(&WorkspaceCandidate) -> Result<(), String>,
    {
        let candidate = self.workspace_candidate(root)?;
        let mut state = self.lock()?;
        before_commit(&candidate)?;
        Self::publish_workspace(&mut state, candidate)
    }

    #[cfg(test)]
    fn authorize_directory_root(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<AuthorizedWorkspace, String> {
        self.authorize_directory_root_with(root, |_| Ok(()))
    }

    #[cfg(test)]
    fn authorize_file(&self, file: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Authorized file must be a file".into());
        }
        let mut state = self.lock()?;
        Self::publish_open_document(&mut state, file, true, None)
    }

    #[cfg(test)]
    pub(crate) fn open_standalone_file<S>(
        &self,
        file: impl AsRef<Path>,
        response: impl FnOnce(&Path) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedFile, S), String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Authorized file must be a file".into());
        }
        let response = response(&file)?;
        let parent = file
            .parent()
            .ok_or_else(|| "Selected file has no parent directory".to_string())?
            .to_path_buf();
        let mut state = self.lock()?;
        transport(&parent)?;
        let authorized = Self::publish_open_document(&mut state, file, true, None)?;
        Ok((authorized, response))
    }

    pub(crate) fn with_prepared_open_document_grant<T>(
        &self,
        file: impl AsRef<Path>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Prepared document grant target must be a file".to_string());
        }
        self.with_prepared_open_document_grant_inner(file, None, operation)
    }

    pub(crate) fn with_prepared_open_document_grant_for_receipt<T>(
        &self,
        file: PathBuf,
        workspace_authorization: Option<&WorkspaceReadAuthorization>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        if workspace_authorization.is_some_and(|authorization| authorization.path != file) {
            return Err(
                "Workspace open receipt target does not match its authorization".to_string(),
            );
        }
        self.with_prepared_open_document_grant_inner(file, workspace_authorization, operation)
    }

    fn with_prepared_open_document_grant_inner<T>(
        &self,
        file: PathBuf,
        workspace_authorization: Option<&WorkspaceReadAuthorization>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let parent = file
            .parent()
            .ok_or_else(|| "Prepared document grant target has no parent".to_string())?
            .to_path_buf();
        let mut state = self.lock()?;
        if workspace_authorization.is_some_and(|authorization| {
            !workspace_read_authorization_is_current(&state, authorization)
        }) {
            return Err("Workspace file identity changed before open was committed".to_string());
        }
        let document_grant_id = state.next_document_grant_id;
        let next_document_grant_id = document_grant_id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        let origin = GrantOrigin::OpenDocument(DocumentGrantId(document_grant_id));
        let workspace_document_origin = workspace_authorization
            .map(|authorization| (DocumentGrantId(document_grant_id), authorization.token));
        let document_origin_identity = workspace_authorization.map(|authorization| {
            (
                DocumentGrantId(document_grant_id),
                authorization.file_identity.clone(),
            )
        });
        if workspace_document_origin.is_some() {
            state
                .workspace_document_origins
                .try_reserve(1)
                .map_err(|_| "Cannot reserve workspace document provenance".to_string())?;
            state
                .document_origin_identities
                .try_reserve(1)
                .map_err(|_| "Cannot reserve document identity provenance".to_string())?;
        }
        let keys = [
            GrantKey::ExactReadWrite(file),
            GrantKey::InternalAsset(parent),
        ];
        let new_grant_count = keys
            .iter()
            .filter(|key| !state.grants.contains_key(*key))
            .count();
        state
            .grants
            .try_reserve(new_grant_count)
            .map_err(|_| "Cannot reserve document grants".to_string())?;

        let mut mutations = Vec::new();
        mutations
            .try_reserve_exact(keys.len())
            .map_err(|_| "Cannot reserve prepared document grants".to_string())?;
        let mut next_grant_sequence = state.next_grant_sequence;
        let next_authorization_generation = state.next_authorization_generation()?;
        for key in keys {
            if let Some(ledger) = state.grants.get_mut(&key) {
                ledger
                    .origins
                    .try_reserve(1)
                    .map_err(|_| "Cannot reserve document grant origin".to_string())?;
                mutations.push(PreparedGrantMutation::Existing {
                    key,
                    origin: origin.clone(),
                });
            } else {
                let ledger = GrantLedger::try_new(origin.clone(), next_grant_sequence)?;
                next_grant_sequence = next_grant_sequence
                    .checked_add(1)
                    .ok_or_else(|| "Document grant sequence is exhausted".to_string())?;
                mutations.push(PreparedGrantMutation::New { key, ledger });
            }
        }

        operation(PreparedOpenDocumentGrant {
            state,
            mutations,
            workspace_authorization: workspace_authorization.cloned(),
            workspace_document_origin,
            document_origin_identity,
            next_document_grant_id,
            next_grant_sequence,
            next_authorization_generation,
        })
    }

    fn prepare_save_destination(
        &self,
        path: impl AsRef<Path>,
        preflight: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PathBuf, String> {
        let normalized = normalize_file_for_write(path)?;
        let _state = self.lock()?;
        preflight(&normalized)?;
        Ok(normalized)
    }

    fn publish_save_destination(&self, normalized: PathBuf) -> Result<AuthorizedFile, String> {
        #[cfg(test)]
        if let Some(error) = self
            .next_save_publish_error
            .lock()
            .map_err(|_| "Save publication test seam is poisoned".to_string())?
            .take()
        {
            return Err(error);
        }
        let mut state = self.lock()?;
        let origin = GrantOrigin::SaveAs(state.allocate_document_grant_id()?);
        Self::grant_exact_file(&mut state, &normalized, origin.clone(), true)?;
        Ok(AuthorizedFile::new(normalized, origin))
    }

    #[cfg(test)]
    fn authorize_save_destination(&self, path: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let normalized = normalize_file_for_write(path)?;
        self.publish_save_destination(normalized)
    }

    fn grant_exact_file(
        state: &mut AuthorizationState,
        file: &Path,
        origin: GrantOrigin,
        include_internal_assets: bool,
    ) -> Result<(), String> {
        let grant_count = 1 + usize::from(include_internal_assets && file.parent().is_some());
        state
            .authorization_generation
            .checked_add(grant_count as u64)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())?;
        state.grant(GrantKey::ExactReadWrite(file.to_path_buf()), origin.clone())?;
        if include_internal_assets {
            if let Some(parent) = file.parent() {
                state.grant(GrantKey::InternalAsset(parent.to_path_buf()), origin)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn publish_open_document(
        state: &mut AuthorizationState,
        file: PathBuf,
        include_internal_assets: bool,
        workspace_provenance: Option<(WorkspaceToken, String)>,
    ) -> Result<AuthorizedFile, String> {
        if workspace_provenance.is_some() {
            state
                .workspace_document_origins
                .try_reserve(1)
                .map_err(|_| "Cannot reserve workspace document provenance".to_string())?;
            state
                .document_origin_identities
                .try_reserve(1)
                .map_err(|_| "Cannot reserve document identity provenance".to_string())?;
        }
        let document_id = state.allocate_document_grant_id()?;
        let origin = GrantOrigin::OpenDocument(document_id);
        Self::grant_exact_file(state, &file, origin.clone(), include_internal_assets)?;
        if let Some((token, file_identity)) = workspace_provenance {
            let replaced = state.workspace_document_origins.insert(document_id, token);
            debug_assert!(replaced.is_none());
            let replaced = state
                .document_origin_identities
                .insert(document_id, file_identity);
            debug_assert!(replaced.is_none());
        }
        Ok(AuthorizedFile::new(file, origin))
    }

    #[cfg(test)]
    fn open_workspace_file(&self, path: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let mut state = self.lock()?;
        let workspace_token = current_workspace_token_for_path(&state, &canonical);
        let workspace_token = workspace_token.ok_or_else(|| {
            "File is outside the user-authorized session files and directories".to_string()
        })?;
        let file_identity =
            current_file_identity_for_origin(&state, &canonical, Some(&workspace_token))
                .ok_or_else(|| {
                    "Workspace file identity changed before open publication".to_string()
                })?;
        Self::publish_open_document(
            &mut state,
            canonical,
            false,
            Some((workspace_token, file_identity)),
        )
    }

    fn is_existing_file_authorized(state: &AuthorizationState, canonical: &Path) -> bool {
        state.grants.iter().any(|(key, ledger)| match key {
            GrantKey::ExactReadWrite(file) => {
                file == canonical && exact_grant_is_current(state, file, ledger)
            }
            GrantKey::DirectoryRead(root) => {
                ledger.is_active()
                    && path_is_under(canonical, root)
                    && directory_read_grant_is_current(state, root, ledger)
            }
            GrantKey::InternalAsset(_) => false,
        })
    }

    fn file_for_read(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let state = self.lock()?;
        if Self::is_existing_file_authorized(&state, &canonical) {
            Ok(canonical)
        } else {
            Err("File is outside the user-authorized session files and directories".into())
        }
    }

    fn open_file_for_read_with_before_open(
        &self,
        path: impl AsRef<Path>,
        before_open: impl FnOnce(),
    ) -> Result<AuthorizedReadFile, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        enum ReadAuthority {
            Exact(ExactReadAuthority),
            Workspace {
                root: PathBuf,
                token: WorkspaceToken,
                binding: WorkspaceRootBinding,
            },
        }
        let authority = {
            let state = self.lock()?;
            let mut matching_directory_grant = false;
            let workspace = state
                .grants
                .iter()
                .filter(|(key, ledger)| {
                    ledger.is_active()
                        && matches!(key, GrantKey::DirectoryRead(root) if path_is_under(&canonical, root))
                })
                .filter_map(|(key, ledger)| {
                    let GrantKey::DirectoryRead(root) = key else {
                        return None;
                    };
                    matching_directory_grant = true;
                    current_workspace_binding_for_directory_grant(&state, root, ledger)
                        .map(|(token, binding)| (root.clone(), token, binding))
                })
                .max_by_key(|(root, _, _)| root.components().count());
            if let Some((root, token, binding)) = workspace {
                ReadAuthority::Workspace {
                    root,
                    token,
                    binding,
                }
            } else if let Some(exact) = state.grants.iter().find_map(|(key, ledger)| {
                let GrantKey::ExactReadWrite(file) = key else {
                    return None;
                };
                (file == &canonical)
                    .then(|| exact_read_authority(&state, file, ledger))
                    .flatten()
            }) {
                ReadAuthority::Exact(exact)
            } else if matching_directory_grant {
                return Err("Workspace root changed after authorization".to_string());
            } else {
                return Err(
                    "File is outside the user-authorized session files and directories".into(),
                );
            }
        };
        before_open();
        let secure_open_error = |error| {
            format!(
                "Failed to securely open file {}: {error}",
                canonical.display()
            )
        };
        let (file, workspace_authorization) = match authority {
            ReadAuthority::Exact(exact) => {
                let file = open_regular_file_without_following_links(&canonical)
                    .map_err(&secure_open_error)?;
                if let ExactReadAuthority::Identity(expected) = exact {
                    let actual = opened_file_platform_identity(&file).map_err(|error| {
                        format!(
                            "Failed to identify securely opened file {}: {error}",
                            canonical.display()
                        )
                    })?;
                    if actual != expected {
                        return Err(
                            "Securely opened file identity changed after authorization".to_string()
                        );
                    }
                }
                (file, None)
            }
            ReadAuthority::Workspace {
                root,
                token,
                binding,
            } => {
                let relative = canonical
                    .strip_prefix(&root)
                    .map_err(|_| {
                        "File is outside the user-authorized session files and directories"
                            .to_string()
                    })?
                    .to_path_buf();
                let file = binding
                    .open_regular_file(&relative)
                    .map_err(&secure_open_error)?;
                let file_identity = opened_file_platform_identity(&file).map_err(|error| {
                    format!(
                        "Failed to identify securely opened file {}: {error}",
                        canonical.display()
                    )
                })?;
                let file_binding = Arc::new(file.try_clone().map_err(|error| {
                    format!(
                        "Failed to retain securely opened file {}: {error}",
                        canonical.display()
                    )
                })?);
                let workspace_authorization = WorkspaceReadAuthorization {
                    path: canonical.clone(),
                    root,
                    relative,
                    token,
                    root_binding: binding,
                    file_binding,
                    file_identity,
                };
                (file, Some(workspace_authorization))
            }
        };
        Ok(AuthorizedReadFile {
            path: canonical,
            file,
            workspace_authorization,
        })
    }

    fn open_file_for_read(&self, path: impl AsRef<Path>) -> Result<AuthorizedReadFile, String> {
        self.open_file_for_read_with_before_open(path, || {})
    }

    fn open_exact_workspace_file_for_read(
        &self,
        workspace_token: &str,
        workspace_root: impl AsRef<Path>,
        path: impl AsRef<Path>,
    ) -> Result<AuthorizedReadFile, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let canonical_root = normalize_existing_path(workspace_root)?;
        if !canonical_root.is_dir() {
            return Err("Path is not a directory".into());
        }
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        enum ExactAuthority {
            Path,
            Identity(String),
        }
        let (workspace, exact) = {
            let state = self.lock()?;
            let workspace = Self::workspace_for_token(&state, &token)
                .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
            if workspace.root != canonical_root {
                return Err("Directory does not match the selected workspace".into());
            }
            if !path_is_under(&canonical, &workspace.root) {
                return Err("Document path is outside the authorized workspace".to_string());
            }
            let exact = state
                .grants
                .iter()
                .find_map(|(key, ledger)| {
                    let GrantKey::ExactReadWrite(file) = key else {
                        return None;
                    };
                    (file == &canonical)
                        .then(|| exact_read_authority(&state, file, ledger))
                        .flatten()
                })
                .ok_or_else(|| {
                    "Document has not been explicitly opened or saved in this session".to_string()
                })?;
            let exact = match exact {
                ExactReadAuthority::Path => ExactAuthority::Path,
                ExactReadAuthority::Identity(identity) => ExactAuthority::Identity(identity),
            };
            (workspace, exact)
        };
        if !workspace.root_binding.is_current(&workspace.root) {
            return Err("Workspace root changed after authorization".into());
        }
        let relative = canonical
            .strip_prefix(&workspace.root)
            .map_err(|_| "Document path is outside the authorized workspace".to_string())?
            .to_path_buf();
        let file = workspace
            .root_binding
            .open_regular_file(&relative)
            .map_err(|error| {
                format!(
                    "Failed to securely open file {}: {error}",
                    canonical.display()
                )
            })?;
        let file_identity = opened_file_platform_identity(&file).map_err(|error| {
            format!(
                "Failed to identify securely opened file {}: {error}",
                canonical.display()
            )
        })?;
        if let ExactAuthority::Identity(expected) = exact {
            if file_identity != expected {
                return Err("Securely opened file identity changed after authorization".to_string());
            }
        }
        let file_binding = Arc::new(file.try_clone().map_err(|error| {
            format!(
                "Failed to retain securely opened file {}: {error}",
                canonical.display()
            )
        })?);
        Ok(AuthorizedReadFile {
            path: canonical.clone(),
            file,
            workspace_authorization: Some(WorkspaceReadAuthorization {
                path: canonical,
                root: workspace.root,
                relative,
                token,
                root_binding: workspace.root_binding,
                file_binding,
                file_identity,
            }),
        })
    }

    fn file_for_watch(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let normalized = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if state.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && match key {
                    GrantKey::ExactReadWrite(file) => {
                        file == &normalized && exact_grant_is_current(&state, file, ledger)
                    }
                    GrantKey::DirectoryRead(root) => {
                        path_is_under(&normalized, root)
                            && directory_read_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::InternalAsset(_) => false,
                }
        }) {
            Ok(normalized)
        } else {
            Err("File is outside the user-authorized session files and directories".into())
        }
    }

    #[cfg(test)]
    fn file_for_write(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let normalized = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &normalized && exact_grant_is_current(&state, file, ledger))
        }) {
            Ok(normalized)
        } else {
            Err("Destination file has not been explicitly authorized by open, workspace selection, or save-as".into())
        }
    }

    fn write_document(
        &self,
        path: impl AsRef<Path>,
        preflight: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PathBuf, String> {
        let path = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if !state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &path && exact_grant_is_current(&state, file, ledger))
        }) {
            return Err("Destination file has not been explicitly authorized by open, workspace selection, or save-as".into());
        }
        preflight(&path)?;
        Ok(path)
    }

    fn suspend_write_file(&self, path: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.suspend_write_path(path)
    }

    fn directory_for_read(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_dir() {
            return Err("Path is not a directory".into());
        }
        let state = self.lock()?;
        if state.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && matches!(key, GrantKey::DirectoryRead(root)
                    if path_is_under(&canonical, root)
                        && directory_read_grant_is_current(&state, root, ledger))
        }) {
            Ok(canonical)
        } else {
            Err("Directory is outside the user-authorized session roots".into())
        }
    }

    fn workspace_for_token(
        state: &AuthorizationState,
        token: &WorkspaceToken,
    ) -> Option<AuthorizedWorkspace> {
        let workspace = state.workspaces.get(token)?;
        let root_binding = capture_current_workspace_binding(workspace, &workspace.root)?;
        state
            .grants
            .get(&GrantKey::DirectoryRead(workspace.root.clone()))
            .filter(|ledger| {
                ledger.is_active() && ledger.origins.contains_key(&GrantOrigin::Workspace(*token))
            })?;
        Some(AuthorizedWorkspace::new(
            *token,
            workspace.root.clone(),
            root_binding,
        ))
    }

    fn authorized_workspace_root_for_token(
        &self,
        workspace_token: &str,
        root: impl AsRef<Path>,
    ) -> Result<AuthorizedWorkspace, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let canonical = normalize_existing_path(root)?;
        if !canonical.is_dir() {
            return Err("Path is not a directory".into());
        }
        let state = self.lock()?;
        let workspace = Self::workspace_for_token(&state, &token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if workspace.root != canonical {
            return Err("Directory does not match the selected workspace".into());
        }
        drop(state);
        if !workspace.root_binding.is_current(&workspace.root) {
            return Err("Workspace root changed after authorization".into());
        }
        Ok(workspace)
    }

    pub(crate) fn ensure_workspace_is_current(
        &self,
        workspace: &AuthorizedWorkspace,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let active_workspace = Self::workspace_for_token(&state, &workspace.token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if active_workspace.root != workspace.root
            || !active_workspace
                .root_binding
                .same_object(&workspace.root_binding)
        {
            return Err("Workspace authorization does not match the selected root".into());
        }
        drop(state);
        if !workspace.root_binding.is_current(&workspace.root) {
            return Err("Workspace root changed after authorization".into());
        }
        Ok(())
    }

    fn authorized_workspace_directory_for_token(
        &self,
        workspace_token: &str,
        path: impl AsRef<Path>,
    ) -> Result<(PathBuf, AuthorizedWorkspace), String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_dir() {
            return Err("Path is not a directory".into());
        }
        let state = self.lock()?;
        let workspace = Self::workspace_for_token(&state, &token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if !path_is_under(&canonical, &workspace.root) {
            return Err("Directory is outside the selected workspace".into());
        }
        drop(state);
        if !workspace.root_binding.is_current(&workspace.root) {
            return Err("Workspace root changed after authorization".into());
        }
        Ok((canonical, workspace))
    }

    pub(crate) fn create_workspace_file(
        &self,
        workspace: &AuthorizedWorkspace,
        parent_path: impl AsRef<Path>,
        file_name: &str,
        create: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, AuthorizedFile), String> {
        let mut components = Path::new(file_name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err("Workspace entry name is invalid".into());
        }
        let parent = normalize_existing_path(parent_path)?;
        if !parent.is_dir() {
            return Err("Path is not a directory".into());
        }
        let target = parent.join(file_name);

        let mut state = self.lock()?;
        let active_workspace = Self::workspace_for_token(&state, &workspace.token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if active_workspace.root != workspace.root {
            return Err("Workspace authorization does not match the selected root".into());
        }
        if !path_is_under(&parent, &active_workspace.root) {
            return Err("Directory is outside the selected workspace".into());
        }
        if target.exists() {
            return Err("Workspace entry already exists".into());
        }

        let origin = GrantOrigin::CreatedDocument(state.allocate_document_grant_id()?);
        create(&target)?;
        Self::grant_exact_file(&mut state, &target, origin.clone(), true)?;

        Ok((active_workspace, AuthorizedFile::new(target, origin)))
    }

    pub(crate) fn create_workspace_directory(
        &self,
        workspace: &AuthorizedWorkspace,
        parent_path: impl AsRef<Path>,
        directory_name: &str,
        create: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, PathBuf), String> {
        let mut components = Path::new(directory_name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err("Workspace entry name is invalid".into());
        }
        let parent = normalize_existing_path(parent_path)?;
        if !parent.is_dir() {
            return Err("Path is not a directory".into());
        }
        let target = parent.join(directory_name);

        let state = self.lock()?;
        let active_workspace = Self::workspace_for_token(&state, &workspace.token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if active_workspace.root != workspace.root {
            return Err("Workspace authorization does not match the selected root".into());
        }
        if !path_is_under(&parent, &active_workspace.root) {
            return Err("Directory is outside the selected workspace".into());
        }
        if target.exists() {
            return Err("Workspace entry already exists".into());
        }

        create(&target)?;
        Ok((active_workspace, target))
    }

    fn workspace_entry_for_mutation_locked(
        state: &AuthorizationState,
        token: &WorkspaceToken,
        path: impl AsRef<Path>,
    ) -> Result<(PathBuf, AuthorizedWorkspace), String> {
        let workspace = Self::workspace_for_token(state, token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        let path = path.as_ref();
        reject_symlink_components_below_root(path, &workspace.root)?;
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() && !canonical.is_dir() {
            return Err("Workspace entry is not a file or directory".into());
        }
        if !path_is_under(&canonical, &workspace.root) {
            return Err("Workspace entry is outside the selected workspace".into());
        }
        if state
            .workspaces
            .keys()
            .filter_map(|active_token| Self::workspace_for_token(state, active_token))
            .any(|active_workspace| canonical == active_workspace.root)
        {
            return Err("Cannot modify workspace root".into());
        }
        Ok((canonical, workspace))
    }

    #[cfg(test)]
    fn workspace_entry_for_mutation(
        &self,
        token: &WorkspaceToken,
        path: impl AsRef<Path>,
    ) -> Result<(PathBuf, PathBuf), String> {
        let state = self.lock()?;
        let (entry, workspace) = Self::workspace_entry_for_mutation_locked(&state, token, path)?;
        Ok((entry, workspace.into_root()))
    }

    fn relocate_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        target_path: impl FnOnce(&Path, bool, &AuthorizedWorkspace) -> Result<PathBuf, String>,
        rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    ) -> Result<RenameWorkspaceEntryAuthorizationOutcome, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let mut state = self.lock()?;
        let (source, workspace) =
            Self::workspace_entry_for_mutation_locked(&state, &token, source_path)?;
        let is_file = source.is_file();
        let requested_target = target_path(&source, is_file, &workspace)?;
        let target_name = requested_target
            .file_name()
            .ok_or_else(|| "Workspace entry destination is invalid".to_string())?;
        let mut components = Path::new(target_name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err("Workspace entry name is invalid".into());
        }
        let requested_parent = requested_target
            .parent()
            .ok_or_else(|| "Workspace entry destination has no parent".to_string())?;
        let parent = normalize_existing_path(requested_parent)?;
        if !parent.is_dir() {
            return Err("Move destination is not a directory".into());
        }
        if !path_is_under(&parent, &workspace.root) {
            return Err("Move destination is outside the selected workspace".into());
        }
        if !is_file && path_is_under(&parent, &source) {
            return Err("Cannot move a folder into itself or one of its descendants".into());
        }
        let target = parent.join(target_name);
        if target == source {
            return Err("Workspace entry is already in that folder".into());
        }
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err("Workspace entry already exists".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot access rename destination: {error}")),
        }

        let entry = RenamedWorkspaceEntry {
            workspace,
            old_path: source,
            new_path: target,
            is_file,
        };
        match rename(&entry.old_path, &entry.new_path) {
            Ok(()) => {
                let invalidated_preview_leases =
                    state.relocate_path_prefix(&entry.old_path, &entry.new_path)?;
                Ok(RenameWorkspaceEntryAuthorizationOutcome::Committed {
                    renamed: entry,
                    invalidated_preview_leases,
                })
            }
            Err(operation_error) => {
                let transitioned_grants =
                    state.suspend_rename_path_prefixes(&entry.old_path, &entry.new_path)?;
                Ok(
                    RenameWorkspaceEntryAuthorizationOutcome::AwaitingObservation {
                        attempted: entry,
                        transitioned_grants,
                        operation_error,
                    },
                )
            }
        }
    }

    fn rename_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        new_name: impl FnOnce(&Path, bool) -> Result<String, String>,
        rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    ) -> Result<RenameWorkspaceEntryAuthorizationOutcome, String> {
        self.relocate_workspace_entry(
            workspace_token,
            source_path,
            |source, is_file, _workspace| {
                let target_name = new_name(source, is_file)?;
                let mut components = Path::new(&target_name).components();
                if target_name.contains('/')
                    || target_name.contains('\\')
                    || !matches!(components.next(), Some(Component::Normal(_)))
                    || components.next().is_some()
                {
                    return Err("Workspace entry name is invalid".into());
                }
                let parent = source
                    .parent()
                    .ok_or_else(|| "Workspace entry has no parent".to_string())?;
                Ok(parent.join(target_name))
            },
            rename,
        )
    }

    fn move_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        destination_parent_path: impl AsRef<Path>,
        rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    ) -> Result<RenameWorkspaceEntryAuthorizationOutcome, String> {
        let destination_parent = normalize_existing_path(destination_parent_path)?;
        if !destination_parent.is_dir() {
            return Err("Move destination is not a directory".into());
        }
        self.relocate_workspace_entry(
            workspace_token,
            source_path,
            move |source, _is_file, _workspace| {
                let name = source
                    .file_name()
                    .ok_or_else(|| "Workspace entry name is invalid".to_string())?;
                Ok(destination_parent.join(name))
            },
            rename,
        )
    }

    fn reconcile_rename_after_error(
        &self,
        attempted: RenamedWorkspaceEntry,
        transitioned_grants: HashSet<GrantKey>,
        operation_error: String,
        observation: RenameErrorObservation,
    ) -> Result<RenameWorkspaceEntryAuthorizationOutcome, String> {
        let mut state = self.lock()?;
        match observation {
            RenameErrorObservation::ConfirmedNotCommitted => {
                state.restore_rename_grants(&transitioned_grants)?;
                Ok(
                    RenameWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted {
                        message: operation_error,
                    },
                )
            }
            RenameErrorObservation::ConfirmedCommitted => {
                state.restore_rename_grants(&transitioned_grants)?;
                let invalidated_preview_leases =
                    state.relocate_path_prefix(&attempted.old_path, &attempted.new_path)?;
                Ok(RenameWorkspaceEntryAuthorizationOutcome::Committed {
                    renamed: attempted,
                    invalidated_preview_leases,
                })
            }
            RenameErrorObservation::Indeterminate { message } => {
                let invalidated_preview_leases = state
                    .finalize_indeterminate_rename(&attempted.old_path, &attempted.new_path)?;
                Ok(RenameWorkspaceEntryAuthorizationOutcome::Indeterminate {
                    attempted,
                    invalidated_preview_leases,
                    operation_error,
                    observation_message: message,
                })
            }
        }
    }

    #[cfg(test)]
    fn delete_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        delete: impl FnOnce(&Path, bool) -> Result<(), String>,
        observe_file_after_error: impl FnOnce(&Path) -> Result<DeleteFileObservation, String>,
    ) -> Result<DeleteWorkspaceEntryAuthorizationOutcome, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let mut state = self.lock()?;
        let (source, workspace) =
            Self::workspace_entry_for_mutation_locked(&state, &token, source_path)?;
        let is_file = source.is_file();
        let deleted = DeletedWorkspaceEntry {
            workspace,
            deleted_path: source,
            #[cfg(test)]
            is_file,
        };

        if let Err(message) = delete(&deleted.deleted_path, is_file) {
            if !is_file {
                let invalidated_preview_leases =
                    state.suspend_delete_path_prefix(&deleted.deleted_path)?;
                return Ok(DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
                    attempted: deleted,
                    invalidated_preview_leases,
                    operation_error: message,
                });
            }
            match observe_file_after_error(&deleted.deleted_path) {
                Ok(DeleteFileObservation::Present) => {
                    return Ok(
                        DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message },
                    );
                }
                Ok(DeleteFileObservation::Missing) => {}
                Err(observation_error) => {
                    let invalidated_preview_leases =
                        state.suspend_delete_path_prefix(&deleted.deleted_path)?;
                    return Ok(DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
                        attempted: deleted,
                        invalidated_preview_leases,
                        operation_error: format!(
                            "{message}; delete outcome observation failed: {observation_error}"
                        ),
                    });
                }
            }
        }
        let invalidated_preview_leases = state.revoke_path_prefix(&deleted.deleted_path)?;
        Ok(DeleteWorkspaceEntryAuthorizationOutcome::Committed {
            deleted,
            invalidated_preview_leases,
        })
    }

    fn trash_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        trash: impl FnOnce(&Path, bool) -> TrashAuthorizationDisposition,
    ) -> Result<DeleteWorkspaceEntryAuthorizationOutcome, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let mut state = self.lock()?;
        let (source, workspace) =
            Self::workspace_entry_for_mutation_locked(&state, &token, source_path)?;
        let is_file = source.is_file();
        let deleted = DeletedWorkspaceEntry {
            workspace,
            deleted_path: source,
            #[cfg(test)]
            is_file,
        };

        match trash(&deleted.deleted_path, is_file) {
            TrashAuthorizationDisposition::ConfirmedNotCommitted { message } => {
                Ok(DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message })
            }
            TrashAuthorizationDisposition::ConfirmedCommitted => {
                let invalidated_preview_leases = state.revoke_path_prefix(&deleted.deleted_path)?;
                Ok(DeleteWorkspaceEntryAuthorizationOutcome::Committed {
                    deleted,
                    invalidated_preview_leases,
                })
            }
            TrashAuthorizationDisposition::Indeterminate { message } => {
                let invalidated_preview_leases =
                    state.suspend_delete_path_prefix(&deleted.deleted_path)?;
                Ok(DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
                    attempted: deleted,
                    invalidated_preview_leases,
                    operation_error: message,
                })
            }
        }
    }

    fn relocate_path_prefix(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.relocate_path_prefix(old_prefix, new_prefix)
    }

    fn relocate_path_prefix_with_identity(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: &str,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        let current_identity = current_file_identity_for_origin(&state, new_prefix, None)
            .ok_or_else(|| "Renamed document could not be securely reidentified".to_string())?;
        if current_identity != expected_identity {
            return Err("Renamed document identity changed before authorization moved".into());
        }
        state.relocate_path_prefix_with_identity(old_prefix, new_prefix, Some(expected_identity))
    }

    fn relocate_path_prefix_with_workspace_authorization(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: &str,
        authorization: &WorkspaceReadAuthorization,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        if authorization.path != new_prefix
            || authorization.file_identity != expected_identity
            || !workspace_read_authorization_is_current(&state, authorization)
        {
            return Err("Renamed document identity changed before authorization moved".into());
        }
        state.relocate_path_prefix_with_identity(old_prefix, new_prefix, Some(expected_identity))
    }

    fn revoke_path_prefix(&self, prefix: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.revoke_path_prefix(prefix)
    }

    fn is_authorized_preview_asset(&self, canonical: &Path) -> Result<bool, String> {
        let state = self.lock()?;
        Ok(state.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && match key {
                    GrantKey::DirectoryRead(root) => {
                        path_is_under(canonical, root)
                            && directory_read_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::InternalAsset(root) => {
                        path_is_under(canonical, root)
                            && internal_asset_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::ExactReadWrite(_) => false,
                }
        }))
    }

    fn preview_scope_for(&self, file: impl AsRef<Path>) -> Result<AuthorizedPreviewScope, String> {
        let document = normalize_existing_path(file)?;
        if !document.is_file() {
            return Err("Path is not a file".into());
        }
        let mut state = self.lock()?;
        let document_origins = active_authority_origins_for_path(&state, &document);
        let root = state
            .grants
            .iter()
            .filter(|(_, ledger)| ledger.is_active())
            .filter_map(|(key, ledger)| match key {
                GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                    if path_is_under(&document, root)
                        && ledger_shares_current_origin(
                            &state,
                            root,
                            ledger,
                            &document_origins,
                        ) =>
                {
                    Some(root)
                }
                _ => None,
            })
            .max_by_key(|root| root.components().count())
            .cloned()
            .ok_or_else(|| {
                "File is outside the user-authorized session files and directories".to_string()
            })?;
        let lease = state.allocate_preview_lease(document.clone(), None)?;
        state.grant_once(
            GrantKey::InternalAsset(root.clone()),
            GrantOrigin::Preview(lease.clone()),
        )?;
        Ok(AuthorizedPreviewScope {
            document,
            root,
            lease,
        })
    }

    #[cfg(test)]
    fn preview_scope_for_anchored_file(
        &self,
        anchor: impl AsRef<Path>,
        file: impl AsRef<Path>,
    ) -> Result<AuthorizedPreviewScope, String> {
        self.preview_scope_for_anchored_file_with_root(anchor, file, None)
    }

    fn preview_scope_for_anchored_file_with_root(
        &self,
        anchor: impl AsRef<Path>,
        file: impl AsRef<Path>,
        workspace_root: Option<&Path>,
    ) -> Result<AuthorizedPreviewScope, String> {
        let anchor = normalize_existing_path(anchor)?;
        let document = normalize_existing_path(file)?;
        if !anchor.is_file() || !document.is_file() {
            return Err("Path is not a file".into());
        }
        let workspace_root = workspace_root.map(normalize_existing_path).transpose()?;
        if workspace_root.as_ref().is_some_and(|root| !root.is_dir()) {
            return Err("Workspace root is not a directory".into());
        }
        let mut state = self.lock()?;
        let anchor_origins = active_authority_origins_for_path(&state, &anchor);
        let root = if let Some(root) = workspace_root {
            if !path_is_under(&anchor, &root) || !path_is_under(&document, &root) {
                return Err("HTML embed escaped the authorized workspace".to_string());
            }
            let workspace_is_shared = state.grants.iter().any(|(key, ledger)| {
                ledger.is_active()
                    && matches!(key,
                        GrantKey::DirectoryRead(grant_root) | GrantKey::InternalAsset(grant_root)
                            if grant_root == &root)
                    && ledger_shares_current_origin(&state, &root, ledger, &anchor_origins)
            });
            if !workspace_is_shared {
                return Err(
                    "HTML embed workspace is not authorized by the Markdown file's active scope"
                        .to_string(),
                );
            }
            document
                .parent()
                .ok_or_else(|| "HTML embed file has no parent directory".to_string())?
                .to_path_buf()
        } else {
            let scope_is_authorized = state
                .grants
                .iter()
                .filter(|(_, ledger)| ledger.is_active())
                .any(|(key, ledger)| {
                    matches!(key,
                        GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                            if path_is_under(&anchor, root)
                                && path_is_under(&document, root)
                                && ledger_shares_current_origin(
                                    &state,
                                    root,
                                    ledger,
                                    &anchor_origins,
                                )
                    )
                });
            if !scope_is_authorized {
                return Err(
                    "HTML embed is outside the Markdown file's authorized scope".to_string()
                );
            }
            let root = anchor
                .parent()
                .ok_or_else(|| "Markdown file has no parent directory".to_string())?
                .to_path_buf();
            if !path_is_under(&document, &root) {
                return Err("HTML embed escaped the Markdown directory".to_string());
            }
            root
        };
        let lease = state.allocate_preview_lease(document.clone(), Some(anchor.clone()))?;
        state.grant_once(
            GrantKey::InternalAsset(root.clone()),
            GrantOrigin::Preview(lease.clone()),
        )?;
        Ok(AuthorizedPreviewScope {
            document,
            root,
            lease,
        })
    }

    fn preview_lease_support_statuses(
        &self,
        leases: &[&PreviewLeaseId],
    ) -> Result<Vec<bool>, String> {
        let state = self.lock()?;
        Ok(leases
            .iter()
            .map(|lease| state.preview_lease_is_active_and_supported(lease))
            .collect())
    }

    #[cfg(test)]
    fn revoke_origin(&self, origin: &GrantOrigin, mode: RevokeOriginMode) -> Result<(), String> {
        let mut state = self.lock()?;
        state.revoke_origin(origin, mode)?;
        Ok(())
    }

    fn retire_preview_leases(
        &self,
        leases: &HashSet<PreviewLeaseId>,
    ) -> Result<(), PreviewRetirementError> {
        if leases.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(error) = self
            .next_preview_retirement_unavailable_error
            .lock()
            .map_err(|_| {
                PreviewRetirementError::AuthorizationUnavailable(
                    "Preview retirement unavailable test seam is poisoned".to_string(),
                )
            })?
            .take()
        {
            return Err(PreviewRetirementError::AuthorizationUnavailable(error));
        }
        let mut state = self
            .lock()
            .map_err(PreviewRetirementError::AuthorizationUnavailable)?;
        #[cfg(test)]
        if let Some(error) = self
            .next_preview_retirement_error
            .lock()
            .map_err(|_| {
                PreviewRetirementError::Recoverable(
                    "Preview retirement test seam is poisoned".to_string(),
                )
            })?
            .take()
        {
            return Err(PreviewRetirementError::Recoverable(error));
        }
        let retiring = leases
            .iter()
            .filter(|lease| {
                let origin = GrantOrigin::Preview((*lease).clone());
                state
                    .grants
                    .values()
                    .any(|ledger| ledger.origins.contains_key(&origin))
            })
            .count() as u64;
        let next_generation = state
            .authorization_generation
            .checked_add(retiring)
            .ok_or_else(|| {
                PreviewRetirementError::AuthorizationUnavailable(
                    "Authorization generation is exhausted".to_string(),
                )
            })?;
        for lease in leases {
            state.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        state.authorization_generation = next_generation;
        Ok(())
    }

    #[cfg(test)]
    fn revoke_authorized_file(
        &self,
        file: &AuthorizedFile,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.revoke_origin_and_unsupported_previews(&file.origin, RevokeOriginMode::All)
    }
}

fn invalidate_preview_leases_after_authorization(
    state: &AppState,
    invalidated_preview_leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    match state
        .html_preview_server
        .invalidate_preview_leases(invalidated_preview_leases)
    {
        Ok(()) => Ok(()),
        Err(recovery) => {
            let (error, drained_leases) = recovery.into_parts();
            retire_preview_leases_inner(state, &drained_leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}

fn reconcile_indeterminate_write_with_preview_inner(
    state: &AppState,
    path: PathBuf,
    mut recovery_message: String,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> AuthorizedWriteOutcome {
    match state.file_authorization().suspend_write_file(&path) {
        Ok(invalidated_preview_leases) => {
            if let Err(cleanup_error) = invalidate_preview(&invalidated_preview_leases) {
                recovery_message.push_str(" Preview invalidation also failed: ");
                recovery_message.push_str(&cleanup_error);
            }
        }
        Err(authorization_error) => {
            let preview_shutdown = state.html_preview_server.stop_all_sites();
            recovery_message.push_str(" Authorization suspension also failed: ");
            recovery_message.push_str(&authorization_error);
            recovery_message.push_str(". All HTML preview sites were stopped.");
            if let Err(shutdown_error) = preview_shutdown {
                recovery_message.push_str(" Preview shutdown reported: ");
                recovery_message.push_str(&shutdown_error);
            }
        }
    }
    AuthorizedWriteOutcome::Indeterminate {
        path,
        recovery_message,
    }
}

fn write_authorized_document_with_preview_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    let path = state.file_authorization().write_document(path, preflight)?;
    match write(&path) {
        Ok(()) => Ok(AuthorizedWriteOutcome::Committed(path)),
        Err(recovery_message) => Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            recovery_message,
            invalidate_preview,
        )),
    }
}

pub(crate) fn write_authorized_document_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    write_authorized_document_with_preview_inner(
        state,
        path,
        preflight,
        write,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn save_document_as_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path) -> Result<(), String>,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWriteOutcome, String> {
    let path = state
        .file_authorization()
        .prepare_save_destination(path, preflight)?;
    if let Err(recovery_message) = write(&path) {
        return Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            recovery_message,
            |invalidated_preview_leases| {
                invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
            },
        ));
    }

    match state
        .file_authorization()
        .publish_save_destination(path.clone())
    {
        Ok(authorized) => Ok(AuthorizedWriteOutcome::Committed(authorized.into_path())),
        Err(error) => Ok(reconcile_indeterminate_write_with_preview_inner(
            state,
            path,
            format!(
                "File contents were written, but save-as authorization could not be committed: {error}. Reopen and inspect the file before retrying."
            ),
            |invalidated_preview_leases| {
                invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
            },
        )),
    }
}

fn finish_authorized_workspace_entry_relocation(
    state: &AppState,
    outcome: RenameWorkspaceEntryAuthorizationOutcome,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = match outcome {
        RenameWorkspaceEntryAuthorizationOutcome::AwaitingObservation {
            attempted,
            transitioned_grants,
            operation_error,
        } => {
            let observation = observe_after_error(&attempted);
            state.file_authorization().reconcile_rename_after_error(
                attempted,
                transitioned_grants,
                operation_error,
                observation,
            )?
        }
        outcome => outcome,
    };
    match outcome {
        RenameWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            Ok(AuthorizedRenameOutcome::ConfirmedNotCommitted { message })
        }
        RenameWorkspaceEntryAuthorizationOutcome::Committed {
            renamed,
            invalidated_preview_leases,
        } => match invalidate_preview(&invalidated_preview_leases) {
            Ok(()) => Ok(AuthorizedRenameOutcome::Committed(renamed)),
            Err(recovery_message) => Ok(AuthorizedRenameOutcome::RecoveryRequired {
                renamed,
                recovery_message,
            }),
        },
        RenameWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
            observation_message,
        } => {
            let mut recovery_message = format!(
                "Rename may have partially changed the workspace after an error: {operation_error}. Refresh and inspect both paths before retrying."
            );
            recovery_message.push_str(&observation_message);
            if let Err(cleanup_error) = invalidate_preview(&invalidated_preview_leases) {
                recovery_message.push_str(" Preview invalidation also failed: ");
                recovery_message.push_str(&cleanup_error);
            }
            Ok(AuthorizedRenameOutcome::Indeterminate {
                attempted,
                recovery_message,
            })
        }
        RenameWorkspaceEntryAuthorizationOutcome::AwaitingObservation { .. } => {
            unreachable!("rename observation must be reconciled before preview handling")
        }
    }
}

fn rename_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    new_name: impl FnOnce(&Path, bool) -> Result<String, String>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = state.file_authorization().rename_workspace_entry(
        workspace_token,
        source_path,
        new_name,
        rename,
    )?;
    finish_authorized_workspace_entry_relocation(
        state,
        outcome,
        observe_after_error,
        invalidate_preview,
    )
}

fn move_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedRenameOutcome, String> {
    let outcome = state.file_authorization().move_workspace_entry(
        workspace_token,
        source_path,
        destination_parent_path,
        rename,
    )?;
    finish_authorized_workspace_entry_relocation(
        state,
        outcome,
        observe_after_error,
        invalidate_preview,
    )
}

pub(crate) fn rename_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    new_name: impl FnOnce(&Path, bool) -> Result<String, String>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
) -> Result<AuthorizedRenameOutcome, String> {
    rename_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        new_name,
        rename,
        observe_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn move_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    rename: impl FnOnce(&Path, &Path) -> Result<(), String>,
    observe_after_error: impl FnOnce(&RenamedWorkspaceEntry) -> RenameErrorObservation,
) -> Result<AuthorizedRenameOutcome, String> {
    move_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        destination_parent_path,
        rename,
        observe_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

#[cfg(test)]
fn delete_authorized_workspace_entry_with_preview_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    delete: impl FnOnce(&Path, bool) -> Result<(), String>,
    observe_file_after_error: impl FnOnce(&Path) -> Result<DeleteFileObservation, String>,
    invalidate_preview: impl FnOnce(&HashSet<PreviewLeaseId>) -> Result<(), String>,
) -> Result<AuthorizedDeleteOutcome, String> {
    let outcome = state.file_authorization().delete_workspace_entry(
        workspace_token,
        source_path,
        delete,
        observe_file_after_error,
    )?;
    let (deleted, invalidated_preview_leases) = match outcome {
        DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            return Ok(AuthorizedDeleteOutcome::ConfirmedNotCommitted { message });
        }
        DeleteWorkspaceEntryAuthorizationOutcome::Committed {
            deleted,
            invalidated_preview_leases,
        } => (deleted, invalidated_preview_leases),
        DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
        } => {
            let (subject, location) = if attempted.is_file() {
                ("File", "file")
            } else {
                ("Directory", "directory")
            };
            let mut recovery_message = format!(
                "{subject} deletion may have partially changed the workspace after an error: {operation_error}. Refresh and inspect the {location} before retrying."
            );
            if let Err(cleanup_error) = invalidate_preview(&invalidated_preview_leases) {
                recovery_message.push_str(" Preview invalidation also failed: ");
                recovery_message.push_str(&cleanup_error);
            }
            return Ok(AuthorizedDeleteOutcome::Indeterminate {
                attempted,
                recovery_message,
            });
        }
    };
    match invalidate_preview(&invalidated_preview_leases) {
        Ok(()) => Ok(AuthorizedDeleteOutcome::Committed(deleted)),
        Err(recovery_message) => Ok(AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message,
        }),
    }
}

#[cfg(test)]
pub(crate) fn delete_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    delete: impl FnOnce(&Path, bool) -> Result<(), String>,
    observe_file_after_error: impl FnOnce(&Path) -> Result<DeleteFileObservation, String>,
) -> Result<AuthorizedDeleteOutcome, String> {
    delete_authorized_workspace_entry_with_preview_inner(
        state,
        workspace_token,
        source_path,
        delete,
        observe_file_after_error,
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, invalidated_preview_leases)
        },
    )
}

pub(crate) fn trash_authorized_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    trash: impl FnOnce(&Path, bool) -> TrashAuthorizationDisposition,
) -> Result<AuthorizedDeleteOutcome, String> {
    let outcome =
        state
            .file_authorization()
            .trash_workspace_entry(workspace_token, source_path, trash)?;
    let (deleted, invalidated_preview_leases) = match outcome {
        DeleteWorkspaceEntryAuthorizationOutcome::ConfirmedNotCommitted { message } => {
            return Ok(AuthorizedDeleteOutcome::ConfirmedNotCommitted { message });
        }
        DeleteWorkspaceEntryAuthorizationOutcome::Committed {
            deleted,
            invalidated_preview_leases,
        } => (deleted, invalidated_preview_leases),
        DeleteWorkspaceEntryAuthorizationOutcome::Indeterminate {
            attempted,
            invalidated_preview_leases,
            operation_error,
        } => {
            let mut recovery_message = operation_error;
            if invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
                .is_err()
            {
                recovery_message.push_str(
                    " Active previews also could not be retired; close preview windows before retrying.",
                );
            }
            return Ok(AuthorizedDeleteOutcome::Indeterminate {
                attempted,
                recovery_message,
            });
        }
    };
    match invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases) {
        Ok(()) => Ok(AuthorizedDeleteOutcome::Committed(deleted)),
        Err(_) => Ok(AuthorizedDeleteOutcome::RecoveryRequired {
            deleted,
            recovery_message:
                "The entry was moved to Trash, but active previews could not be retired. Close preview windows and refresh the workspace."
                    .to_string(),
        }),
    }
}

pub(crate) fn relocate_authorized_path_prefix_inner(
    state: &AppState,
    old_prefix: &Path,
    new_prefix: &Path,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            state
                .file_authorization()
                .relocate_path_prefix(old_prefix, new_prefix)
        },
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
        },
    )
}

pub(crate) fn relocate_authorized_path_prefix_with_identity_inner(
    state: &AppState,
    old_prefix: &Path,
    new_prefix: &Path,
    expected_identity: &str,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            state
                .file_authorization()
                .relocate_path_prefix_with_identity(old_prefix, new_prefix, expected_identity)
        },
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
        },
    )
}

pub(crate) fn relocate_authorized_path_prefix_with_workspace_authorization_inner(
    state: &AppState,
    old_prefix: &Path,
    new_prefix: &Path,
    expected_identity: &str,
    authorization: &WorkspaceReadAuthorization,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            state
                .file_authorization()
                .relocate_path_prefix_with_workspace_authorization(
                    old_prefix,
                    new_prefix,
                    expected_identity,
                    authorization,
                )
        },
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
        },
    )
}

#[cfg(test)]
pub(crate) fn commit_indeterminate_delete_inner(
    state: &AppState,
    deleted_path: &Path,
) -> Result<(), String> {
    let mut authorization = state.file_authorization().lock()?;
    authorization.revoke_path_prefix(deleted_path)?;
    Ok(())
}

pub(crate) fn apply_authorization_then_preview_invalidation<T, R>(
    authorization: impl FnOnce() -> Result<T, String>,
    preview: impl FnOnce(T) -> Result<R, String>,
) -> Result<R, String> {
    let authorized = authorization()?;
    preview(authorized)
}

pub(crate) fn revoke_authorized_path_prefix_inner(
    state: &AppState,
    prefix: &Path,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            let invalidated_preview_leases =
                state.file_authorization().revoke_path_prefix(prefix)?;
            state.workspace_index().discard_all();
            Ok(invalidated_preview_leases)
        },
        |invalidated_preview_leases| match state
            .html_preview_server
            .invalidate_preview_leases(&invalidated_preview_leases)
        {
            Ok(()) => Ok(()),
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_preview_leases_inner(state, &drained_leases)
                    .map_err(PreviewRetirementError::into_message)?;
                Err(error)
            }
        },
    )
}

#[cfg(test)]
pub(crate) fn revoke_authorized_file_inner(
    state: &AppState,
    file: &AuthorizedFile,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || state.file_authorization().revoke_authorized_file(file),
        |invalidated_preview_leases| match state
            .html_preview_server
            .invalidate_preview_leases(&invalidated_preview_leases)
        {
            Ok(()) => Ok(()),
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_preview_leases_inner(state, &drained_leases)
                    .map_err(PreviewRetirementError::into_message)?;
                Err(error)
            }
        },
    )
}

pub(crate) fn retire_preview_lease_inner(
    state: &AppState,
    lease: &PreviewLeaseId,
) -> Result<(), PreviewRetirementError> {
    retire_preview_leases_inner(state, &HashSet::from([lease.clone()]))
}

pub(crate) fn retire_preview_leases_inner(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), PreviewRetirementError> {
    state.file_authorization().retire_preview_leases(leases)
}

#[cfg(test)]
pub(crate) fn authorize_directory_root_inner(
    state: &AppState,
    root: PathBuf,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_directory_root(root)
        .map(AuthorizedWorkspace::into_root)
}

#[cfg(test)]
pub(crate) fn authorize_file_inner(state: &AppState, file: PathBuf) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_file(file)
        .map(AuthorizedFile::into_path)
}

#[cfg(test)]
pub(crate) fn authorize_saved_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .authorize_save_destination(path)
        .map(AuthorizedFile::into_path)
}

#[cfg(test)]
pub(crate) fn authorize_workspace_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state
        .file_authorization()
        .open_workspace_file(path)
        .map(AuthorizedFile::into_path)
}

pub(crate) fn ensure_authorized_existing_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_read(path)
}

pub(crate) fn open_authorized_existing_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<AuthorizedReadFile, String> {
    state.file_authorization().open_file_for_read(path)
}

pub(crate) fn open_exact_workspace_file_for_read_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<AuthorizedReadFile, String> {
    state
        .file_authorization()
        .open_exact_workspace_file_for_read(workspace_token, workspace_root, path)
}

pub(crate) fn open_authorized_existing_file_with_before_open_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    before_open: impl FnOnce(),
) -> Result<AuthorizedReadFile, String> {
    state
        .file_authorization()
        .open_file_for_read_with_before_open(path, before_open)
}

pub(crate) fn ensure_authorized_watch_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_watch(path)
}

#[cfg(test)]
pub(crate) fn ensure_authorized_write_file_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().file_for_write(path)
}

pub(crate) fn ensure_authorized_directory_inner(
    state: &AppState,
    path: impl AsRef<Path>,
) -> Result<PathBuf, String> {
    state.file_authorization().directory_for_read(path)
}

pub(crate) fn resolve_authorized_workspace_directory_for_token_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
) -> Result<(PathBuf, AuthorizedWorkspace), String> {
    state
        .file_authorization()
        .authorized_workspace_directory_for_token(workspace_token, path)
}

pub(crate) fn resolve_authorized_workspace_root_for_token_inner(
    state: &AppState,
    workspace_token: &str,
    root: impl AsRef<Path>,
) -> Result<AuthorizedWorkspace, String> {
    state
        .file_authorization()
        .authorized_workspace_root_for_token(workspace_token, root)
}

pub(crate) fn authorize_resource_directory_inner(
    state: &AppState,
    root: impl AsRef<Path>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AuthorizedWorkspace, String> {
    state
        .file_authorization()
        .open_resource_directory(root, transport)
}

/// Resolves an index result relative to one exact authorized workspace. Cached
/// result paths are hints only, so every path component is re-observed and
/// symbolic links are rejected before the existing authorization is reused.
pub(crate) fn resolve_authorized_workspace_result_file_inner(
    state: &AppState,
    workspace_token: &str,
    workspace_root: impl AsRef<Path>,
    relative_path: &str,
) -> Result<(AuthorizedWorkspace, PathBuf), String> {
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(state, workspace_token, workspace_root)?;
    let relative = Path::new(relative_path);
    if relative_path.is_empty() || relative.is_absolute() {
        return Err("Workspace search result path must be relative".to_string());
    }

    let mut candidate = workspace.root.clone();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err("Workspace search result path is invalid".to_string());
        };
        candidate.push(part);
        let metadata = std::fs::symlink_metadata(&candidate)
            .map_err(|error| format!("Workspace search result is no longer available: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Workspace search result cannot traverse a symbolic link".to_string());
        }
    }

    let canonical = normalize_existing_path(&candidate)?;
    if !canonical.is_file() || !path_is_under(&canonical, &workspace.root) {
        return Err("Workspace search result is outside the selected workspace".to_string());
    }
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    Ok((workspace, canonical))
}

#[cfg(test)]
pub(crate) fn is_authorized_image_path(state: &AppState, canonical: &Path) -> Result<bool, String> {
    is_authorized_preview_asset_path(state, canonical)
}

pub(crate) fn is_authorized_preview_asset_path(
    state: &AppState,
    canonical: &Path,
) -> Result<bool, String> {
    state
        .file_authorization()
        .is_authorized_preview_asset(canonical)
}

pub(crate) fn preview_scope_for_file_inner(
    state: &AppState,
    file: impl AsRef<Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state.file_authorization().preview_scope_for(file)
}

#[cfg(test)]
pub(crate) fn preview_scope_for_anchored_file_inner(
    state: &AppState,
    anchor: impl AsRef<Path>,
    file: impl AsRef<Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state
        .file_authorization()
        .preview_scope_for_anchored_file(anchor, file)
}

pub(crate) fn preview_scope_for_anchored_file_with_root_inner(
    state: &AppState,
    anchor: impl AsRef<Path>,
    file: impl AsRef<Path>,
    workspace_root: Option<&Path>,
) -> Result<AuthorizedPreviewScope, String> {
    state
        .file_authorization()
        .preview_scope_for_anchored_file_with_root(anchor, file, workspace_root)
}

pub(crate) fn preview_lease_support_statuses_inner(
    state: &AppState,
    leases: &[&PreviewLeaseId],
) -> Result<Vec<bool>, String> {
    state
        .file_authorization()
        .preview_lease_support_statuses(leases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_save::{DocumentSaveCoordinator, DocumentSaveDisposition, MAIN_SAVE_OWNER},
        durable_write::capture_file_version,
        html_preview_server::prepare_html_preview_inner,
    };
    use tempfile::tempdir;

    #[test]
    fn workspace_authorization_rejects_a_replaced_root_object() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let displaced = directory.path().join("displaced");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("note.md"), "same content").unwrap();
        let authorization = FileAuthorizationSession::default();
        let workspace = authorization.authorize_directory_root(&root).unwrap();
        let token = workspace.wire_token();
        let canonical_root = workspace.root().to_path_buf();

        fs::rename(&canonical_root, displaced).unwrap();
        fs::create_dir(&canonical_root).unwrap();
        fs::write(canonical_root.join("note.md"), "same content").unwrap();

        assert!(authorization
            .ensure_workspace_is_current(&workspace)
            .is_err());
        assert!(authorization
            .authorized_workspace_root_for_token(&token, &canonical_root)
            .is_err());
        assert!(authorization
            .file_for_read(canonical_root.join("note.md"))
            .is_err());
        assert!(authorization
            .file_for_watch(canonical_root.join("note.md"))
            .is_err());
        assert!(authorization.directory_for_read(&canonical_root).is_err());
        assert!(!authorization
            .is_authorized_preview_asset(&canonical_root.join("note.md"))
            .unwrap());
    }

    #[test]
    fn save_does_not_refresh_a_stale_workspace_origin_through_a_standalone_origin() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("note.md");
        let displaced = directory.path().join("displaced.md");
        fs::write(&document, "workspace object").unwrap();
        let state = AppState::default();
        state
            .file_authorization()
            .authorize_directory_root(directory.path())
            .unwrap();
        let workspace_open = state
            .file_authorization()
            .open_workspace_file(&document)
            .unwrap();

        fs::rename(&document, &displaced).unwrap();
        fs::write(&document, "standalone replacement").unwrap();
        let standalone_open = state
            .file_authorization()
            .authorize_file(&document)
            .unwrap();
        let expected = capture_file_version(&document).unwrap().unwrap();

        let disposition = DocumentSaveCoordinator::default()
            .save_expected(
                state.file_authorization(),
                &document,
                b"saved replacement",
                expected,
                "mixed-origin-save",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert!(matches!(
            disposition,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));

        state
            .file_authorization()
            .revoke_authorized_file(&standalone_open)
            .unwrap();
        assert!(state
            .file_authorization()
            .with_exact_write_authority(&document, |_, _| Ok(()))
            .is_err());
        drop(workspace_open);
    }

    #[test]
    fn standalone_open_document_keeps_its_existing_path_authority_contract() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("note.md");
        let displaced = directory.path().join("displaced.md");
        let asset = directory.path().join("image.png");
        fs::write(&document, "authorized content").unwrap();
        fs::write(&asset, b"image").unwrap();
        let authorization = FileAuthorizationSession::default();
        authorization.authorize_file(&document).unwrap();

        fs::rename(&document, &displaced).unwrap();
        fs::write(&document, "replacement content").unwrap();

        assert!(authorization.file_for_read(&document).is_ok());
        assert!(authorization.file_for_write(&document).is_ok());
        assert!(authorization
            .is_authorized_preview_asset(&asset.canonicalize().unwrap())
            .unwrap());
    }

    #[test]
    fn identity_bound_exact_read_rejects_replacement_before_handle_open() {
        let directory = tempdir().unwrap();
        let original = directory.path().join("original.md");
        let renamed = directory.path().join("renamed.md");
        let displaced = directory.path().join("displaced.md");
        fs::write(&original, "authorized content").unwrap();
        let canonical_original = normalize_existing_path(&original).unwrap();
        let authorization = FileAuthorizationSession::default();
        authorization.authorize_file(&original).unwrap();

        fs::rename(&original, &renamed).unwrap();
        let canonical_renamed = normalize_existing_path(&renamed).unwrap();
        let renamed_identity = current_file_identity_for_origin(
            &authorization.lock().unwrap(),
            &canonical_renamed,
            None,
        )
        .unwrap();
        authorization
            .relocate_path_prefix_with_identity(
                &canonical_original,
                &canonical_renamed,
                &renamed_identity,
            )
            .unwrap();

        let result = authorization.open_file_for_read_with_before_open(&canonical_renamed, || {
            fs::rename(&canonical_renamed, &displaced).unwrap();
            fs::write(&canonical_renamed, "replacement content").unwrap();
        });

        assert!(result.is_err());
    }

    #[test]
    fn revoking_a_workspace_open_document_removes_its_workspace_provenance() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("note.md");
        fs::write(&document, "authorized content").unwrap();
        let authorization = FileAuthorizationSession::default();
        authorization
            .authorize_directory_root(directory.path())
            .unwrap();
        let opened = authorization.open_workspace_file(&document).unwrap();

        assert_eq!(
            authorization
                .lock()
                .unwrap()
                .workspace_document_origins
                .len(),
            1
        );
        assert_eq!(
            authorization
                .lock()
                .unwrap()
                .document_origin_identities
                .len(),
            1
        );

        authorization
            .revoke_origin(opened.origin(), RevokeOriginMode::All)
            .unwrap();

        assert!(authorization
            .lock()
            .unwrap()
            .workspace_document_origins
            .is_empty());
        assert!(authorization
            .lock()
            .unwrap()
            .document_origin_identities
            .is_empty());
    }

    #[test]
    fn anchored_workspace_preview_lease_remains_supported() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let markdown = notes.join("notes.md");
        let html = notes.join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html).unwrap();
        let authorization = state.file_authorization().lock().unwrap();

        assert_eq!(scope.root(), normalize_existing_path(&notes).unwrap());
        assert!(!authorization
            .unsupported_preview_leases()
            .contains(scope.lease()));
    }

    #[test]
    fn workspace_anchored_embed_scope_is_limited_to_the_html_directory() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        let shared = workspace.path().join("shared");
        fs::create_dir(&notes).unwrap();
        fs::create_dir(&shared).unwrap();
        let markdown = notes.join("guide.md");
        let html = shared.join("embed.html");
        fs::write(&markdown, "# Guide").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let scope = preview_scope_for_anchored_file_with_root_inner(
            &state,
            &markdown,
            &html,
            Some(workspace.path()),
        )
        .unwrap();

        assert_eq!(scope.root(), normalize_existing_path(&shared).unwrap());
        assert!(!state
            .file_authorization()
            .lock()
            .unwrap()
            .unsupported_preview_leases()
            .contains(scope.lease()));
    }

    #[test]
    fn standalone_markdown_authorizes_a_sibling_embed_without_html_write_access() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, markdown.clone()).unwrap();

        let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html)
            .expect("the Markdown document's internal-asset authority should cover siblings");

        assert_eq!(
            scope.root(),
            normalize_existing_path(directory.path()).unwrap()
        );
        assert!(!state
            .file_authorization()
            .lock()
            .unwrap()
            .unsupported_preview_leases()
            .contains(scope.lease()));
        assert!(ensure_authorized_write_file_inner(&state, &html).is_err());
    }

    #[test]
    fn relocating_a_markdown_anchor_invalidates_its_embed_lease() {
        let workspace = tempdir().unwrap();
        let markdown = workspace.path().join("notes.md");
        let renamed_markdown = workspace.path().join("renamed.md");
        let html = workspace.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let canonical_markdown = normalize_existing_path(&markdown).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html).unwrap();
        let lease = scope.lease().clone();

        fs::rename(&markdown, &renamed_markdown).unwrap();
        let canonical_renamed_markdown = normalize_existing_path(&renamed_markdown).unwrap();
        let invalidated = state
            .file_authorization()
            .relocate_path_prefix(&canonical_markdown, &canonical_renamed_markdown)
            .unwrap();

        assert!(invalidated.contains(&lease));
    }

    #[test]
    fn normalize_new_path_rejects_parent_components() {
        let dir = tempdir().unwrap();
        assert!(normalize_parent_for_new_path(dir.path().join("ok.md")).is_ok());
        assert!(normalize_parent_for_new_path(dir.path().join("../bad.md")).is_err());
    }

    #[test]
    fn file_only_authorization_denies_sibling_read_and_write() {
        let dir = tempdir().unwrap();
        let allowed = dir.path().join("allowed.md");
        let sibling = dir.path().join("sibling.md");
        fs::write(&allowed, "# allowed").unwrap();
        fs::write(&sibling, "# sibling").unwrap();
        let state = AppState::default();

        let allowed_canonical = authorize_file_inner(&state, allowed).unwrap();
        assert_eq!(
            ensure_authorized_existing_file_inner(&state, &allowed_canonical).unwrap(),
            allowed_canonical
        );
        assert!(ensure_authorized_existing_file_inner(&state, &sibling).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &sibling).is_err());
    }

    #[test]
    fn prepared_open_document_grant_publishes_only_on_terminal_apply() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        let sibling = directory.path().join("sibling.md");
        fs::write(&document, "# document").unwrap();
        fs::write(&sibling, "# sibling").unwrap();
        let canonical_document = normalize_existing_path(&document).unwrap();
        let canonical_parent = canonical_document.parent().unwrap().to_path_buf();
        let state = AppState::default();

        let error = state
            .file_authorization()
            .with_prepared_open_document_grant(&canonical_document, |_prepared| {
                Err::<(), _>("injected pre-commit failure".to_string())
            })
            .unwrap_err();
        assert_eq!(error, "injected pre-commit failure");
        assert_eq!(
            state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(&canonical_document)
                .unwrap(),
            None
        );
        assert_eq!(
            state
                .file_authorization()
                .internal_asset_grant_snapshot_for_test(&canonical_parent)
                .unwrap(),
            None
        );

        state
            .file_authorization()
            .with_prepared_open_document_grant(&canonical_document, |prepared| {
                prepared.apply().unwrap();
                Ok(())
            })
            .unwrap();

        assert_eq!(
            state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(&canonical_document)
                .unwrap(),
            Some((GrantStatus::Active, 1))
        );
        assert_eq!(
            state
                .file_authorization()
                .internal_asset_grant_snapshot_for_test(&canonical_parent)
                .unwrap(),
            Some((GrantStatus::Active, 1))
        );
        assert_eq!(
            ensure_authorized_existing_file_inner(&state, &canonical_document).unwrap(),
            canonical_document
        );
        assert!(ensure_authorized_existing_file_inner(&state, &sibling).is_err());
    }

    #[cfg(feature = "packaged-lifecycle-e2e")]
    #[test]
    fn packaged_evidence_snapshot_reports_exact_active_grants_and_pending_workspace_receipts() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("evidence.md");
        fs::write(&document, "# evidence").unwrap();
        let canonical = normalize_existing_path(&document).unwrap();
        let state = AppState::default();

        let prepared = state
            .file_authorization()
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();
        let pending = state.file_authorization().evidence_snapshot().unwrap();
        assert_eq!(pending.pending_workspace_receipts, 1);
        assert!(pending.grants.is_empty());

        state
            .file_authorization()
            .with_prepared_open_document_grant(&canonical, |grant| {
                grant.apply().unwrap();
                Ok(())
            })
            .unwrap();
        let applied = state.file_authorization().evidence_snapshot().unwrap();
        assert!(applied.grants.iter().any(|grant| {
            grant.kind == "exact_rw"
                && grant.path == canonical.to_string_lossy()
                && grant.origin == "open_document"
                && grant.status == "active"
        }));
        assert_eq!(applied.pending_workspace_receipts, 1);

        assert_eq!(
            state
                .file_authorization()
                .settle_workspace_authorization("main", &prepared.receipt, false, |_| Ok(()))
                .unwrap(),
            PreparedWorkspaceSettlement::Discarded
        );
        assert_eq!(
            state
                .file_authorization()
                .evidence_snapshot()
                .unwrap()
                .pending_workspace_receipts,
            0
        );
    }

    #[cfg(feature = "packaged-lifecycle-e2e")]
    #[test]
    fn packaged_evidence_snapshot_aggregates_same_category_origins() {
        let directory = tempdir().unwrap();
        let first_document = directory.path().join("first.md");
        let second_document = directory.path().join("second.md");
        fs::write(&first_document, "# first").unwrap();
        fs::write(&second_document, "# second").unwrap();
        let state = AppState::default();

        let first_grant = state
            .file_authorization()
            .authorize_file(&first_document)
            .unwrap();
        let first_generation = state
            .file_authorization()
            .authorization_generation()
            .unwrap();
        let second_grant = state
            .file_authorization()
            .authorize_file(&second_document)
            .unwrap();

        let parent = normalize_existing_path(directory.path()).unwrap();
        let snapshot = state.file_authorization().evidence_snapshot().unwrap();
        assert!(first_generation > 0);
        assert!(snapshot.generation > first_generation);
        assert_eq!(
            snapshot
                .grants
                .iter()
                .filter(|grant| grant.kind == "exact_rw" && grant.origin == "open_document")
                .map(|grant| grant.count)
                .collect::<Vec<_>>(),
            vec![1, 1]
        );
        let shared_parent_grants = snapshot
            .grants
            .iter()
            .filter(|grant| {
                grant.kind == "internal_asset"
                    && grant.path == parent.to_string_lossy()
                    && grant.origin == "open_document"
                    && grant.status == "active"
            })
            .collect::<Vec<_>>();

        assert_eq!(shared_parent_grants.len(), 1);
        assert_eq!(shared_parent_grants[0].count, 2);

        state
            .file_authorization()
            .revoke_origin(first_grant.origin(), RevokeOriginMode::All)
            .unwrap();
        let after_first_revoke = state.file_authorization().evidence_snapshot().unwrap();
        assert!(after_first_revoke.generation > snapshot.generation);
        assert_eq!(
            after_first_revoke
                .grants
                .iter()
                .find(|grant| grant.kind == "internal_asset"
                    && grant.path == parent.to_string_lossy())
                .unwrap()
                .count,
            1
        );
        assert_eq!(
            after_first_revoke
                .grants
                .iter()
                .filter(|grant| grant.kind == "exact_rw")
                .count(),
            1
        );

        state
            .file_authorization()
            .revoke_origin(second_grant.origin(), RevokeOriginMode::All)
            .unwrap();
        let after_second_revoke = state.file_authorization().evidence_snapshot().unwrap();
        assert!(after_second_revoke.generation > after_first_revoke.generation);
        assert!(after_second_revoke.grants.is_empty());
    }

    #[test]
    fn authorization_generation_advances_for_grant_revoke_and_regrant() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let session = FileAuthorizationSession::default();

        assert_eq!(session.authorization_generation().unwrap(), 0);
        let first = session.authorize_file(&document).unwrap();
        let after_grant = session.authorization_generation().unwrap();
        assert!(after_grant > 0);

        session
            .revoke_origin(first.origin(), RevokeOriginMode::All)
            .unwrap();
        let after_revoke = session.authorization_generation().unwrap();
        assert!(after_revoke > after_grant);

        session.authorize_file(&document).unwrap();
        assert!(session.authorization_generation().unwrap() > after_revoke);
    }

    #[test]
    fn authorization_generation_tracks_suspend_restore_and_relocation() {
        let directory = tempdir().unwrap();
        let old = directory.path().join("old.md");
        let new = directory.path().join("new.md");
        fs::write(&old, "# document").unwrap();
        let canonical_old = normalize_existing_path(&old).unwrap();
        let session = FileAuthorizationSession::default();
        session.authorize_file(&old).unwrap();
        let after_grant = session.authorization_generation().unwrap();

        let transitioned = {
            let mut state = session.lock().unwrap();
            state
                .suspend_rename_path_prefixes(&canonical_old, &new)
                .unwrap()
        };
        let after_suspend = session.authorization_generation().unwrap();
        assert!(after_suspend > after_grant);

        {
            let mut state = session.lock().unwrap();
            state.restore_rename_grants(&transitioned).unwrap();
        }
        let after_restore = session.authorization_generation().unwrap();
        assert!(after_restore > after_suspend);

        fs::rename(&old, &new).unwrap();
        let canonical_new = normalize_existing_path(&new).unwrap();
        session
            .relocate_path_prefix(&canonical_old, &canonical_new)
            .unwrap();
        assert!(session.authorization_generation().unwrap() > after_restore);
    }

    #[test]
    fn authorization_generation_is_stable_for_reads_noops_and_failed_publication() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical = normalize_existing_path(&document).unwrap();
        let session = FileAuthorizationSession::default();
        let initial = session.authorization_generation().unwrap();

        assert!(session.file_for_read(&canonical).is_err());
        assert_eq!(session.authorization_generation().unwrap(), initial);
        session.revoke_path_prefix(&canonical).unwrap();
        assert_eq!(session.authorization_generation().unwrap(), initial);
        session
            .relocate_path_prefix(&canonical, &canonical)
            .unwrap();
        assert_eq!(session.authorization_generation().unwrap(), initial);
        assert!(session
            .authorize_directory_root_with(directory.path(), |_| Err("injected failure".into()))
            .is_err());
        assert_eq!(session.authorization_generation().unwrap(), initial);
    }

    #[test]
    fn authorization_generation_overflow_fails_closed_before_grant_mutation() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical = normalize_existing_path(&document).unwrap();
        let session = FileAuthorizationSession::default();
        session.lock().unwrap().authorization_generation = u64::MAX;

        let error = match session.authorize_file(&document) {
            Ok(_) => panic!("overflow must reject the grant"),
            Err(error) => error,
        };

        assert_eq!(error, "Authorization generation is exhausted");
        assert_eq!(session.authorization_generation().unwrap(), u64::MAX);
        assert_eq!(
            session
                .exact_write_grant_snapshot_for_test(&canonical)
                .unwrap(),
            None
        );
    }

    #[test]
    fn directory_authorization_allows_descendant_read_but_not_write_without_file_authorization() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("notes");
        fs::create_dir(&nested).unwrap();
        let doc = nested.join("doc.md");
        let new_doc = nested.join("new.md");
        fs::write(&doc, "# doc").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        assert!(ensure_authorized_existing_file_inner(&state, &doc).is_ok());
        assert!(ensure_authorized_write_file_inner(&state, &doc).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &new_doc).is_err());
    }

    #[test]
    fn failed_directory_authorization_grants_no_partial_capability() {
        let workspace = tempdir().unwrap();
        let document = workspace.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let state = AppState::default();

        let result = state
            .file_authorization()
            .authorize_directory_root_with(workspace.path(), |_| {
                Err("injected authorization commit failure".into())
            });

        assert!(result.is_err());
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
        assert!(!is_authorized_image_path(&state, &document).unwrap());
    }

    #[test]
    fn overlapping_origins_are_reference_counted() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("document.md");
        let asset = directory.path().join("asset.png");
        fs::write(&document, "# document").unwrap();
        fs::write(&asset, b"png").unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        let state = AppState::default();

        let first_open = state
            .file_authorization()
            .authorize_file(&document)
            .unwrap();
        let second_open = state
            .file_authorization()
            .authorize_file(&document)
            .unwrap();
        let save = state
            .file_authorization()
            .authorize_save_destination(&document)
            .unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(first_open.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(second_open.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(save.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
    }

    #[test]
    fn mixed_standalone_and_workspace_acquisitions_revoke_independently() {
        let workspace_root = tempdir().unwrap();
        let document = workspace_root.path().join("document.md");
        let asset = workspace_root.path().join("asset.png");
        fs::write(&document, "# document").unwrap();
        fs::write(&asset, b"png").unwrap();
        let canonical_root = normalize_existing_path(workspace_root.path()).unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        let state = AppState::default();

        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_root)
            .unwrap();
        let standalone = state
            .file_authorization()
            .authorize_file(&document)
            .unwrap();
        let workspace = state
            .file_authorization()
            .open_workspace_file(&document)
            .unwrap();

        assert_ne!(standalone.origin(), workspace.origin());

        let workspace_root_origin = GrantOrigin::Workspace(*authorized_workspace.token());
        state
            .file_authorization()
            .revoke_origin(&workspace_root_origin, RevokeOriginMode::All)
            .unwrap();
        state
            .file_authorization()
            .revoke_origin(workspace.origin(), RevokeOriginMode::All)
            .unwrap();

        assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(standalone.origin(), RevokeOriginMode::All)
            .unwrap();

        assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
    }

    #[test]
    fn mixed_standalone_and_workspace_acquisitions_revoke_independently_in_inverse_order() {
        let workspace_root = tempdir().unwrap();
        let document = workspace_root.path().join("document.md");
        let asset = workspace_root.path().join("asset.png");
        fs::write(&document, "# document").unwrap();
        fs::write(&asset, b"png").unwrap();
        let canonical_root = normalize_existing_path(workspace_root.path()).unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        let state = AppState::default();

        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_root)
            .unwrap();
        let standalone = state
            .file_authorization()
            .authorize_file(&document)
            .unwrap();
        let workspace = state
            .file_authorization()
            .open_workspace_file(&document)
            .unwrap();
        let workspace_root_origin = GrantOrigin::Workspace(*authorized_workspace.token());

        assert_ne!(standalone.origin(), workspace.origin());
        assert_ne!(standalone.origin(), &workspace_root_origin);
        assert_ne!(workspace.origin(), &workspace_root_origin);

        state
            .file_authorization()
            .revoke_origin(standalone.origin(), RevokeOriginMode::All)
            .unwrap();

        assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(workspace.origin(), RevokeOriginMode::All)
            .unwrap();

        assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
        assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(&workspace_root_origin, RevokeOriginMode::All)
            .unwrap();

        assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
    }

    #[test]
    fn workspace_entry_uses_explicit_token_not_first_matching_root() {
        let outer = tempdir().unwrap();
        let inner = outer.path().join("inner");
        let document = inner.join("document.md");
        fs::create_dir(&inner).unwrap();
        fs::write(&document, "# document").unwrap();
        let canonical_outer = normalize_existing_path(outer.path()).unwrap();
        let canonical_inner = normalize_existing_path(&inner).unwrap();
        let state = AppState::default();

        let outer_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_outer)
            .unwrap();
        let inner_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_inner)
            .unwrap();

        let (_, selected_outer) = state
            .file_authorization()
            .workspace_entry_for_mutation(outer_workspace.token(), &document)
            .unwrap();
        let (_, selected_inner) = state
            .file_authorization()
            .workspace_entry_for_mutation(inner_workspace.token(), &document)
            .unwrap();

        assert_eq!(selected_outer, canonical_outer);
        assert_eq!(selected_inner, canonical_inner);
    }

    #[cfg(windows)]
    #[test]
    fn canonical_verbatim_drive_workspace_entry_supports_mutation_validation() {
        let workspace = tempdir().unwrap();
        let document = workspace.path().join("document.md");
        fs::write(&document, "# document").unwrap();
        let canonical_root = normalize_existing_path(workspace.path()).unwrap();
        let canonical_document = normalize_existing_path(&document).unwrap();
        assert!(matches!(
            canonical_root.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        let state = AppState::default();
        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_root)
            .unwrap();

        let (entry, selected_root) = state
            .file_authorization()
            .workspace_entry_for_mutation(authorized_workspace.token(), &canonical_document)
            .unwrap();

        assert_eq!(entry, canonical_document);
        assert_eq!(selected_root, canonical_root);
    }

    #[cfg(windows)]
    #[test]
    fn canonical_verbatim_drive_workspace_entry_still_rejects_symlinks() {
        use std::os::windows::fs::symlink_file;

        let workspace = tempdir().unwrap();
        let target = workspace.path().join("target.md");
        let link = workspace.path().join("linked.md");
        fs::write(&target, "# target").unwrap();
        symlink_file(&target, &link).unwrap();
        let canonical_root = normalize_existing_path(workspace.path()).unwrap();
        assert!(matches!(
            canonical_root.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        let state = AppState::default();
        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_root)
            .unwrap();

        let error = state
            .file_authorization()
            .workspace_entry_for_mutation(
                authorized_workspace.token(),
                canonical_root.join("linked.md"),
            )
            .unwrap_err();

        assert_eq!(
            error,
            "Symbolic links cannot be modified as workspace entries"
        );
        assert_eq!(fs::read(target).unwrap(), b"# target");
    }

    #[test]
    fn cannot_select_any_active_workspace_root_as_a_mutation_target_through_an_overlap() {
        let outer = tempdir().unwrap();
        let inner = outer.path().join("inner");
        fs::create_dir(&inner).unwrap();
        let canonical_outer = normalize_existing_path(outer.path()).unwrap();
        let canonical_inner = normalize_existing_path(&inner).unwrap();
        let state = AppState::default();

        let outer_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_outer)
            .unwrap();
        state
            .file_authorization()
            .authorize_directory_root(&canonical_inner)
            .unwrap();

        assert!(state
            .file_authorization()
            .workspace_entry_for_mutation(outer_workspace.token(), &canonical_inner)
            .is_err());
    }

    #[test]
    fn rename_transaction_commits_filesystem_and_authorization_before_preview_invalidation() {
        use lock_order_test_probe::{trace, LockEvent};

        let workspace = tempdir().unwrap();
        let source = workspace.path().join("draft.html");
        fs::write(&source, "draft").unwrap();
        let state = AppState::default();
        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(workspace.path())
            .unwrap();
        state.file_authorization().authorize_file(&source).unwrap();
        prepare_html_preview_inner(&state, &source, "draft").unwrap();
        let canonical_source = source.canonicalize().unwrap();
        let target = canonical_source.with_file_name("renamed.html");

        let (outcome, events) = trace(|| {
            rename_authorized_workspace_entry_inner(
                &state,
                &authorized_workspace.wire_token(),
                &canonical_source,
                |entry, is_file| {
                    assert_eq!(entry, canonical_source);
                    assert!(is_file);
                    Ok("renamed.html".to_string())
                },
                |old_path, new_path| {
                    assert_eq!(old_path, canonical_source);
                    assert_eq!(new_path, target);
                    fs::rename(old_path, new_path)
                        .map_err(|err| format!("Failed to rename entry: {err}"))
                },
                |_| panic!("observation must not run after a successful rename"),
            )
        });

        let AuthorizedRenameOutcome::Committed(renamed) = outcome.unwrap() else {
            panic!("expected committed rename outcome");
        };
        assert_eq!(
            renamed.workspace().wire_token(),
            authorized_workspace.wire_token()
        );
        assert_eq!(renamed.old_path(), canonical_source);
        assert_eq!(renamed.new_path(), target);
        assert!(renamed.is_file());
        assert!(!canonical_source.exists());
        assert!(target.is_file());
        assert!(ensure_authorized_write_file_inner(&state, &target).is_ok());
        assert!(ensure_authorized_write_file_inner(&state, &canonical_source).is_err());
        assert_eq!(
            events,
            [
                LockEvent::AuthorizationAcquired,
                LockEvent::AuthorizationReleased,
                LockEvent::HtmlSitesAcquired,
                LockEvent::HtmlSitesReleased,
            ]
        );
    }

    #[test]
    fn rename_transaction_returns_recovery_required_for_post_commit_preview_failure() {
        let workspace = tempdir().unwrap();
        let source = workspace.path().join("draft.md");
        fs::write(&source, "draft").unwrap();
        let state = AppState::default();
        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(workspace.path())
            .unwrap();
        let canonical_source = source.canonicalize().unwrap();
        let target = canonical_source.with_file_name("renamed.md");

        let outcome = rename_authorized_workspace_entry_with_preview_inner(
            &state,
            &authorized_workspace.wire_token(),
            &source,
            |_, is_file| {
                assert!(is_file);
                Ok("renamed.md".to_string())
            },
            |old_path, new_path| {
                fs::rename(old_path, new_path)
                    .map_err(|err| format!("Failed to rename entry: {err}"))
            },
            |_| panic!("observation must not run after a successful rename"),
            |_| Err("injected post-commit preview failure".to_string()),
        )
        .unwrap();

        let AuthorizedRenameOutcome::RecoveryRequired {
            renamed,
            recovery_message,
        } = outcome
        else {
            panic!("expected recovery-required rename outcome");
        };
        assert_eq!(renamed.old_path(), canonical_source);
        assert_eq!(renamed.new_path(), target);
        assert!(target.is_file());
        assert_eq!(recovery_message, "injected post-commit preview failure");
    }

    #[test]
    fn rename_transaction_rejects_a_valid_token_for_another_workspace_before_commit() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let source = second.path().join("draft.md");
        fs::write(&source, "draft").unwrap();
        let state = AppState::default();
        let first_workspace = state
            .file_authorization()
            .authorize_directory_root(first.path())
            .unwrap();
        state
            .file_authorization()
            .authorize_directory_root(second.path())
            .unwrap();
        let rename_calls = std::cell::Cell::new(0);

        let error = match rename_authorized_workspace_entry_inner(
            &state,
            &first_workspace.wire_token(),
            &source,
            |_, _| Ok("renamed.md".to_string()),
            |_, _| {
                rename_calls.set(rename_calls.get() + 1);
                Ok(())
            },
            |_| panic!("observation must not run before filesystem mutation"),
        ) {
            Ok(_) => panic!("wrong-workspace rename must fail before commit"),
            Err(error) => error,
        };

        assert_eq!(error, "Workspace entry is outside the selected workspace");
        assert_eq!(rename_calls.get(), 0);
        assert!(source.is_file());
        assert!(!second.path().join("renamed.md").exists());
    }

    #[test]
    fn relocate_prefix_relocates_every_descendant_capability_and_revokes_old_prefix() {
        let container = tempdir().unwrap();
        let old_root = container.path().join("old");
        let old_document = old_root.join("nested/document.md");
        let old_asset = old_root.join("nested/asset.png");
        fs::create_dir_all(old_document.parent().unwrap()).unwrap();
        fs::write(&old_document, "# document").unwrap();
        fs::write(&old_asset, b"png").unwrap();
        let canonical_old_root = normalize_existing_path(&old_root).unwrap();
        let state = AppState::default();
        let workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_old_root)
            .unwrap();
        state
            .file_authorization()
            .authorize_file(&old_document)
            .unwrap();

        let new_root = container.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let canonical_new_root = normalize_existing_path(&new_root).unwrap();
        let new_document = canonical_new_root.join("nested/document.md");
        let new_asset = canonical_new_root.join("nested/asset.png");
        state
            .file_authorization()
            .relocate_path_prefix(&canonical_old_root, &canonical_new_root)
            .unwrap();

        assert!(state
            .file_authorization()
            .workspace_entry_for_mutation(workspace.token(), &new_document)
            .is_ok());
        assert!(ensure_authorized_existing_file_inner(&state, &new_document).is_ok());
        assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
        assert!(
            is_authorized_image_path(&state, &normalize_existing_path(&new_asset).unwrap())
                .unwrap()
        );

        fs::create_dir_all(old_document.parent().unwrap()).unwrap();
        fs::write(&old_document, "# recreated").unwrap();
        fs::write(&old_asset, b"recreated").unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &old_document).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &old_document).is_err());
        assert!(
            !is_authorized_image_path(&state, &normalize_existing_path(&old_asset).unwrap())
                .unwrap()
        );
    }

    #[test]
    fn revoke_prefix_purges_exact_and_descendant_capabilities() {
        let directory = tempdir().unwrap();
        let retained_directory = tempdir().unwrap();
        let revoked_root = directory.path().join("revoked");
        let nested = revoked_root.join("nested");
        let first_document = revoked_root.join("first.md");
        let second_document = nested.join("second.md");
        let first_asset = revoked_root.join("first.png");
        let second_asset = nested.join("second.png");
        let retained_document = retained_directory.path().join("retained.md");
        fs::create_dir_all(&nested).unwrap();
        fs::write(&first_document, "# first").unwrap();
        fs::write(&second_document, "# second").unwrap();
        fs::write(&first_asset, b"first").unwrap();
        fs::write(&second_asset, b"second").unwrap();
        fs::write(&retained_document, "# retained").unwrap();
        let canonical_revoked_root = normalize_existing_path(&revoked_root).unwrap();
        let canonical_first_asset = normalize_existing_path(&first_asset).unwrap();
        let canonical_second_asset = normalize_existing_path(&second_asset).unwrap();
        let state = AppState::default();
        state
            .file_authorization()
            .authorize_file(&first_document)
            .unwrap();
        state
            .file_authorization()
            .authorize_file(&second_document)
            .unwrap();
        state
            .file_authorization()
            .authorize_file(&retained_document)
            .unwrap();

        state
            .file_authorization()
            .revoke_path_prefix(&canonical_revoked_root)
            .unwrap();

        assert!(ensure_authorized_existing_file_inner(&state, &first_document).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &first_document).is_err());
        assert!(ensure_authorized_existing_file_inner(&state, &second_document).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &second_document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_first_asset).unwrap());
        assert!(!is_authorized_image_path(&state, &canonical_second_asset).unwrap());
        assert!(ensure_authorized_write_file_inner(&state, &retained_document).is_ok());
    }

    #[test]
    fn relocate_prefix_preserves_all_origins_without_collapsing_provenance() {
        let container = tempdir().unwrap();
        let old_root = container.path().join("old");
        let new_root = container.path().join("new");
        let old_document = old_root.join("document.md");
        let new_document = new_root.join("document.md");
        let new_asset = new_root.join("asset.png");
        fs::create_dir_all(&old_root).unwrap();
        fs::create_dir_all(&new_root).unwrap();
        fs::write(&old_document, "# old").unwrap();
        fs::write(&new_document, "# new").unwrap();
        fs::write(&new_asset, b"png").unwrap();
        let canonical_old_root = normalize_existing_path(&old_root).unwrap();
        let canonical_new_root = normalize_existing_path(&new_root).unwrap();
        let canonical_new_asset = normalize_existing_path(&new_asset).unwrap();
        let state = AppState::default();

        let source_open = state
            .file_authorization()
            .authorize_file(&old_document)
            .unwrap();
        let source_save = state
            .file_authorization()
            .authorize_save_destination(&old_document)
            .unwrap();
        let destination_open = state
            .file_authorization()
            .authorize_file(&new_document)
            .unwrap();

        state
            .file_authorization()
            .relocate_path_prefix(&canonical_old_root, &canonical_new_root)
            .unwrap();

        state
            .file_authorization()
            .revoke_origin(source_open.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_new_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(destination_open.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
        assert!(is_authorized_image_path(&state, &canonical_new_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(source_save.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(ensure_authorized_write_file_inner(&state, &new_document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_new_asset).unwrap());
    }

    #[test]
    fn relocate_prefix_does_not_reactivate_suspended_collision_origins() {
        let old_root = PathBuf::from("/workspace/old");
        let new_root = PathBuf::from("/workspace/new");
        let old_key = GrantKey::ExactReadWrite(old_root.join("document.md"));
        let new_key = GrantKey::ExactReadWrite(new_root.join("document.md"));
        let active_origin = GrantOrigin::OpenDocument(DocumentGrantId(1));
        let suspended_origin = GrantOrigin::SaveAs(DocumentGrantId(2));
        let mut state = AuthorizationState::default();
        state.grant(old_key, active_origin.clone()).unwrap();
        state
            .grant(new_key.clone(), suspended_origin.clone())
            .unwrap();
        state.grants.get_mut(&new_key).unwrap().suspend();

        state.relocate_path_prefix(&old_root, &new_root).unwrap();

        let relocated = state.grants.get(&new_key).unwrap();
        assert_eq!(relocated.status, GrantStatus::Active);
        assert_eq!(relocated.origins, HashMap::from([(active_origin, 1)]));
        assert!(!relocated.origins.contains_key(&suspended_origin));
    }

    #[test]
    fn revoke_prefix_preserves_ancestor_workspace_grant() {
        let workspace = tempdir().unwrap();
        let document = workspace.path().join("document.md");
        let sibling = workspace.path().join("sibling.md");
        let asset = workspace.path().join("asset.png");
        fs::write(&document, "# document").unwrap();
        fs::write(&sibling, "# sibling").unwrap();
        fs::write(&asset, b"png").unwrap();
        let canonical_root = normalize_existing_path(workspace.path()).unwrap();
        let canonical_document = normalize_existing_path(&document).unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        let state = AppState::default();

        let authorized_workspace = state
            .file_authorization()
            .authorize_directory_root(&canonical_root)
            .unwrap();
        state
            .file_authorization()
            .authorize_file(&canonical_document)
            .unwrap();

        state
            .file_authorization()
            .revoke_path_prefix(&canonical_document)
            .unwrap();

        assert!(ensure_authorized_write_file_inner(&state, &canonical_document).is_err());
        assert!(ensure_authorized_existing_file_inner(&state, &canonical_document).is_ok());
        assert!(state
            .file_authorization()
            .workspace_entry_for_mutation(authorized_workspace.token(), &sibling)
            .is_ok());
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());
    }

    #[test]
    fn published_workspace_ledger_does_not_retain_root_handles() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();

        let workspace = session.authorize_directory_root(directory.path()).unwrap();

        assert_eq!(Arc::strong_count(&workspace.root_binding.handle), 1);
        assert_eq!(session.lock().unwrap().workspaces.len(), 1);
    }

    #[test]
    fn preview_internal_asset_origins_are_reference_counted_and_revocable() {
        let directory = tempdir().unwrap();
        let first_document = directory.path().join("first.html");
        let second_document = directory.path().join("second.html");
        let asset = directory.path().join("asset.png");
        fs::write(&first_document, "first").unwrap();
        fs::write(&second_document, "second").unwrap();
        fs::write(&asset, b"png").unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        let state = AppState::default();

        let first_document_grant = state
            .file_authorization()
            .authorize_file(&first_document)
            .unwrap();
        let second_document_grant = state
            .file_authorization()
            .authorize_file(&second_document)
            .unwrap();
        let (_, _, first_preview_lease) = state
            .file_authorization()
            .preview_scope_for(&first_document)
            .unwrap()
            .into_parts();
        let (_, _, second_preview_lease) = state
            .file_authorization()
            .preview_scope_for(&second_document)
            .unwrap()
            .into_parts();
        let canonical_root = normalize_existing_path(directory.path()).unwrap();
        let preview_origin_count = || {
            state
                .file_authorization()
                .lock()
                .unwrap()
                .grants
                .get(&GrantKey::InternalAsset(canonical_root.clone()))
                .unwrap()
                .origins
                .keys()
                .filter(|origin| matches!(origin, GrantOrigin::Preview(_)))
                .count()
        };

        assert_eq!(preview_origin_count(), 2);

        state
            .file_authorization()
            .revoke_origin(
                &GrantOrigin::Preview(first_preview_lease),
                RevokeOriginMode::All,
            )
            .unwrap();
        assert_eq!(preview_origin_count(), 1);

        state
            .file_authorization()
            .revoke_origin(
                &GrantOrigin::Preview(second_preview_lease),
                RevokeOriginMode::All,
            )
            .unwrap();
        assert_eq!(preview_origin_count(), 0);
        assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

        state
            .file_authorization()
            .revoke_origin(first_document_grant.origin(), RevokeOriginMode::All)
            .unwrap();
        state
            .file_authorization()
            .revoke_origin(second_document_grant.origin(), RevokeOriginMode::All)
            .unwrap();
        assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
    }

    #[test]
    fn revoke_prefix_and_origin_revocation_invalidate_unsupported_preview_sites() {
        let workspace = tempdir().unwrap();
        let removed_root = workspace.path().join("removed");
        fs::create_dir(&removed_root).unwrap();
        let removed_document = removed_root.join("index.html");
        let retained_document = workspace.path().join("retained.html");
        fs::write(&removed_document, "removed").unwrap();
        fs::write(&retained_document, "retained").unwrap();
        let canonical_removed_root = normalize_existing_path(&removed_root).unwrap();
        let canonical_removed_document = normalize_existing_path(&removed_document).unwrap();
        let canonical_retained_document = normalize_existing_path(&retained_document).unwrap();
        let state = AppState::default();
        state
            .file_authorization()
            .authorize_directory_root(workspace.path())
            .unwrap();
        prepare_html_preview_inner(&state, &removed_document, "removed").unwrap();
        prepare_html_preview_inner(&state, &retained_document, "retained").unwrap();

        fs::remove_dir_all(&removed_root).unwrap();
        revoke_authorized_path_prefix_inner(&state, &canonical_removed_root).unwrap();

        let documents = state.html_preview_server.site_documents().unwrap();
        assert!(!documents.contains(&canonical_removed_document));
        assert!(documents.contains(&canonical_retained_document));

        let standalone = tempdir().unwrap();
        let standalone_document = standalone.path().join("standalone.html");
        let standalone_asset = standalone.path().join("asset.png");
        fs::write(&standalone_document, "standalone").unwrap();
        fs::write(&standalone_asset, b"png").unwrap();
        let canonical_standalone_document = normalize_existing_path(&standalone_document).unwrap();
        let canonical_standalone_asset = normalize_existing_path(&standalone_asset).unwrap();
        let authorized_file = state
            .file_authorization()
            .authorize_file(&standalone_document)
            .unwrap();
        prepare_html_preview_inner(&state, &standalone_document, "standalone").unwrap();

        revoke_authorized_file_inner(&state, &authorized_file).unwrap();

        assert!(!state
            .html_preview_server
            .site_documents()
            .unwrap()
            .contains(&canonical_standalone_document));
        assert!(!is_authorized_image_path(&state, &canonical_standalone_asset).unwrap());
    }

    #[test]
    fn authorization_and_preview_operations_obey_one_lock_order() {
        use lock_order_test_probe::{trace, LockEvent};

        fn assert_authorization_then_preview<T>(operation: impl FnOnce() -> Result<T, String>) {
            let (result, events) = trace(operation);
            result.unwrap();
            assert_eq!(
                events,
                [
                    LockEvent::AuthorizationAcquired,
                    LockEvent::AuthorizationReleased,
                    LockEvent::HtmlSitesAcquired,
                    LockEvent::HtmlSitesReleased,
                ]
            );
        }

        fn assert_preview_prepare_lock_order<T>(operation: impl FnOnce() -> Result<T, String>) {
            let (result, events) = trace(operation);
            result.unwrap();
            assert_eq!(
                events,
                [
                    LockEvent::AuthorizationAcquired,
                    LockEvent::AuthorizationReleased,
                    LockEvent::HtmlSitesAcquired,
                    LockEvent::HtmlSitesReleased,
                    LockEvent::AuthorizationAcquired,
                    LockEvent::AuthorizationReleased,
                ]
            );
        }

        let prepare_dir = tempdir().unwrap();
        let prepare_document = prepare_dir.path().join("prepare.html");
        fs::write(&prepare_document, "prepare").unwrap();
        let prepare_state = AppState::default();
        prepare_state
            .file_authorization()
            .authorize_file(&prepare_document)
            .unwrap();
        assert_preview_prepare_lock_order(|| {
            prepare_html_preview_inner(&prepare_state, &prepare_document, "prepare")
        });

        let relocate_dir = tempdir().unwrap();
        let old_root = relocate_dir.path().join("old");
        fs::create_dir(&old_root).unwrap();
        let old_document = old_root.join("relocate.html");
        fs::write(&old_document, "relocate").unwrap();
        let canonical_old_root = normalize_existing_path(&old_root).unwrap();
        let relocate_state = AppState::default();
        relocate_state
            .file_authorization()
            .authorize_file(&old_document)
            .unwrap();
        prepare_html_preview_inner(&relocate_state, &old_document, "relocate").unwrap();
        let new_root = relocate_dir.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let canonical_new_root = normalize_existing_path(&new_root).unwrap();
        assert_authorization_then_preview(|| {
            relocate_authorized_path_prefix_inner(
                &relocate_state,
                &canonical_old_root,
                &canonical_new_root,
            )
        });

        let revoke_prefix_dir = tempdir().unwrap();
        let revoke_prefix_root = revoke_prefix_dir.path().join("workspace");
        fs::create_dir(&revoke_prefix_root).unwrap();
        let revoke_prefix_document = revoke_prefix_root.join("revoke-prefix.html");
        fs::write(&revoke_prefix_document, "revoke prefix").unwrap();
        let canonical_revoke_prefix = normalize_existing_path(&revoke_prefix_root).unwrap();
        let revoke_prefix_state = AppState::default();
        revoke_prefix_state
            .file_authorization()
            .authorize_directory_root(&revoke_prefix_root)
            .unwrap();
        prepare_html_preview_inner(
            &revoke_prefix_state,
            &revoke_prefix_document,
            "revoke prefix",
        )
        .unwrap();
        assert_authorization_then_preview(|| {
            revoke_authorized_path_prefix_inner(&revoke_prefix_state, &canonical_revoke_prefix)
        });

        let revoke_file_dir = tempdir().unwrap();
        let revoke_file_document = revoke_file_dir.path().join("revoke-file.html");
        fs::write(&revoke_file_document, "revoke file").unwrap();
        let revoke_file_state = AppState::default();
        let authorized_file = revoke_file_state
            .file_authorization()
            .authorize_file(&revoke_file_document)
            .unwrap();
        prepare_html_preview_inner(&revoke_file_state, &revoke_file_document, "revoke file")
            .unwrap();
        assert_authorization_then_preview(|| {
            revoke_authorized_file_inner(&revoke_file_state, &authorized_file)
        });
    }

    #[test]
    fn stale_invalidation_cannot_remove_reprepared_same_path_site() {
        use std::{
            io::{Read, Write},
            net::TcpStream,
        };

        let workspace = tempdir().unwrap();
        let document = workspace.path().join("index.html");
        fs::write(&document, "old generation").unwrap();
        let canonical_document = normalize_existing_path(&document).unwrap();
        let state = AppState::default();
        state
            .file_authorization()
            .authorize_directory_root(workspace.path())
            .unwrap();
        let old_url = prepare_html_preview_inner(&state, &document, "old generation").unwrap();

        let stale_leases = state
            .file_authorization()
            .revoke_path_prefix(&canonical_document)
            .unwrap();
        assert_eq!(stale_leases.len(), 1);

        let (new_url, reprepare_events) = lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &document, "new generation")
        });
        let new_url = new_url.unwrap();
        state
            .html_preview_server
            .invalidate_preview_leases(&stale_leases)
            .unwrap();

        assert!(
            state
                .html_preview_server
                .site_documents()
                .unwrap()
                .contains(&canonical_document),
            "stale invalidation removed the re-prepared same-path site"
        );
        assert_eq!(new_url, old_url);
        let address_and_path = new_url.strip_prefix("http://").unwrap();
        let (address, path) = address_and_path.split_once('/').unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET /{path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("new generation"));
        assert_eq!(
            reprepare_events,
            [
                lock_order_test_probe::LockEvent::AuthorizationAcquired,
                lock_order_test_probe::LockEvent::AuthorizationReleased,
                lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                lock_order_test_probe::LockEvent::HtmlSitesReleased,
                lock_order_test_probe::LockEvent::AuthorizationAcquired,
                lock_order_test_probe::LockEvent::AuthorizationReleased,
                lock_order_test_probe::LockEvent::AuthorizationAcquired,
                lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn directory_snapshot_failure_consumes_candidate_and_publishes_nothing() {
        use std::cell::Cell;

        let workspace = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let snapshot_calls = Cell::new(0);
        let transport_calls = Cell::new(0);

        let result = session.open_workspace(
            workspace.path(),
            |source| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                let WorkspaceSnapshotSource::Candidate(candidate) = source else {
                    panic!("initial workspace snapshot must receive a candidate");
                };
                assert_eq!(candidate.root, workspace.path().canonicalize().unwrap());
                Err::<(), _>("injected first snapshot failure".to_string())
            },
            |_| {
                transport_calls.set(transport_calls.get() + 1);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(snapshot_calls.get(), 1);
        assert_eq!(transport_calls.get(), 0);
        let state = session.lock().unwrap();
        assert!(state.workspaces.is_empty());
        assert!(state.grants.is_empty());
        assert_eq!(state.next_workspace_token_id, 0);
    }

    #[test]
    fn persisted_workspace_restore_rejects_a_retargeted_root_before_snapshot_or_grant() {
        use std::cell::Cell;

        let expected = tempdir().unwrap();
        let retargeted = tempdir().unwrap();
        let expected_root = expected.path().canonicalize().unwrap();
        let session = FileAuthorizationSession::default();
        let snapshot_calls = Cell::new(0);
        let transport_calls = Cell::new(0);

        let result = session.open_workspace_at_canonical_root(
            retargeted.path(),
            &expected_root,
            |_| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                Ok(())
            },
            |_| {
                transport_calls.set(transport_calls.get() + 1);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(snapshot_calls.get(), 0);
        assert_eq!(transport_calls.get(), 0);
        let state = session.lock().unwrap();
        assert!(state.workspaces.is_empty());
        assert!(state.grants.is_empty());
    }

    #[test]
    fn directory_transport_failure_publishes_no_workspace_token_or_application_grant() {
        use std::cell::Cell;

        let workspace = tempdir().unwrap();
        let canonical_workspace = workspace.path().canonicalize().unwrap();
        let session = FileAuthorizationSession::default();
        let snapshot_calls = Cell::new(0);
        let transport_calls = Cell::new(0);

        let result = session.open_workspace(
            workspace.path(),
            |source| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                let WorkspaceSnapshotSource::Candidate(candidate) = source else {
                    panic!("initial workspace snapshot must receive a candidate");
                };
                assert_eq!(candidate.root, canonical_workspace);
                Ok(())
            },
            |root| {
                transport_calls.set(transport_calls.get() + 1);
                assert_eq!(root, canonical_workspace);
                Err("injected directory transport failure".to_string())
            },
        );
        let error = match result {
            Ok(_) => panic!("transport failure must prevent workspace publication"),
            Err(error) => error,
        };

        assert_eq!(error, "injected directory transport failure");
        assert_eq!(snapshot_calls.get(), 1);
        assert_eq!(transport_calls.get(), 1);
        let state = session.lock().unwrap();
        assert!(state.workspaces.is_empty());
        assert!(state.grants.is_empty());
        assert_eq!(state.next_workspace_token_id, 0);
    }

    #[test]
    fn monotonic_transport_is_not_treated_as_application_authorization() {
        use std::cell::RefCell;

        let directory = tempdir().unwrap();
        let document = directory.path().join("index.html");
        let asset = directory.path().join("asset.png");
        fs::write(&document, "before").unwrap();
        fs::write(&asset, b"png").unwrap();
        let state = AppState::default();
        let transport_roots = RefCell::new(HashSet::new());

        let result = state.file_authorization().open_standalone_file(
            &document,
            |_| Ok(()),
            |parent| {
                transport_roots.borrow_mut().insert(parent.to_path_buf());
                Err("transport reported failure after allowing parent".to_string())
            },
        );
        assert!(result.is_err());

        fs::remove_file(&document).unwrap();
        fs::write(&document, "recreated").unwrap();
        let canonical_document = normalize_existing_path(&document).unwrap();
        let canonical_asset = normalize_existing_path(&asset).unwrap();
        assert!(transport_roots
            .borrow()
            .iter()
            .any(|root| path_is_under(&canonical_document, root)));
        assert!(ensure_authorized_existing_file_inner(&state, &canonical_document).is_err());
        assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
        assert!(prepare_html_preview_inner(&state, &canonical_document, "recreated").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_authorization_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let outside_doc = outside.path().join("outside.md");
        let linked_doc = workspace.path().join("linked.md");
        fs::write(&outside_doc, "# outside").unwrap();
        symlink(&outside_doc, &linked_doc).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        assert!(ensure_authorized_existing_file_inner(&state, &linked_doc).is_err());
        assert!(ensure_authorized_write_file_inner(&state, &linked_doc).is_err());
    }

    #[test]
    fn save_as_exact_path_allows_later_write_only_for_that_path() {
        let dir = tempdir().unwrap();
        let saved = dir.path().join("saved.md");
        let sibling = dir.path().join("sibling.md");
        fs::write(&sibling, "# sibling").unwrap();
        let state = AppState::default();
        let authorized = authorize_saved_file_inner(&state, &saved).unwrap();

        assert_eq!(
            ensure_authorized_write_file_inner(&state, &saved).unwrap(),
            authorized
        );
        assert!(ensure_authorized_write_file_inner(&state, &sibling).is_err());
    }

    #[test]
    fn confirmed_external_missing_revokes_exact_grant_and_preview_but_allows_reauthorization() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("draft.html");
        fs::write(&document, "saved").unwrap();
        let state = AppState::default();
        let canonical = authorize_file_inner(&state, document.clone()).unwrap();
        prepare_html_preview_inner(&state, &canonical, "live draft").unwrap();

        fs::remove_file(&canonical).unwrap();
        assert_eq!(
            ensure_authorized_watch_file_inner(&state, &canonical).unwrap(),
            canonical
        );
        revoke_authorized_path_prefix_inner(&state, &canonical).unwrap();

        assert!(ensure_authorized_watch_file_inner(&state, &canonical).is_err());
        assert!(state
            .html_preview_server
            .site_documents()
            .unwrap()
            .is_empty());

        fs::write(&canonical, "recreated").unwrap();
        assert!(ensure_authorized_existing_file_inner(&state, &canonical).is_err());
        assert_eq!(
            authorize_file_inner(&state, canonical.clone()).unwrap(),
            canonical
        );
    }

    #[test]
    fn confirmed_external_missing_preserves_ancestor_workspace_authorization() {
        let workspace = tempdir().unwrap();
        let document = workspace.path().join("draft.md");
        fs::write(&document, "before").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let canonical = authorize_workspace_file_inner(&state, &document).unwrap();

        fs::remove_file(&canonical).unwrap();
        revoke_authorized_path_prefix_inner(&state, &canonical).unwrap();
        fs::write(&canonical, "after").unwrap();

        assert_eq!(
            authorize_workspace_file_inner(&state, &canonical).unwrap(),
            canonical
        );
    }

    #[test]
    fn prepared_workspace_is_not_authorized_until_the_frontend_applies_it() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |source| {
                Ok(match source {
                    WorkspaceSnapshotSource::Candidate(candidate) => candidate.root.clone(),
                    WorkspaceSnapshotSource::Authorized(workspace) => workspace.root.clone(),
                })
            })
            .unwrap();
        let token = prepared.workspace.wire_token();
        let root = prepared.workspace.root().to_path_buf();

        assert!(session
            .authorized_workspace_root_for_token(&token, &root)
            .is_err());
        assert_eq!(
            session
                .pending_workspace_authority_count_for_test()
                .unwrap(),
            1
        );

        assert_eq!(
            session
                .settle_workspace_authorization("main", &prepared.receipt, true, |_| Ok(()))
                .unwrap(),
            PreparedWorkspaceSettlement::Applied
        );
        assert_eq!(
            session
                .authorized_workspace_root_for_token(&token, &root)
                .unwrap()
                .root(),
            root
        );
        assert_eq!(
            session
                .pending_workspace_authority_count_for_test()
                .unwrap(),
            0
        );
    }

    #[test]
    fn discarded_workspace_receipt_removes_only_its_reservation() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let existing = session.authorize_directory_root(directory.path()).unwrap();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();

        assert_eq!(
            session
                .settle_workspace_authorization("main", &prepared.receipt, false, |_| {
                    panic!("discard must not invoke transport")
                })
                .unwrap(),
            PreparedWorkspaceSettlement::Discarded
        );
        assert!(session
            .authorized_workspace_root_for_token(&existing.wire_token(), existing.root(),)
            .is_ok());
        assert!(session
            .authorized_workspace_root_for_token(
                &prepared.workspace.wire_token(),
                prepared.workspace.root(),
            )
            .is_err());
    }

    #[test]
    fn expired_workspace_receipt_cannot_publish_authorization() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();
        session
            .expire_workspace_authority_for_test(&prepared.receipt)
            .unwrap();

        assert_eq!(
            session
                .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
                    panic!("expired receipt must not invoke transport")
                })
                .unwrap(),
            PreparedWorkspaceSettlement::Expired
        );
        assert!(session
            .authorized_workspace_root_for_token(
                &prepared.workspace.wire_token(),
                prepared.workspace.root(),
            )
            .is_err());
    }

    #[test]
    fn workspace_receipt_is_owner_bound_without_consuming_the_valid_owner_claim() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();

        assert!(session
            .settle_workspace_authorization("child", &prepared.receipt, false, |_| Ok(()))
            .is_err());
        assert_eq!(
            session
                .settle_workspace_authorization("main", &prepared.receipt, false, |_| Ok(()))
                .unwrap(),
            PreparedWorkspaceSettlement::Discarded
        );
    }

    #[test]
    fn workspace_transport_failure_revokes_exactly_the_prepared_workspace_origin() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let existing = session.authorize_directory_root(directory.path()).unwrap();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();

        assert_eq!(
            session
                .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
                    Err("asset scope unavailable".to_string())
                })
                .unwrap_err(),
            "asset scope unavailable"
        );
        assert!(session
            .authorized_workspace_root_for_token(&existing.wire_token(), existing.root(),)
            .is_ok());
        assert!(session
            .authorized_workspace_root_for_token(
                &prepared.workspace.wire_token(),
                prepared.workspace.root(),
            )
            .is_err());
    }

    #[test]
    fn workspace_root_is_reobserved_before_prepared_authorization_is_published() {
        let directory = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let prepared = session
            .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
            .unwrap();
        fs::remove_dir(directory.path()).unwrap();

        assert!(session
            .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
                panic!("stale workspace must not invoke transport")
            })
            .is_err());
        assert!(session
            .authorized_workspace_root_for_token(
                &prepared.workspace.wire_token(),
                prepared.workspace.root(),
            )
            .is_err());
        assert_eq!(
            session
                .pending_workspace_authority_count_for_test()
                .unwrap(),
            0
        );
    }
}
