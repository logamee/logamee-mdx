#[allow(unused_imports)]
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use notify::{ RecommendedWatcher };

#[allow(unused_imports)]
#[allow(unused_imports)]
use crate::{
    commands::{
        opened_file_platform_identity,
    },
    workspace_index::{build_index, CancellationToken, IndexDocument, WorkspaceIndex},
    workspace_snapshot::{is_excluded_walk_dir, MAX_WORKSPACE_INDEX_WALK_ENTRIES},
};

const MAX_ACTIVE_OPERATIONS: usize = 16;
const MAX_OPERATION_DURATION: Duration = Duration::from_secs(30);
const MAX_BUILD_RECONCILIATION_PASSES: usize = 2;

#[derive(Clone, Debug)]
struct WorkspaceIndexScope {
    workspace_token: String,
    workspace_root: PathBuf,
    workspace_root_identity: String,
    _workspace_root_handle: Arc<File>,
    generation: u64,
}

impl PartialEq for WorkspaceIndexScope {
    fn eq(&self, other: &Self) -> bool {
        self.workspace_token == other.workspace_token
            && self.workspace_root == other.workspace_root
            && self.workspace_root_identity == other.workspace_root_identity
            && self.generation == other.generation
    }
}

impl Eq for WorkspaceIndexScope {}

struct StoredWorkspaceIndex {
    index: Arc<WorkspaceIndex>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperationKind {
    Rebuild,
    Query,
}

struct ActiveOperation {
    scope: WorkspaceIndexScope,
    kind: OperationKind,
    cancellation: CancellationToken,
}

struct ActiveWorkspaceIndex {
    scope: WorkspaceIndexScope,
    index: Option<StoredWorkspaceIndex>,
    dirty_during_build: bool,
}

trait WatchHandlePort: Send {
    fn stop(&mut self);
}

struct NativeWatchHandle {
    watcher: Option<RecommendedWatcher>,
}

impl WatchHandlePort for NativeWatchHandle {
    fn stop(&mut self) {
        self.watcher.take();
    }
}

impl Drop for NativeWatchHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
struct RuntimeState {
    active: Option<ActiveWorkspaceIndex>,
    operations: std::collections::HashMap<String, ActiveOperation>,
    watcher: Option<Box<dyn WatchHandlePort>>,
    next_generation: u64,
}

/// A generation-bound operation lease. A completion must be discarded unless
/// the same scope and generation remain current when it is published.
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceIndexLease {
    pub(crate) workspace_token: String,
    pub(crate) workspace_root: PathBuf,
    workspace_root_identity: String,
    workspace_root_handle: Arc<File>,
    pub(crate) generation: u64,
    pub(crate) cancellation: CancellationToken,
    deadline: Instant,
}

impl WorkspaceIndexLease {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled() || Instant::now() >= self.deadline
    }
}

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceIndexQueryLease {
    pub(crate) lease: WorkspaceIndexLease,
    pub(crate) index: Arc<WorkspaceIndex>,
}

pub(crate) struct WorkspaceIndexRuntime {
    state: Arc<Mutex<RuntimeState>>,
}

impl Default for WorkspaceIndexRuntime {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState::default())),
        }
    }
}

impl WorkspaceIndexRuntime {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, RuntimeState>, String> {
        self.state
            .lock()
            .map_err(|_| "Workspace index state is unavailable".to_string())
    }

    pub(crate) fn begin_query(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        operation_id: &str,
    ) -> Result<WorkspaceIndexQueryLease, String> {
        validate_operation_id(operation_id)?;
        let mut state = self.lock()?;
        if state.operations.contains_key(operation_id) {
            return Err("Workspace index operation is already active".to_string());
        }
        if state.operations.len() >= MAX_ACTIVE_OPERATIONS {
            return Err("Too many workspace index operations are active".to_string());
        }
        let active = state
            .active
            .as_ref()
            .filter(|active| scope_matches(&active.scope, workspace_token, workspace_root))
            .ok_or_else(|| "Workspace index does not match the selected workspace".to_string())?;
        let scope = active.scope.clone();
        if !workspace_root_matches_scope(&scope) {
            invalidate_locked(&mut state, &scope)?;
            return Err("Workspace root changed after the index was built".to_string());
        }
        let stored = active
            .index
            .as_ref()
            .ok_or_else(|| "Workspace index has not been built".to_string())?;
        let index = Arc::clone(&stored.index);

        // Search is latest-wins within one workspace; a newer keystroke must not
        // leave an older response eligible to update the dialog.
        cancel_operations(&mut state.operations, Some((&scope, OperationKind::Query)));
        let (cancellation, deadline) = new_deadline_bound_cancellation();
        state.operations.insert(
            operation_id.to_string(),
            ActiveOperation {
                scope: scope.clone(),
                kind: OperationKind::Query,
                cancellation: cancellation.clone(),
            },
        );
        Ok(WorkspaceIndexQueryLease {
            lease: WorkspaceIndexLease {
                workspace_token: scope.workspace_token,
                workspace_root: scope.workspace_root,
                workspace_root_identity: scope.workspace_root_identity,
                workspace_root_handle: Arc::clone(&scope._workspace_root_handle),
                generation: scope.generation,
                cancellation,
                deadline,
            },
            index,
        })
    }

}


fn invalidate_exact_binding(
    state: &Arc<Mutex<RuntimeState>>,
    scope: &WorkspaceIndexScope,
    clear_active: bool,
) {
    let Ok(mut state) = state.lock() else {
        return;
    };
    if !state
        .active
        .as_ref()
        .is_some_and(|active| active.scope == *scope)
    {
        return;
    }
    if invalidate_locked(&mut state, scope).is_ok() && clear_active {
        state.active = None;
    }
}

fn invalidate_locked(state: &mut RuntimeState, scope: &WorkspaceIndexScope) -> Result<(), String> {
    let generation = allocate_generation(state, scope.generation)?;
    let active = state
        .active
        .as_mut()
        .ok_or_else(|| "Workspace index is not active".to_string())?;
    active.scope.generation = generation;
    active.index = None;
    cancel_operations(&mut state.operations, Some((scope, OperationKind::Rebuild)));
    cancel_operations(&mut state.operations, Some((scope, OperationKind::Query)));
    Ok(())
}

fn allocate_generation(state: &mut RuntimeState, floor: u64) -> Result<u64, String> {
    let generation = state
        .next_generation
        .max(floor)
        .checked_add(1)
        .ok_or_else(|| "Workspace index generation is exhausted".to_string())?;
    state.next_generation = generation;
    Ok(generation)
}

fn scope_matches(
    scope: &WorkspaceIndexScope,
    workspace_token: &str,
    workspace_root: &Path,
) -> bool {
    scope.workspace_token == workspace_token && scope.workspace_root == workspace_root
}

fn lease_matches(scope: &WorkspaceIndexScope, lease: &WorkspaceIndexLease) -> bool {
    scope.generation == lease.generation
        && scope.workspace_token == lease.workspace_token
        && scope.workspace_root == lease.workspace_root
}

fn cancel_operations(
    operations: &mut std::collections::HashMap<String, ActiveOperation>,
    filter: Option<(&WorkspaceIndexScope, OperationKind)>,
) {
    for operation in operations.values() {
        if filter.is_none_or(|(scope, kind)| operation.kind == kind && operation.scope == *scope) {
            operation.cancellation.cancel();
        }
    }
}

pub(super) fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Workspace index operation ID is invalid".to_string());
    }
    Ok(())
}

pub(crate) fn new_deadline_bound_cancellation() -> (CancellationToken, Instant) {
    let deadline = Instant::now() + MAX_OPERATION_DURATION;
    let cancellation = CancellationToken::with_deadline(deadline);
    (cancellation, deadline)
}


#[cfg(test)]
mod discard_tests;
#[cfg(test)]
mod lease_tests;
#[cfg(test)]
mod tests;
mod begin;
mod events;
mod publish;
mod watch;

#[allow(unused_imports)]
use events::{event_path_matches_published_index, event_paths_are_benign_directory_metadata, event_paths_are_relevant_before_publication, event_paths_match_published_index, file_matches_expected_content, lease_scope, workspace_matches_index, workspace_root_matches_scope};
#[cfg(test)]
use watch::handle_native_watch_result;
use watch::stop_watch;
