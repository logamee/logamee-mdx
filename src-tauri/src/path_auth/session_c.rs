//! FileAuthorizationSession operations (segment).
use super::*;

mod session_c_helpers;

impl FileAuthorizationSession {
    #[cfg(test)]
    pub(crate) fn authorize_directory_root(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<AuthorizedWorkspace, String> {
        self.authorize_directory_root_with(root, |_| Ok(()))
    }
    #[cfg(test)]
    pub(crate) fn authorize_file(&self, file: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Authorized file must be a file".into());
        }
        let mut state = self.lock()?;
        Self::publish_open_document(&mut state, file, true, None)
    }
    #[cfg(test)]
    pub(crate) fn open_standalone_file<S>(
        &self,
        file: impl AsRef<Path>,
        response: impl FnOnce(&Path) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedFile, S), String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Authorized file must be a file".into());
        }
        let response = response(&file)?;
        let parent = file
            .parent()
            .ok_or_else(|| "Selected file has no parent directory".to_string())?
            .to_path_buf();
        let mut state = self.lock()?;
        transport(&parent)?;
        let authorized = Self::publish_open_document(&mut state, file, true, None)?;
        Ok((authorized, response))
    }
        #[cfg(test)]
    pub(crate) fn with_prepared_open_document_grant<T>(
        &self,
        file: impl AsRef<Path>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let file = normalize_existing_path(file)?;
        if !file.is_file() {
            return Err("Prepared document grant target must be a file".to_string());
        }
        self.with_prepared_open_document_grant_inner(file, None, operation)
    }
    pub(crate) fn with_prepared_open_document_grant_for_receipt<T>(
        &self,
        file: PathBuf,
        workspace_authorization: Option<&WorkspaceReadAuthorization>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        if workspace_authorization.is_some_and(|authorization| authorization.path != file) {
            return Err(
                "Workspace open receipt target does not match its authorization".to_string(),
            );
        }
        self.with_prepared_open_document_grant_inner(file, workspace_authorization, operation)
    }
    pub(crate) fn with_prepared_open_document_grant_inner<T>(
        &self,
        file: PathBuf,
        workspace_authorization: Option<&WorkspaceReadAuthorization>,
        operation: impl FnOnce(PreparedOpenDocumentGrant<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let parent = file
            .parent()
            .ok_or_else(|| "Prepared document grant target has no parent".to_string())?
            .to_path_buf();
        let mut state = self.lock()?;
        if workspace_authorization.is_some_and(|authorization| {
            !workspace_read_authorization_is_current(&state, authorization)
        }) {
            return Err("Workspace file identity changed before open was committed".to_string());
        }
        let document_grant_id = state.next_document_grant_id;
        let next_document_grant_id = document_grant_id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        let origin = GrantOrigin::OpenDocument(DocumentGrantId(document_grant_id));
        let (workspace_document_origin, document_origin_identity) =
            Self::workspace_origin_records(DocumentGrantId(document_grant_id), workspace_authorization);
        if workspace_document_origin.is_some() {
            Self::reserve_workspace_provenance(&mut state)?;
        }
        let keys = [
            GrantKey::ExactReadWrite(file),
            GrantKey::InternalAsset(parent),
        ];
        let mut mutations = Self::reserve_document_grant_capacity(&mut state, &keys)?;
        let next_authorization_generation = state.next_authorization_generation()?;
        let next_grant_sequence =
            Self::prepare_document_grant_mutations(&mut state, &origin, keys, &mut mutations)?;

        operation(PreparedOpenDocumentGrant {
            state,
            mutations,
            workspace_authorization: workspace_authorization.cloned(),
            workspace_document_origin,
            document_origin_identity,
            next_document_grant_id,
            next_grant_sequence,
            next_authorization_generation,
        })
    }
        #[cfg(test)]
    pub(crate) fn prepare_save_destination(
        &self,
        path: impl AsRef<Path>,
        preflight: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PathBuf, String> {
        let normalized = normalize_file_for_write(path)?;
        let _state = self.lock()?;
        preflight(&normalized)?;
        Ok(normalized)
    }
        #[cfg(test)]
    pub(crate) fn publish_save_destination(&self, normalized: PathBuf) -> Result<AuthorizedFile, String> {
        #[cfg(test)]
        if let Some(error) = self
            .next_save_publish_error
            .lock()
            .map_err(|_| "Save publication test seam is poisoned".to_string())?
            .take()
        {
            return Err(error);
        }
        let mut state = self.lock()?;
        let origin = GrantOrigin::SaveAs(state.allocate_document_grant_id()?);
        Self::grant_exact_file(&mut state, &normalized, origin.clone(), true)?;
        Ok(AuthorizedFile::new(normalized, origin))
    }
    #[cfg(test)]
    pub(crate) fn authorize_save_destination(&self, path: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let normalized = normalize_file_for_write(path)?;
        self.publish_save_destination(normalized)
    }
    pub(crate) fn grant_exact_file(
        state: &mut AuthorizationState,
        file: &Path,
        origin: GrantOrigin,
        include_internal_assets: bool,
    ) -> Result<(), String> {
        let grant_count = 1 + usize::from(include_internal_assets && file.parent().is_some());
        state
            .authorization_generation
            .checked_add(grant_count as u64)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())?;
        state.grant(GrantKey::ExactReadWrite(file.to_path_buf()), origin.clone())?;
        if include_internal_assets {
            if let Some(parent) = file.parent() {
                state.grant(GrantKey::InternalAsset(parent.to_path_buf()), origin)?;
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn publish_open_document(
        state: &mut AuthorizationState,
        file: PathBuf,
        include_internal_assets: bool,
        workspace_provenance: Option<(WorkspaceToken, String)>,
    ) -> Result<AuthorizedFile, String> {
        if workspace_provenance.is_some() {
            Self::reserve_workspace_provenance(state)?;
        }
        let document_id = state.allocate_document_grant_id()?;
        let origin = GrantOrigin::OpenDocument(document_id);
        Self::grant_exact_file(state, &file, origin.clone(), include_internal_assets)?;
        if let Some((token, file_identity)) = workspace_provenance {
            let replaced = state.workspace_document_origins.insert(document_id, token);
            debug_assert!(replaced.is_none());
            let replaced = state
                .document_origin_identities
                .insert(document_id, file_identity);
            debug_assert!(replaced.is_none());
        }
        Ok(AuthorizedFile::new(file, origin))
    }
    #[cfg(test)]
    pub(crate) fn open_workspace_file(&self, path: impl AsRef<Path>) -> Result<AuthorizedFile, String> {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Path is not a file".into());
        }
        let mut state = self.lock()?;
        let workspace_token = current_workspace_token_for_path(&state, &canonical);
        let workspace_token = workspace_token.ok_or_else(|| {
            "File is outside the user-authorized session files and directories".to_string()
        })?;
        let file_identity =
            current_file_identity_for_origin(&state, &canonical, Some(&workspace_token))
                .ok_or_else(|| {
                    "Workspace file identity changed before open publication".to_string()
                })?;
        Self::publish_open_document(
            &mut state,
            canonical,
            false,
            Some((workspace_token, file_identity)),
        )
    }
    pub(crate) fn is_existing_file_authorized(state: &AuthorizationState, canonical: &Path) -> bool {
        state.grants.iter().any(|(key, ledger)| match key {
            GrantKey::ExactReadWrite(file) => {
                file == canonical && exact_grant_is_current(state, file, ledger)
            }
            GrantKey::DirectoryRead(root) => {
                ledger.is_active()
                    && path_is_under(canonical, root)
                    && directory_read_grant_is_current(state, root, ledger)
            }
            GrantKey::InternalAsset(_) => false,
        })
    }
}
