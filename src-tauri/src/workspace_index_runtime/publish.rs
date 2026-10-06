//! Publish, currency checks, invalidation and discard on the runtime.
use std::{path::Path, sync::Arc};

#[allow(unused_imports)]
use super::{
    MAX_BUILD_RECONCILIATION_PASSES,
    StoredWorkspaceIndex,
    WatchHandlePort,
    WorkspaceIndexLease,
    WorkspaceIndexRuntime,
    cancel_operations,
    invalidate_exact_binding,
    invalidate_locked,
    lease_matches,
    lease_scope,
    scope_matches,
    stop_watch,
    validate_operation_id,
};
#[allow(unused_imports)]
use super::events::{workspace_matches_index, workspace_root_matches_scope};
#[allow(unused_imports)]
use crate::workspace_index::{BuildReport, CancellationToken, WorkspaceIndex};

impl WorkspaceIndexRuntime {
    pub(crate) fn publish_rebuild(
        &self,
        lease: &WorkspaceIndexLease,
        index: WorkspaceIndex,
    ) -> Result<bool, String> {
        self.publish_rebuild_with_reconcile_hook(lease, index, || {})
    }

    pub(crate) fn publish_rebuild_with_reconcile_hook(
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
    pub(super) fn install_watch_for_test(&self, watcher: Box<dyn WatchHandlePort>) {
        self.state.lock().unwrap().watcher = Some(watcher);
    }
}
