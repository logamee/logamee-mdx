//! FileAuthorizationSession operations (segment).
use super::*;

impl FileAuthorizationSession {
    #[cfg(test)]
    pub(crate) fn file_for_write(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
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
        #[cfg(test)]
    pub(crate) fn write_document(
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
    #[cfg(test)]
    pub(crate) fn suspend_write_file(&self, path: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.suspend_write_path(path)
    }
    pub(crate) fn directory_for_read(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
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
    pub(crate) fn workspace_for_token(
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
    pub(crate) fn authorized_workspace_root_for_token(
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
}
