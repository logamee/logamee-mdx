use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use walkdir::WalkDir;

use crate::{
    commands::{
        open_directory_without_following_links, open_regular_file_without_following_links,
        opened_file_platform_identity,
    },
    workspace_file_kind::WorkspaceFileKind,
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

    pub(crate) fn begin_rebuild(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        operation_id: &str,
    ) -> Result<WorkspaceIndexLease, String> {
        self.begin_rebuild_with_watch(workspace_token, workspace_root, operation_id, true)
    }

    #[cfg(test)]
    pub(crate) fn begin_rebuild_without_watch_for_test(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        operation_id: &str,
    ) -> Result<WorkspaceIndexLease, String> {
        self.begin_rebuild_with_watch(workspace_token, workspace_root, operation_id, false)
    }

    fn begin_rebuild_with_watch(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        operation_id: &str,
        install_native_watch: bool,
    ) -> Result<WorkspaceIndexLease, String> {
        validate_operation_id(operation_id)?;
        let workspace_root_handle = Arc::new(
            open_directory_without_following_links(workspace_root)
                .map_err(|error| format!("Could not bind the workspace root: {error}"))?,
        );
        let workspace_root_identity = opened_file_platform_identity(&workspace_root_handle)
            .map_err(|error| format!("Could not identify the workspace root: {error}"))?;
        let (scope, cancellation, deadline, previous_watcher) = {
            let mut state = self.lock()?;
            if state.operations.contains_key(operation_id) {
                return Err("Workspace index operation is already active".to_string());
            }
            if state.operations.len() >= MAX_ACTIVE_OPERATIONS {
                return Err("Too many workspace index operations are active".to_string());
            }

            cancel_operations(&mut state.operations, None);
            let generation = allocate_generation(&mut state, 0)?;
            let scope = WorkspaceIndexScope {
                workspace_token: workspace_token.to_string(),
                workspace_root: workspace_root.to_path_buf(),
                workspace_root_identity,
                _workspace_root_handle: Arc::clone(&workspace_root_handle),
                generation,
            };
            let previous_watcher = state.watcher.take();
            state.active = Some(ActiveWorkspaceIndex {
                scope: scope.clone(),
                index: None,
                dirty_during_build: false,
            });
            let (cancellation, deadline) = new_deadline_bound_cancellation();
            state.operations.insert(
                operation_id.to_string(),
                ActiveOperation {
                    scope: scope.clone(),
                    kind: OperationKind::Rebuild,
                    cancellation: cancellation.clone(),
                },
            );
            (scope, cancellation, deadline, previous_watcher)
        };
        stop_watch(previous_watcher);

        if !install_native_watch {
            return Ok(WorkspaceIndexLease {
                workspace_token: scope.workspace_token,
                workspace_root: scope.workspace_root,
                workspace_root_identity: scope.workspace_root_identity,
                workspace_root_handle,
                generation: scope.generation,
                cancellation,
                deadline,
            });
        }

        let watcher =
            match create_native_watch(workspace_root, Arc::downgrade(&self.state), scope.clone()) {
                Ok(watcher) => watcher,
                Err(error) => {
                    invalidate_exact_binding(&self.state, &scope, true);
                    self.end_operation(operation_id);
                    return Err(error);
                }
            };
        let mut state = self.lock()?;
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.scope == scope)
        {
            state.watcher = Some(Box::new(watcher));
        }
        drop(state);
        Ok(WorkspaceIndexLease {
            workspace_token: scope.workspace_token,
            workspace_root: scope.workspace_root,
            workspace_root_identity: scope.workspace_root_identity,
            workspace_root_handle,
            generation: scope.generation,
            cancellation,
            deadline,
        })
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

    pub(crate) fn publish_rebuild(
        &self,
        lease: &WorkspaceIndexLease,
        index: WorkspaceIndex,
    ) -> Result<bool, String> {
        self.publish_rebuild_with_reconcile_hook(lease, index, || {})
    }

    fn publish_rebuild_with_reconcile_hook(
        &self,
        lease: &WorkspaceIndexLease,
        index: WorkspaceIndex,
        mut before_reconcile: impl FnMut(),
    ) -> Result<bool, String> {
        let index = Arc::new(index);
        let mut reconciliation_passes = 0usize;
        loop {
            let scope = lease_scope(lease);
            if !workspace_root_matches_scope(&scope) {
                invalidate_exact_binding(&self.state, &scope, false);
                return Ok(false);
            }
            {
                let mut state = self.lock()?;
                let Some(active) = state.active.as_mut() else {
                    return Ok(false);
                };
                if !lease_matches(&active.scope, lease) || lease.is_cancelled() {
                    return Ok(false);
                }
                if !active.dirty_during_build {
                    active.index = Some(StoredWorkspaceIndex {
                        index: Arc::clone(&index),
                    });
                    return Ok(true);
                }
                if reconciliation_passes >= MAX_BUILD_RECONCILIATION_PASSES {
                    drop(state);
                    invalidate_exact_binding(&self.state, &lease_scope(lease), false);
                    return Ok(false);
                }
                active.dirty_during_build = false;
            }
            reconciliation_passes = reconciliation_passes.saturating_add(1);
            before_reconcile();
            if !workspace_matches_index(&lease_scope(lease), &index, Some(lease)) {
                invalidate_exact_binding(&self.state, &lease_scope(lease), false);
                return Ok(false);
            }
        }
    }

    pub(crate) fn is_current(&self, lease: &WorkspaceIndexLease) -> Result<bool, String> {
        let scope = {
            let state = self.lock()?;
            state
                .active
                .as_ref()
                .filter(|active| {
                    active.index.is_some()
                        && lease_matches(&active.scope, lease)
                        && !lease.is_cancelled()
                })
                .map(|active| active.scope.clone())
        };
        Ok(scope.is_some_and(|scope| {
            let current = workspace_root_matches_scope(&scope);
            if !current {
                invalidate_exact_binding(&self.state, &scope, false);
            }
            current
        }))
    }

    pub(crate) fn current_generation(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
    ) -> Result<Option<u64>, String> {
        let state = self.lock()?;
        Ok(state
            .active
            .as_ref()
            .filter(|active| scope_matches(&active.scope, workspace_token, workspace_root))
            .map(|active| active.scope.generation))
    }

    pub(crate) fn is_result_current(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        generation: u64,
    ) -> Result<bool, String> {
        let scope = {
            let state = self.lock()?;
            state
                .active
                .as_ref()
                .filter(|active| {
                    active.index.is_some()
                        && active.scope.generation == generation
                        && scope_matches(&active.scope, workspace_token, workspace_root)
                })
                .map(|active| active.scope.clone())
        };
        Ok(scope.is_some_and(|scope| {
            let current = workspace_root_matches_scope(&scope);
            if !current {
                invalidate_exact_binding(&self.state, &scope, false);
            }
            current
        }))
    }

    pub(crate) fn invalidate(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
    ) -> Result<bool, String> {
        let watcher = {
            let mut state = self.lock()?;
            let Some(active) = state
                .active
                .as_ref()
                .filter(|active| scope_matches(&active.scope, workspace_token, workspace_root))
            else {
                return Ok(false);
            };
            let scope = active.scope.clone();
            invalidate_locked(&mut state, &scope)?;
            state.watcher.take()
        };
        stop_watch(watcher);
        Ok(true)
    }

    pub(crate) fn discard(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
    ) -> Result<bool, String> {
        self.invalidate(workspace_token, workspace_root)
    }

    pub(crate) fn discard_all(&self) {
        let watcher = {
            let Ok(mut state) = self.lock() else {
                return;
            };
            cancel_operations(&mut state.operations, None);
            state.active = None;
            state.watcher.take()
        };
        stop_watch(watcher);
    }

    pub(crate) fn cancel_operation(&self, operation_id: &str) -> Result<bool, String> {
        validate_operation_id(operation_id)?;
        let cancellation = self
            .lock()?
            .operations
            .get(operation_id)
            .map(|operation| operation.cancellation.clone());
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn end_operation(&self, operation_id: &str) {
        if let Ok(mut state) = self.lock() {
            state.operations.remove(operation_id);
        }
    }

    #[cfg(test)]
    fn install_watch_for_test(&self, watcher: Box<dyn WatchHandlePort>) {
        self.state.lock().unwrap().watcher = Some(watcher);
    }
}

fn create_native_watch(
    workspace_root: &Path,
    state: Weak<Mutex<RuntimeState>>,
    scope: WorkspaceIndexScope,
) -> Result<NativeWatchHandle, String> {
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            handle_native_watch_result(&state, &scope, result);
        })
        .map_err(|error| format!("Could not monitor the workspace index: {error}"))?;
    watcher
        .watch(workspace_root, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not monitor the workspace index: {error}"))?;
    Ok(NativeWatchHandle {
        watcher: Some(watcher),
    })
}

fn handle_native_watch_result(
    state: &Weak<Mutex<RuntimeState>>,
    scope: &WorkspaceIndexScope,
    result: Result<notify::Event, notify::Error>,
) {
    if matches!(&result, Ok(event) if event.need_rescan()) {
        if let Some(state) = state.upgrade() {
            invalidate_exact_binding(&state, scope, false);
        }
        return;
    }
    if matches!(&result, Ok(event) if event.kind.is_access()) {
        return;
    }
    if let Ok(event) = &result {
        if event_paths_are_benign_directory_metadata(scope, event) {
            return;
        }
    }
    let Some(state) = state.upgrade() else {
        return;
    };
    if let Ok(event) = result {
        let published_index = {
            let Ok(mut state) = state.lock() else {
                return;
            };
            let Some(active) = state
                .active
                .as_mut()
                .filter(|active| active.scope == *scope)
            else {
                return;
            };
            if let Some(stored) = &active.index {
                Some(Arc::clone(&stored.index))
            } else if event_paths_are_relevant_before_publication(scope, &event.paths) {
                active.dirty_during_build = true;
                return;
            } else {
                None
            }
        };
        if let Some(index) = published_index {
            if event_paths_match_published_index(scope, &index, &event) {
                return;
            }
        }
    }
    invalidate_exact_binding(&state, scope, false);
}

fn event_paths_are_benign_directory_metadata(
    scope: &WorkspaceIndexScope,
    event: &notify::Event,
) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
    ) && workspace_root_matches_scope(scope)
        && !event.paths.is_empty()
        && event.paths.iter().all(|path| {
            path.strip_prefix(&scope.workspace_root).is_ok()
                && std::fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        })
}

fn event_paths_match_published_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    event: &notify::Event,
) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Create(notify::event::CreateKind::File)
            | notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
            | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
    ) && !event.paths.is_empty()
        && event
            .paths
            .iter()
            .all(|path| event_path_matches_published_index(scope, index, path))
}

fn lease_scope(lease: &WorkspaceIndexLease) -> WorkspaceIndexScope {
    WorkspaceIndexScope {
        workspace_token: lease.workspace_token.clone(),
        workspace_root: lease.workspace_root.clone(),
        workspace_root_identity: lease.workspace_root_identity.clone(),
        _workspace_root_handle: Arc::clone(&lease.workspace_root_handle),
        generation: lease.generation,
    }
}

fn event_paths_are_relevant_before_publication(
    scope: &WorkspaceIndexScope,
    paths: &[PathBuf],
) -> bool {
    !paths.is_empty()
        && paths.iter().all(|path| {
            path.strip_prefix(&scope.workspace_root).is_ok()
                && match std::fs::symlink_metadata(path) {
                    Ok(metadata) => !metadata.file_type().is_symlink(),
                    Err(_) => true,
                }
        })
}

fn workspace_matches_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    lease: Option<&WorkspaceIndexLease>,
) -> bool {
    if !workspace_root_matches_scope(scope) {
        return false;
    }
    let cancellation = lease
        .map(|lease| lease.cancellation.clone())
        .unwrap_or_else(|| new_deadline_bound_cancellation().0);
    let limits = index.limits();
    let mut markdown_paths = Vec::new();
    let entries = WalkDir::new(&scope.workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_excluded_walk_dir(entry.path()));
    let mut walked_entries = 0usize;
    for entry in entries {
        if cancellation.is_cancelled() {
            return false;
        }
        let Ok(entry) = entry else {
            return false;
        };
        if entry.depth() == 0 {
            continue;
        }
        walked_entries = walked_entries.saturating_add(1);
        if walked_entries > MAX_WORKSPACE_INDEX_WALK_ENTRIES {
            return false;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&scope.workspace_root) else {
            return false;
        };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if WorkspaceFileKind::classify(Path::new(&relative_path))
            != Some(WorkspaceFileKind::Markdown)
        {
            continue;
        }
        markdown_paths.push((relative_path, entry.into_path()));
    }
    markdown_paths.sort_by(|left, right| left.0.cmp(&right.0));

    let mut documents = Vec::new();
    let mut eligible_files = 0usize;
    let mut aggregate_bytes = 0usize;
    for (relative_path, path) in markdown_paths {
        if cancellation.is_cancelled() {
            return false;
        }
        if eligible_files >= limits.max_files {
            continue;
        }
        eligible_files = eligible_files.saturating_add(1);
        let Ok(file) = open_regular_file_without_following_links(&path) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        let file_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if file_bytes > limits.max_file_bytes
            || aggregate_bytes.saturating_add(file_bytes) > limits.max_aggregate_bytes
        {
            continue;
        }
        let mut bytes = Vec::with_capacity(file_bytes.min(limits.max_file_bytes));
        let mut bounded = file.take((limits.max_file_bytes as u64).saturating_add(1));
        if bounded.read_to_end(&mut bytes).is_err() || bytes.len() > limits.max_file_bytes {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        if aggregate_bytes.saturating_add(content.len()) > limits.max_aggregate_bytes {
            continue;
        }
        aggregate_bytes = aggregate_bytes.saturating_add(content.len());
        documents.push(IndexDocument {
            relative_path,
            content,
        });
    }

    workspace_root_matches_scope(scope)
        && build_index(documents, limits, &cancellation)
            .completed()
            .is_some_and(|(rebuilt, _)| index.has_same_exact_documents(&rebuilt))
}

fn event_path_matches_published_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    path: &Path,
) -> bool {
    let Ok(relative) = path.strip_prefix(&scope.workspace_root) else {
        return false;
    };
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    if relative.components().any(|component| match component {
        std::path::Component::Normal(name) => is_excluded_walk_dir(Path::new(name)),
        _ => false,
    }) {
        return true;
    }
    if metadata.is_dir() {
        return false;
    }
    if !metadata.is_file() {
        return false;
    }
    let relative_path = relative.to_string_lossy().replace('\\', "/");
    if WorkspaceFileKind::classify(Path::new(&relative_path)) != Some(WorkspaceFileKind::Markdown) {
        return metadata.is_file();
    }
    let Some(expected) = index.exact_content_for_relative_path(&relative_path) else {
        return false;
    };
    file_matches_expected_content(path, expected, index.max_file_bytes())
}

fn file_matches_expected_content(path: &Path, expected: &str, max_file_bytes: usize) -> bool {
    let Ok(file) = open_regular_file_without_following_links(path) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(expected.len().min(max_file_bytes));
    let mut bounded = file.take((max_file_bytes as u64).saturating_add(1));
    bounded.read_to_end(&mut bytes).is_ok() && bytes == expected.as_bytes()
}

fn workspace_root_matches_scope(scope: &WorkspaceIndexScope) -> bool {
    open_directory_without_following_links(&scope.workspace_root)
        .and_then(|directory| opened_file_platform_identity(&directory))
        .is_ok_and(|identity| identity == scope.workspace_root_identity)
}

fn stop_watch(watcher: Option<Box<dyn WatchHandlePort>>) {
    if let Some(mut watcher) = watcher {
        watcher.stop();
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

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Workspace index operation ID is invalid".to_string());
    }
    Ok(())
}

fn new_deadline_bound_cancellation() -> (CancellationToken, Instant) {
    let deadline = Instant::now() + MAX_OPERATION_DURATION;
    let cancellation = CancellationToken::with_deadline(deadline);
    (cancellation, deadline)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::workspace_index::{build_index, BuildReport, IndexDocument, IndexLimits};
    use tempfile::tempdir;

    use super::*;

    fn index() -> (WorkspaceIndex, BuildReport) {
        build_index(
            vec![IndexDocument {
                relative_path: "note.md".to_string(),
                content: "needle".to_string(),
            }],
            IndexLimits::default(),
            &CancellationToken::new(),
        )
        .completed()
        .unwrap()
    }

    #[test]
    fn a_rebuild_generation_cannot_publish_after_its_scope_is_invalidated() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let root = directory.path();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let (index, _) = index();

        runtime.invalidate("workspace-1", &root).unwrap();

        assert!(!runtime.publish_rebuild(&build, index).unwrap());
        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn a_new_rebuild_discards_the_previous_generation_and_cancels_its_work() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let root = directory.path();
        let first = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let (first_index, _) = index();
        assert!(runtime.publish_rebuild(&first, first_index).unwrap());

        let second = runtime
            .begin_rebuild("workspace-1", &root, "build-2")
            .unwrap();

        assert!(first.cancellation.is_cancelled());
        assert!(!runtime
            .is_result_current("workspace-1", &root, second.generation)
            .unwrap());
        assert!(second.generation > first.generation);
    }

    #[test]
    fn discard_all_does_not_reuse_a_generation_for_the_same_workspace() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let first = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();

        runtime.discard_all();
        let second = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-2")
            .unwrap();

        assert!(second.generation > first.generation);
    }

    #[test]
    fn rebuild_generation_advances_past_every_invalidation_generation() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let first = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();

        assert!(runtime.invalidate("workspace-1", directory.path()).unwrap());
        let invalidated_generation = runtime
            .current_generation("workspace-1", directory.path())
            .unwrap()
            .unwrap();
        let second = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-2")
            .unwrap();

        assert!(invalidated_generation > first.generation);
        assert!(second.generation > invalidated_generation);
    }

    #[test]
    fn query_leases_are_rejected_after_discard() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let root = directory.path();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());
        let query = runtime
            .begin_query("workspace-1", &root, "query-1")
            .unwrap();

        assert!(runtime.discard("workspace-1", &root).unwrap());
        assert!(!runtime.is_current(&query.lease).unwrap());
        assert!(query.lease.cancellation.is_cancelled());
    }

    #[test]
    fn an_expired_lease_cannot_publish_or_remain_current() {
        let runtime = WorkspaceIndexRuntime::default();
        let directory = tempdir().unwrap();
        let root = directory.path();
        let mut build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        build.deadline = Instant::now();
        let (index, _) = index();

        assert!(build.is_cancelled());
        assert!(!runtime.publish_rebuild(&build, index).unwrap());
        assert!(!runtime.is_current(&build).unwrap());
    }

    #[test]
    fn a_late_callback_from_a_replaced_watcher_cannot_invalidate_the_new_binding() {
        let directory = tempdir().unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let first = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();
        let second = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-2")
            .unwrap();
        let stale_scope = lease_scope(&first);

        invalidate_exact_binding(&runtime.state, &stale_scope, false);

        assert!(!second.cancellation.is_cancelled());
        assert_eq!(
            runtime
                .current_generation("workspace-1", directory.path())
                .unwrap(),
            Some(second.generation)
        );
    }

    #[test]
    fn watcher_events_are_buffered_before_publication_but_errors_invalidate() {
        let directory = tempdir().unwrap();

        for (result, should_invalidate) in [
            (
                Ok(notify::Event::new(notify::EventKind::Access(
                    notify::event::AccessKind::Any,
                ))),
                false,
            ),
            (
                Ok(
                    notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
                        .add_path(directory.path().to_path_buf()),
                ),
                false,
            ),
            (
                Ok(notify::Event::new(notify::EventKind::Any)
                    .add_path(directory.path().to_path_buf())),
                false,
            ),
            (
                Err(notify::Error::generic("injected watcher overflow")),
                true,
            ),
        ] {
            let runtime = WorkspaceIndexRuntime::default();
            let build = runtime
                .begin_rebuild("workspace-1", directory.path(), "build-1")
                .unwrap();
            let scope = lease_scope(&build);

            handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, result);

            assert_eq!(build.cancellation.is_cancelled(), should_invalidate);
            assert_eq!(
                runtime
                    .current_generation("workspace-1", directory.path())
                    .unwrap(),
                Some(build.generation + u64::from(should_invalidate))
            );
        }
    }

    #[test]
    fn watcher_rescan_always_cancels_the_build() {
        for kind in [
            notify::EventKind::Access(notify::event::AccessKind::Any),
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::Any,
            )),
        ] {
            let directory = tempdir().unwrap();
            let runtime = WorkspaceIndexRuntime::default();
            let build = runtime
                .begin_rebuild("workspace-1", directory.path(), "build-1")
                .unwrap();
            let watcher = runtime.state.lock().unwrap().watcher.take();
            stop_watch(watcher);
            let scope = lease_scope(&build);

            handle_native_watch_result(
                &Arc::downgrade(&runtime.state),
                &scope,
                Ok(notify::Event::new(kind).set_flag(notify::event::Flag::Rescan)),
            );

            assert!(build.cancellation.is_cancelled());
        }
    }

    #[test]
    fn watcher_event_storm_coalesces_into_one_bounded_reconciliation() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "needle").unwrap();
        std::fs::write(
            root.join("oversized.md"),
            vec![b'x'; IndexLimits::default().max_file_bytes + 1],
        )
        .unwrap();
        std::fs::write(root.join("invalid.md"), [0xff, 0xfe]).unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);

        for _ in 0..10_000 {
            handle_native_watch_result(
                &Arc::downgrade(&runtime.state),
                &scope,
                Ok(
                    notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                        notify::event::DataChange::Content,
                    )))
                    .add_path(document.clone()),
                ),
            );
        }

        assert!(!build.cancellation.is_cancelled());
        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());
    }

    #[test]
    fn event_arriving_during_reconciliation_is_checked_before_publication() {
        use std::sync::Barrier;

        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "needle").unwrap();
        let runtime = Arc::new(WorkspaceIndexRuntime::default());
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let event = || {
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )))
                .add_path(document.clone()),
            )
        };
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());

        let entered = Arc::new(Barrier::new(2));
        let proceed = Arc::new(Barrier::new(2));
        let publisher = Arc::clone(&runtime);
        let publisher_entered = Arc::clone(&entered);
        let publisher_proceed = Arc::clone(&proceed);
        let result = std::thread::spawn(move || {
            let (index, _) = index();
            let mut first_pass = true;
            publisher.publish_rebuild_with_reconcile_hook(&build, index, || {
                if first_pass {
                    first_pass = false;
                    publisher_entered.wait();
                    publisher_proceed.wait();
                }
            })
        });

        entered.wait();
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
        proceed.wait();

        assert!(result.join().unwrap().unwrap());
        assert!(runtime
            .is_result_current("workspace-1", &root, scope.generation)
            .unwrap());
    }

    #[test]
    fn continuous_build_events_fail_closed_after_bounded_reconciliation() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let event = || {
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )))
                .add_path(document.clone()),
            )
        };
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());

        let (index, _) = index();
        assert!(!runtime
            .publish_rebuild_with_reconcile_hook(&build, index, || {
                handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
            })
            .unwrap());
        assert!(build.cancellation.is_cancelled());
    }

    #[test]
    fn publish_reconciles_buffered_file_and_directory_events() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);

        for event in [
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                .add_path(document),
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::Folder))
                .add_path(root.clone()),
        ] {
            handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, Ok(event));
        }

        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());
        assert!(runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
        let root_replay = || {
            Ok(
                notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(root.clone()),
            )
        };
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, root_replay());
        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn publish_rejects_buffered_events_that_do_not_match_the_rebuilt_index() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "changed").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )))
                .add_path(document),
            ),
        );

        let (index, _) = index();
        assert!(!runtime.publish_rebuild(&build, index).unwrap());
        assert!(build.cancellation.is_cancelled());
    }

    #[test]
    fn stale_watcher_events_preserve_matching_published_content_but_real_changes_invalidate() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        let nested = root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(&document, "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let directory_metadata_event = || {
            Ok(notify::Event::new(notify::EventKind::Modify(
                notify::event::ModifyKind::Metadata(notify::event::MetadataKind::Any),
            ))
            .add_path(root.clone())
            .add_path(nested.clone()))
        };
        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            directory_metadata_event(),
        );
        assert!(!build.cancellation.is_cancelled());

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(
                notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                    .add_path(document.clone()),
            ),
        );
        assert!(!build.cancellation.is_cancelled());

        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());
        let event = || {
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )))
                .add_path(document.clone()),
            )
        };

        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
        assert!(runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            directory_metadata_event(),
        );
        assert!(runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());

        std::fs::write(&document, "changed").unwrap();
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn rename_to_non_markdown_invalidates_the_stale_markdown_source() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("note.md");
        let destination = root.join("note.txt");
        std::fs::write(&source, "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());
        std::fs::rename(source, &destination).unwrap();

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::To,
                )))
                .add_path(destination),
            ),
        );

        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn unknown_published_event_kinds_fail_closed() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let document = root.join("note.md");
        std::fs::write(&document, "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(notify::Event::new(notify::EventKind::Any).add_path(document)),
        );

        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn published_directory_events_fail_closed_without_repeated_full_scans() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("note.md"), "needle").unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);
        let (index, _) = index();
        assert!(runtime.publish_rebuild(&build, index).unwrap());

        for _ in 0..10_000 {
            handle_native_watch_result(
                &Arc::downgrade(&runtime.state),
                &scope,
                Ok(notify::Event::new(notify::EventKind::Create(
                    notify::event::CreateKind::Folder,
                ))
                .add_path(root.clone())),
            );
        }

        assert!(!runtime
            .is_result_current("workspace-1", &root, build.generation)
            .unwrap());
    }

    #[test]
    fn replacing_the_workspace_root_object_prevents_publication() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        let displaced = directory.path().join("displaced");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("note.md"), "needle").unwrap();
        let root = root.canonicalize().unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", &root, "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        std::fs::rename(&root, displaced).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("note.md"), "needle").unwrap();

        let (index, _) = index();
        assert!(!runtime.publish_rebuild(&build, index).unwrap());
        assert!(build.cancellation.is_cancelled());
    }

    #[test]
    fn watcher_errors_invalidate_and_cancel_the_bound_generation() {
        let directory = tempdir().unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();
        let scope = lease_scope(&build);

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Err(notify::Error::generic("injected watcher overflow")),
        );

        assert!(build.cancellation.is_cancelled());
        assert_eq!(
            runtime
                .current_generation("workspace-1", directory.path())
                .unwrap(),
            Some(build.generation + 1)
        );
    }

    struct CountingWatchHandle(Arc<AtomicUsize>);

    impl WatchHandlePort for CountingWatchHandle {
        fn stop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn discard_all_stops_the_bound_workspace_watcher() {
        let runtime = WorkspaceIndexRuntime::default();
        let stopped = Arc::new(AtomicUsize::new(0));
        runtime.install_watch_for_test(Box::new(CountingWatchHandle(Arc::clone(&stopped))));

        runtime.discard_all();

        assert_eq!(stopped.load(Ordering::SeqCst), 1);
    }
}
