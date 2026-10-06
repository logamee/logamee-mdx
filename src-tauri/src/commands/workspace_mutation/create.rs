use std::path::Path;

use crate::models::{ MutationOutcome, OpenFileResponse, WorkspaceMutation, WorkspaceSnapshot };
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

use super::entries::{new_workspace_file_spec, validate_workspace_entry_name};
use crate::path_auth::{resolve_authorized_workspace_directory_for_token_inner, WorkspaceSnapshotSource};
use crate::workspace_snapshot::{capture_workspace_snapshot, CapturedWorkspaceSnapshot};
use super::{ committed_workspace_outcome };
use super::create_helpers::{
    create_file_adapter, unobservable_committed_file_outcome, unobserved_create_directory_outcome,
    unobserved_create_file_outcome,
};
use super::super::{open_authorized_file_response, FileSystemPort, SystemFileSystemPort};

fn create_workspace_file_with_kind_and_ports_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    kind: WorkspaceFileKind,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    let (_, workspace) = match resolve_authorized_workspace_directory_for_token_inner(
        state,
        workspace_token,
        &parent_path,
    ) {
        Ok(value) => value,
        Err(message) => return Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    };
    let (file_name, initial_content) = match new_workspace_file_spec(kind, name) {
        Ok(value) => value,
        Err(message) => return Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    };
    let mut create_new_already_exists = false;
    let mut attempted_target = None;
    let created = state.file_authorization().create_workspace_file(
        &workspace,
        parent_path,
        &file_name,
        create_file_adapter(
            filesystem,
            &initial_content,
            &mut attempted_target,
            &mut create_new_already_exists,
        ),
    );
    let (workspace, file) = match created {
        Ok(created) => created,
        Err(message) if create_new_already_exists => {
            return Ok(MutationOutcome::ConfirmedNotCommitted { message });
        }
        Err(message) => {
            return unobserved_create_file_outcome(
                message,
                attempted_target,
                &initial_content,
                filesystem,
            );
        }
    };
    let committed_path = file.into_path();
    let committed = match open_authorized_file_response(committed_path.clone()) {
        Ok(response) => response,
        Err(error) => {
            return Ok(unobservable_committed_file_outcome(&committed_path, error));
        }
    };
    Ok(committed_workspace_outcome(state, &workspace, committed, snapshot))
}

pub(crate) fn create_workspace_file_with_ports_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    create_workspace_file_with_kind_and_ports_inner(
        state,
        workspace_token,
        parent_path,
        name,
        WorkspaceFileKind::Markdown,
        filesystem,
        snapshot,
    )
}

pub(crate) fn create_workspace_file_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    create_workspace_file_with_ports_inner(
        state,
        workspace_token,
        parent_path,
        name,
        &SystemFileSystemPort,
        snapshot,
    )
}

pub(crate) fn create_workspace_file_for_kind_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    kind: WorkspaceFileKind,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    create_workspace_file_with_kind_and_ports_inner(
        state,
        workspace_token,
        parent_path,
        name,
        kind,
        &SystemFileSystemPort,
        capture_workspace_snapshot,
    )
}

pub(crate) fn create_workspace_file_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
) -> Result<MutationOutcome<OpenFileResponse, WorkspaceSnapshot>, String> {
    create_workspace_file_with_snapshot_inner(
        state,
        workspace_token,
        parent_path,
        name,
        capture_workspace_snapshot,
    )
}

pub(crate) fn create_workspace_directory_with_ports_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    filesystem: &impl FileSystemPort,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    let (_, workspace) = match resolve_authorized_workspace_directory_for_token_inner(
        state,
        workspace_token,
        &parent_path,
    ) {
        Ok(value) => value,
        Err(message) => return Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    };
    let directory_name = match validate_workspace_entry_name(name) {
        Ok(value) => value,
        Err(message) => return Ok(MutationOutcome::ConfirmedNotCommitted { message }),
    };
    let mut create_dir_already_exists = false;
    let mut attempted_target = None;
    let created = state.file_authorization().create_workspace_directory(
        &workspace,
        parent_path,
        directory_name,
        |target| {
            attempted_target = Some(target.to_path_buf());
            filesystem.create_dir(target).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    create_dir_already_exists = true;
                }
                format!("Failed to create directory: {error}")
            })
        },
    );
    let (workspace, target) = match created {
        Ok(created) => created,
        Err(_message) if create_dir_already_exists => {
            return Ok(MutationOutcome::ConfirmedNotCommitted {
                message: "Workspace entry already exists".to_string(),
            });
        }
        Err(message) => {
            return unobserved_create_directory_outcome(message, attempted_target, filesystem);
        }
    };
    let committed = WorkspaceMutation {
        path: target.to_string_lossy().to_string(),
    };
    Ok(committed_workspace_outcome(state, &workspace, committed, snapshot))
}

pub(crate) fn create_workspace_directory_with_snapshot_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
    snapshot: impl for<'a> FnOnce(
        WorkspaceSnapshotSource<'a>,
    ) -> Result<CapturedWorkspaceSnapshot, String>,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    create_workspace_directory_with_ports_inner(
        state,
        workspace_token,
        parent_path,
        name,
        &SystemFileSystemPort,
        snapshot,
    )
}

pub(crate) fn create_workspace_directory_inner(
    state: &AppState,
    workspace_token: &str,
    parent_path: impl AsRef<Path>,
    name: &str,
) -> Result<MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>, String> {
    create_workspace_directory_with_snapshot_inner(
        state,
        workspace_token,
        parent_path,
        name,
        capture_workspace_snapshot,
    )
}
