//! Rebuild/query lease acquisition on the runtime.
use std::{fs::File, path::Path, sync::Arc, time::Instant};

use super::{ allocate_generation, cancel_operations, invalidate_exact_binding, validate_operation_id, new_deadline_bound_cancellation, ActiveOperation, ActiveWorkspaceIndex, OperationKind, WatchHandlePort, WorkspaceIndexLease, WorkspaceIndexRuntime, WorkspaceIndexScope, MAX_ACTIVE_OPERATIONS };
use super::watch::{ create_native_watch, stop_watch };
use crate::workspace_index::CancellationToken;
use crate::commands::{
    open_directory_without_following_links,
    opened_file_platform_identity,
};

impl WorkspaceIndexRuntime {
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
        let (scope, cancellation, deadline, previous_watcher) = self
            .begin_operation_transition(
                workspace_token,
                workspace_root,
                operation_id,
                &workspace_root_handle,
                workspace_root_identity,
            )?;
        stop_watch(previous_watcher);

        if !install_native_watch {
            return Ok(lease_from_scope(
                scope,
                workspace_root_handle,
                cancellation,
                deadline,
            ));
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
        Ok(lease_from_scope(
            scope,
            workspace_root_handle,
            cancellation,
            deadline,
        ))
    }

    fn begin_operation_transition(
        &self,
        workspace_token: &str,
        workspace_root: &Path,
        operation_id: &str,
        workspace_root_handle: &Arc<File>,
        workspace_root_identity: String,
    ) -> Result<
        (
            WorkspaceIndexScope,
            CancellationToken,
            Instant,
            Option<Box<dyn WatchHandlePort>>,
        ),
        String,
    > {
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
            _workspace_root_handle: Arc::clone(workspace_root_handle),
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
        Ok((scope, cancellation, deadline, previous_watcher))
    }
}

fn lease_from_scope(
    scope: WorkspaceIndexScope,
    workspace_root_handle: Arc<File>,
    cancellation: CancellationToken,
    deadline: Instant,
) -> WorkspaceIndexLease {
    WorkspaceIndexLease {
        workspace_token: scope.workspace_token,
        workspace_root: scope.workspace_root,
        workspace_root_identity: scope.workspace_root_identity,
        workspace_root_handle,
        generation: scope.generation,
        cancellation,
        deadline,
    }
}
