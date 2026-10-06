//! FileAuthorizationSession operations (segment).
use super::*;

mod session_d_helpers;
use session_d_helpers::*;

impl FileAuthorizationSession {
    pub(crate) fn file_for_read(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let state = self.lock()?;
        if Self::is_existing_file_authorized(&state, &canonical) {
            Ok(canonical)
        } else {
            Err("File is outside the user-authorized session files and directories".into())
        }
    }
    pub(crate) fn open_file_for_read_with_before_open(
        &self,
        path: impl AsRef<Path>,
        before_open: impl FnOnce(),
    ) -> Result<AuthorizedReadFile, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let authority = self.resolve_read_authority(&canonical)?;
        before_open();
        let (file, workspace_authorization) = open_authorized_read_file(&canonical, authority)?;
        Ok(AuthorizedReadFile {
            path: canonical,
            file,
            workspace_authorization,
        })
    }

    /// Resolves the read authority for an already-canonicalized file while
    /// holding the authorization lock: the deepest active workspace grant
    /// wins over an exact grant, and a present-but-unbindable directory grant
    /// reports that the workspace root changed instead of denying access.
    fn resolve_read_authority(&self, canonical: &Path) -> Result<ReadAuthority, String> {
        let state = self.lock()?;
        let mut matching_directory_grant = false;
        let workspace = state
            .grants
            .iter()
            .filter(|(key, ledger)| {
                ledger.is_active()
                    && matches!(key, GrantKey::DirectoryRead(root) if path_is_under(canonical, root))
            })
            .filter_map(|(key, ledger)| {
                let GrantKey::DirectoryRead(root) = key else {
                    return None;
                };
                matching_directory_grant = true;
                current_workspace_binding_for_directory_grant(&state, root, ledger)
                    .map(|(token, binding)| (root.clone(), token, binding))
            })
            .max_by_key(|(root, _, _)| root.components().count());
        if let Some((root, token, binding)) = workspace {
            Ok(ReadAuthority::Workspace {
                root,
                token,
                binding,
            })
        } else if let Some(exact) = state.grants.iter().find_map(|(key, ledger)| {
            let GrantKey::ExactReadWrite(file) = key else {
                return None;
            };
            (file == canonical)
                .then(|| exact_read_authority(&state, file, ledger))
                .flatten()
        }) {
            Ok(ReadAuthority::Exact(exact))
        } else if matching_directory_grant {
            Err("Workspace root changed after authorization".to_string())
        } else {
            Err("File is outside the user-authorized session files and directories".into())
        }
    }
    pub(crate) fn open_file_for_read(&self, path: impl AsRef<Path>) -> Result<AuthorizedReadFile, String> {
        self.open_file_for_read_with_before_open(path, || {})
    }
    pub(crate) fn open_exact_workspace_file_for_read(
        &self,
        workspace_token: &str,
        workspace_root: impl AsRef<Path>,
        path: impl AsRef<Path>,
    ) -> Result<AuthorizedReadFile, String> {
        let token = WorkspaceToken::from_wire(workspace_token)?;
        let canonical_root = normalize_existing_path(workspace_root)?;
        if !canonical_root.is_dir() {
            return Err("Path is not a directory".into());
        }
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let (workspace, exact) =
            self.resolve_exact_workspace_read_authority(&token, &canonical_root, &canonical)?;
        let (file, file_identity, relative) =
            open_workspace_file_through_current_binding(&canonical, &workspace, exact)?;
        let file_binding = Arc::new(file.try_clone().map_err(|error| {
            format!(
                "Failed to retain securely opened file {}: {error}",
                canonical.display()
            )
        })?);
        Ok(AuthorizedReadFile {
            path: canonical.clone(),
            file,
            workspace_authorization: Some(WorkspaceReadAuthorization {
                path: canonical,
                root: workspace.root,
                relative,
                token,
                root_binding: workspace.root_binding,
                file_binding,
                file_identity,
            }),
        })
    }

    /// Resolves the still-active workspace and its exact-grant read authority
    /// for a workspace-bound document while the authorization lock is held.
    fn resolve_exact_workspace_read_authority(
        &self,
        token: &WorkspaceToken,
        canonical_root: &Path,
        canonical: &Path,
    ) -> Result<(AuthorizedWorkspace, ExactAuthority), String> {
        let state = self.lock()?;
        let workspace = Self::workspace_for_token(&state, token)
            .ok_or_else(|| "Workspace authorization is no longer active".to_string())?;
        if workspace.root != canonical_root {
            return Err("Directory does not match the selected workspace".into());
        }
        if !path_is_under(canonical, &workspace.root) {
            return Err("Document path is outside the authorized workspace".to_string());
        }
        let exact = state
            .grants
            .iter()
            .find_map(|(key, ledger)| {
                let GrantKey::ExactReadWrite(file) = key else {
                    return None;
                };
                (file == canonical)
                    .then(|| exact_read_authority(&state, file, ledger))
                    .flatten()
            })
            .ok_or_else(|| {
                "Document has not been explicitly opened or saved in this session".to_string()
            })?;
        let exact = match exact {
            ExactReadAuthority::Path => ExactAuthority::Path,
            ExactReadAuthority::Identity(identity) => ExactAuthority::Identity(identity),
        };
        Ok((workspace, exact))
    }
    pub(crate) fn file_for_watch(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let normalized = normalize_file_for_write(path)?;
        let state = self.lock()?;
        if state.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && match key {
                    GrantKey::ExactReadWrite(file) => {
                        file == &normalized && exact_grant_is_current(&state, file, ledger)
                    }
                    GrantKey::DirectoryRead(root) => {
                        path_is_under(&normalized, root)
                            && directory_read_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::InternalAsset(_) => false,
                }
        }) {
            Ok(normalized)
        } else {
            Err("File is outside the user-authorized session files and directories".into())
        }
    }
}
