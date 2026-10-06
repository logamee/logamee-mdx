use std::path::Path;

use crate::models::{ MutationOutcome, RenameWorkspaceEntryResponse, WorkspaceSnapshot };
use crate::path_auth::{
    move_authorized_workspace_entry_inner, rename_authorized_workspace_entry_inner,
    WorkspaceSnapshotSource,
};
use crate::state::AppState;
use crate::workspace_snapshot::{capture_workspace_snapshot, CapturedWorkspaceSnapshot};
use super::entries::{markdown_file_name, preview_file_name, validate_workspace_entry_name};
use super::finish_workspace_entry_relocation_outcome;
use super::super::{FileSystemPort, SystemFileSystemPort};
use super::{ committed_workspace_outcome };
use super::observe::observe_rename_after_error;
use crate::workspace_file_kind::WorkspaceFileKind;

pub(crate) fn rename_workspace_entry_with_preflight_and_ports_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    preflight: impl FnOnce(&Path, bool) -> Result<String, String>,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let filesystem_called = std::cell::Cell::new(false);
    let outcome = rename_authorized_workspace_entry_inner(
        state,
        workspace_token,
        path,
        preflight,
        |entry, target| {
            filesystem_called.set(true);
            filesystem
                .rename(entry, target)
                .map_err(|err| format!("Failed to rename entry: {err}"))
        },
        |attempted| {
            observe_rename_after_error(
                filesystem,
                attempted.old_path(),
                attempted.new_path(),
                attempted.is_file(),
            )
        },
    );
    finish_workspace_entry_relocation_outcome(state, outcome, filesystem_called.get(), snapshot)
}

pub(crate) fn rename_workspace_entry_with_ports_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    new_name: &str,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    rename_workspace_entry_with_preflight_and_ports_inner(
        state,
        workspace_token,
        path,
        |entry, is_file| {
            if !is_file {
                return Ok(validate_workspace_entry_name(new_name)?.to_string());
            }
            let current_kind = WorkspaceFileKind::classify(entry).ok_or_else(|| {
                "Workspace file does not have a supported preview type".to_string()
            })?;
            if current_kind == WorkspaceFileKind::Markdown {
                markdown_file_name(new_name)
            } else {
                preview_file_name(current_kind, new_name)
            }
        },
        filesystem,
        snapshot,
    )
}

pub(crate) fn rename_workspace_entry_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    new_name: &str,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    rename_workspace_entry_with_ports_inner(
        state,
        workspace_token,
        path,
        new_name,
        &SystemFileSystemPort,
        snapshot,
    )
}

pub(crate) fn rename_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    new_name: &str,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    rename_workspace_entry_with_snapshot_inner(
        state,
        workspace_token,
        path,
        new_name,
        capture_workspace_snapshot,
    )
}

fn move_workspace_entry_with_ports_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let filesystem_called = std::cell::Cell::new(false);
    let outcome = move_authorized_workspace_entry_inner(
        state,
        workspace_token,
        path,
        destination_parent_path,
        |entry, target| {
            filesystem_called.set(true);
            filesystem
                .rename(entry, target)
                .map_err(|err| format!("Failed to move entry: {err}"))
        },
        |attempted| {
            observe_rename_after_error(
                filesystem,
                attempted.old_path(),
                attempted.new_path(),
                attempted.is_file(),
            )
        },
    );
    finish_workspace_entry_relocation_outcome(state, outcome, filesystem_called.get(), snapshot)
}

fn move_workspace_entry_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    move_workspace_entry_with_ports_inner(
        state,
        workspace_token,
        path,
        destination_parent_path,
        &SystemFileSystemPort,
        snapshot,
    )
}

pub(crate) fn move_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    move_workspace_entry_with_snapshot_inner(
        state,
        workspace_token,
        path,
        destination_parent_path,
        capture_workspace_snapshot,
    )
}

pub(crate) fn copy_workspace_entry_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    copy_workspace_entry_with_snapshot_inner(
        state,
        workspace_token,
        source_path,
        destination_parent_path,
        capture_workspace_snapshot,
    )
}

fn copy_workspace_entry_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    source_path: impl AsRef<Path>,
    destination_parent_path: impl AsRef<Path>,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String> {
    let outcome = crate::path_auth::copy_authorized_workspace_entry_inner(
        state,
        workspace_token,
        source_path,
        destination_parent_path,
        crate::workspace_copy::copy_entry,
    );
    match outcome {
        Ok(crate::path_auth::CopyWorkspaceEntryOutcome::Committed(copied)) => {
            let committed = RenameWorkspaceEntryResponse {
                entry_kind: if copied.is_file() {
                    "file"
                } else {
                    "directory"
                }
                .to_string(),
                old_path: copied.source().to_string_lossy().to_string(),
                new_path: copied.target().to_string_lossy().to_string(),
            };
            Ok(committed_workspace_outcome(state, copied.workspace(), committed, snapshot))
        }
        Ok(crate::path_auth::CopyWorkspaceEntryOutcome::ConfirmedNotCommitted {
            message,
        }) => Ok(MutationOutcome::ConfirmedNotCommitted { message }),
        Ok(crate::path_auth::CopyWorkspaceEntryOutcome::Indeterminate {
            copied,
            recovery_message,
        }) => Ok(MutationOutcome::Indeterminate {
            operation: crate::models::MutationKind::Copy,
            paths: vec![
                copied.source().to_string_lossy().to_string(),
                copied.target().to_string_lossy().to_string(),
            ],
            recovery_message,
        }),
        Err(message) => Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    }
}
