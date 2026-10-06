//! FileAuthorizationSession operations (segment).
use super::*;

/// Validates a requested rename/move destination and returns the resolved
/// target path. Mirrors the relocation contract: the destination name must be
/// a single normal component, its parent must be a directory inside the
/// workspace root, folders may not move into themselves, and the target must
/// not already exist.
fn resolved_relocation_target(
    source: &Path,
    is_file: bool,
    workspace_root: &Path,
    requested_target: PathBuf,
) -> Result<PathBuf, String> {
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
    if !path_is_under(&parent, workspace_root) {
        return Err("Move destination is outside the selected workspace".into());
    }
    if !is_file && path_is_under(&parent, source) {
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
    Ok(target)
}

impl FileAuthorizationSession {
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
    pub(crate) fn authorized_workspace_directory_for_token(
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
    pub(crate) fn workspace_entry_for_mutation_locked(
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
    pub(crate) fn workspace_entry_for_mutation(
        &self,
        token: &WorkspaceToken,
        path: impl AsRef<Path>,
    ) -> Result<(PathBuf, PathBuf), String> {
        let state = self.lock()?;
        let (entry, workspace) = Self::workspace_entry_for_mutation_locked(&state, token, path)?;
        Ok((entry, workspace.into_root()))
    }
    pub(crate) fn relocate_workspace_entry(
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
        let target = resolved_relocation_target(&source, is_file, &workspace.root, requested_target)?;

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
}
