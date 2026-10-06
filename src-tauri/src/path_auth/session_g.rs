//! FileAuthorizationSession operations (segment).
use super::*;

/// Resolves the copy destination for a workspace entry: the destination
/// parent must be a directory inside the workspace root, the entry may not be
/// copied onto itself or into itself, and a free sibling name is derived when
/// the requested name is already taken.
fn copy_destination_for_entry(
    source: &Path,
    is_file: bool,
    workspace_root: &Path,
    destination_parent: PathBuf,
) -> Result<PathBuf, String> {
    if !destination_parent.is_dir() {
        return Err("Copy destination is not a directory".into());
    }
    if !path_is_under(&destination_parent, workspace_root) {
        return Err("Copy destination is outside the selected workspace".into());
    }
    let name = source
        .file_name()
        .ok_or_else(|| "Workspace entry name is invalid".to_string())?;
    let requested_target = destination_parent.join(name);
    if requested_target == source {
        return Err("Cannot copy an entry onto itself".into());
    }
    if !is_file && path_is_under(&destination_parent, source) {
        return Err("Cannot copy a folder into itself or one of its descendants".into());
    }
    let target_exists =
        |candidate: &str| fs::symlink_metadata(&destination_parent.join(candidate)).is_ok();
    let target_name = match name.to_str() {
        Some(name) => derive_copy_name(name, target_exists).ok_or_else(|| {
            "Cannot allocate a free copy destination name".to_string()
        })?,
        None => return Err("Workspace entry name is invalid".into()),
    };
    Ok(destination_parent.join(target_name))
}

impl FileAuthorizationSession {
    pub(crate) fn rename_workspace_entry(
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
    pub(crate) fn move_workspace_entry(
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
    /// Copies a workspace entry to a sibling destination inside the same
    /// workspace. The source is only read; authorization checks mirror a move
    /// (existing entry inside the workspace, destination under the workspace
    /// root, no overwrite), and the staged copy operation runs while the
    /// authorization lock is held.
    pub(crate) fn copy_workspace_entry(
        &self,
        workspace_token: &str,
        source_path: impl AsRef<Path>,
        destination_parent_path: impl AsRef<Path>,
        copy: impl FnOnce(&Path, &Path, bool) -> Result<(), crate::workspace_copy::CopyEntryError>,
    ) -> Result<CopyWorkspaceEntryOutcome, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let state = self.lock()?;
        let (source, workspace) =
            Self::workspace_entry_for_mutation_locked(&state, &token, source_path)?;
        let is_file = source.is_file();
        let destination_parent = normalize_existing_path(destination_parent_path)?;
        let target =
            copy_destination_for_entry(&source, is_file, &workspace.root, destination_parent)?;
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err("Workspace entry already exists".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot access copy destination: {error}")),
        }
        match copy(&source, &target, is_file) {
            Ok(()) => Ok(CopyWorkspaceEntryOutcome::Committed(CopiedWorkspaceEntry {
                workspace,
                source,
                target,
                is_file,
            })),
            Err(crate::workspace_copy::CopyEntryError::NotCommitted(message)) => {
                Ok(CopyWorkspaceEntryOutcome::ConfirmedNotCommitted { message })
            }
            Err(crate::workspace_copy::CopyEntryError::CommittedButUnverified {
                message, ..
            }) => Ok(CopyWorkspaceEntryOutcome::Indeterminate {
                copied: CopiedWorkspaceEntry {
                    workspace,
                    source,
                    target,
                    is_file,
                },
                recovery_message: message,
            }),
        }
    }
    pub(crate) fn reconcile_rename_after_error(
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
    pub(crate) fn delete_workspace_entry(
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
    pub(crate) fn trash_workspace_entry(
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
    #[cfg(test)]
    pub(crate) fn relocate_path_prefix(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.relocate_path_prefix(old_prefix, new_prefix)
    }
}
