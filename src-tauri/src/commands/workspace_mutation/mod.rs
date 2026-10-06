pub(crate) mod create;
mod create_helpers;
pub(crate) mod delete;
#[cfg(test)]
mod delete_test_helpers;
pub(crate) mod entries;
pub(crate) mod observe;
pub(crate) mod relocate;

pub(crate) use create::{create_workspace_directory_inner, create_workspace_file_for_kind_inner, create_workspace_file_inner};
#[cfg(test)]
pub(crate) use create::{
    create_workspace_directory_with_ports_inner, create_workspace_directory_with_snapshot_inner,
    create_workspace_file_with_ports_inner, create_workspace_file_with_snapshot_inner,
};

pub(crate) use delete::delete_workspace_entry_inner;
pub(crate) use relocate::{copy_workspace_entry_inner, move_workspace_entry_inner, rename_workspace_entry_inner};

use std::path::Path;

use tauri::State;

use crate::models::{
    DeleteWorkspaceEntryResponse, MutationCommitReceipt, MutationOutcome, OpenFileResponse,
    RenameWorkspaceEntryResponse, SnapshotReceipt, WorkspaceMutation, WorkspaceSnapshot,
};
use crate::path_auth::{AuthorizedRenameOutcome, WorkspaceSnapshotSource};
use crate::state::AppState;
use crate::workspace_snapshot::CapturedWorkspaceSnapshot;

use crate::path_auth::{resolve_authorized_workspace_root_for_token_inner, AuthorizedWorkspace};
use crate::workspace_file_kind::WorkspaceFileKind;
use crate::workspace_snapshot::capture_workspace_snapshot;

use super::{discard_workspace_index_after_workspace_mutation, RevealPort, SystemRevealPort};

pub(crate) fn finish_workspace_entry_relocation_outcome(
    state: &AppState,
    outcome: Result<AuthorizedRenameOutcome, String>,
    filesystem_called: bool,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(message) if !filesystem_called => {
            return Ok(MutationOutcome::ConfirmedNotCommitted { message });
        }
        Err(message) => return Err(message),
    };

    match outcome {
        AuthorizedRenameOutcome::ConfirmedNotCommitted { message } => {
            Ok(MutationOutcome::ConfirmedNotCommitted { message })
        }
        AuthorizedRenameOutcome::Committed(renamed) => {
            let committed = RenameWorkspaceEntryResponse {
                entry_kind: if renamed.is_file() {
                    "file"
                } else {
                    "directory"
                }
                .to_string(),
                old_path: renamed.old_path().to_string_lossy().to_string(),
                new_path: renamed.new_path().to_string_lossy().to_string(),
            };
            Ok(committed_workspace_outcome(state, renamed.workspace(), committed, snapshot))
        }
        AuthorizedRenameOutcome::RecoveryRequired {
            renamed,
            recovery_message,
        } => Ok(MutationOutcome::Indeterminate {
            operation: crate::models::MutationKind::Rename,
            paths: vec![
                renamed.old_path().to_string_lossy().to_string(),
                renamed.new_path().to_string_lossy().to_string(),
            ],
            recovery_message,
        }),
        AuthorizedRenameOutcome::Indeterminate {
            attempted,
            recovery_message,
            ..
        } => Ok(MutationOutcome::Indeterminate {
            operation: crate::models::MutationKind::Rename,
            paths: vec![
                attempted.old_path().to_string_lossy().to_string(),
                attempted.new_path().to_string_lossy().to_string(),
            ],
            recovery_message,
        }),
    }
}
#[cfg(test)]
pub(crate) use delete::{
    delete_workspace_entry_legacy_inner, delete_workspace_entry_with_ports_inner,
    delete_workspace_entry_with_snapshot_inner, delete_workspace_entry_with_trash_port_inner,
};
#[cfg(test)]
pub(crate) use relocate::{
    rename_workspace_entry_with_preflight_and_ports_inner, rename_workspace_entry_with_ports_inner,
    rename_workspace_entry_with_snapshot_inner,
};

pub(crate) fn refresh_directory_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<WorkspaceSnapshot, String> {
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(state, workspace_token, path)?;
    snapshot(WorkspaceSnapshotSource::Authorized(&workspace))
        .and_then(|snapshot| snapshot.into_workspace_snapshot(&workspace))
}

pub(crate) fn refresh_directory_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
) -> Result<WorkspaceSnapshot, String> {
    refresh_directory_with_snapshot_inner(state, workspace_token, path, capture_workspace_snapshot)
}

pub(super) fn committed_workspace_outcome<T>(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    committed: T,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> MutationOutcome<T, WorkspaceSnapshot> {
    let workspace_receipt = capture_post_commit_workspace_receipt(state, workspace, snapshot);
    discard_workspace_index_after_workspace_mutation(state, workspace);
    MutationOutcome::ConfirmedCommitted {
        receipt: MutationCommitReceipt {
            committed,
            workspace: workspace_receipt,
        },
    }
}

fn capture_post_commit_workspace_receipt(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> SnapshotReceipt<WorkspaceSnapshot> {
    match snapshot(WorkspaceSnapshotSource::Authorized(workspace)) {
        Ok(snapshot) => match snapshot.into_workspace_snapshot(workspace) {
            Ok(snapshot) => match state
                .file_authorization()
                .ensure_workspace_is_current(workspace)
            {
                Ok(()) => SnapshotReceipt::Fresh { snapshot },
                Err(repair_reason) => SnapshotReceipt::Stale {
                    workspace_token: workspace.wire_token(),
                    repair_reason,
                },
            },
            Err(repair_reason) => SnapshotReceipt::Stale {
                workspace_token: workspace.wire_token(),
                repair_reason,
            },
        },
        Err(repair_reason) => SnapshotReceipt::Stale {
            workspace_token: workspace.wire_token(),
            repair_reason,
        },
    }
}

#[tauri::command]
pub(crate) fn refresh_directory(
    workspace_token: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    refresh_directory_inner(&state, &workspace_token, path)
}

#[tauri::command]
pub(crate) fn create_workspace_file(
    workspace_token: String,
    parent_path: String,
    name: String,
    file_kind: Option<WorkspaceFileKind>,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    match file_kind.unwrap_or(WorkspaceFileKind::Markdown) {
        WorkspaceFileKind::Markdown => {
            create_workspace_file_inner(&state, &workspace_token, parent_path, &name)
        }
        kind => {
            create_workspace_file_for_kind_inner(&state, &workspace_token, parent_path, &name, kind)
        }
    }
}

#[tauri::command]
pub(crate) fn create_workspace_directory(
    workspace_token: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    create_workspace_directory_inner(&state, &workspace_token, parent_path, &name)
}

#[tauri::command]
pub(crate) fn rename_workspace_entry(
    workspace_token: String,
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    rename_workspace_entry_inner(&state, &workspace_token, path, &new_name)
}

#[tauri::command]
pub(crate) fn move_workspace_entry(
    workspace_token: String,
    path: String,
    destination_parent_path: String,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    move_workspace_entry_inner(&state, &workspace_token, path, destination_parent_path)
}

#[tauri::command]
pub(crate) fn copy_workspace_entry(
    workspace_token: String,
    source_path: String,
    destination_parent_path: String,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    copy_workspace_entry_inner(
        &state,
        &workspace_token,
        source_path,
        destination_parent_path,
    )
}

#[tauri::command]
pub(crate) fn reveal_workspace_entry(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::path_auth::reveal_authorized_workspace_entry_inner(&state, path, |canonical| {
        SystemRevealPort.reveal(canonical)
    })
    .map(|_| ())
}

#[tauri::command]
pub(crate) fn delete_workspace_entry(
    workspace_token: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<MutationOutcome<DeleteWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    delete_workspace_entry_inner(&state, &workspace_token, path)
}
