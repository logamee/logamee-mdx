//! FileAuthorizationSession operations (segment).
use super::*;

mod session_h_helpers;
use session_h_helpers::*;

impl FileAuthorizationSession {
    #[cfg(test)]
    pub(crate) fn relocate_path_prefix_with_identity(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: &str,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        let current_identity = current_file_identity_for_origin(&state, new_prefix, None)
            .ok_or_else(|| "Renamed document could not be securely reidentified".to_string())?;
        if current_identity != expected_identity {
            return Err("Renamed document identity changed before authorization moved".into());
        }
        state.relocate_path_prefix_with_identity(old_prefix, new_prefix, Some(expected_identity))
    }
    pub(crate) fn relocate_path_prefix_with_workspace_authorization(
        &self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: &str,
        authorization: &WorkspaceReadAuthorization,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        if authorization.path != new_prefix
            || authorization.file_identity != expected_identity
            || !workspace_read_authorization_is_current(&state, authorization)
        {
            return Err("Renamed document identity changed before authorization moved".into());
        }
        state.relocate_path_prefix_with_identity(old_prefix, new_prefix, Some(expected_identity))
    }
    pub(crate) fn revoke_path_prefix(&self, prefix: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.revoke_path_prefix(prefix)
    }
    pub(crate) fn is_authorized_preview_asset(&self, canonical: &Path) -> Result<bool, String> {
        let state = self.lock()?;
        Ok(state.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && match key {
                    GrantKey::DirectoryRead(root) => {
                        path_is_under(canonical, root)
                            && directory_read_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::InternalAsset(root) => {
                        path_is_under(canonical, root)
                            && internal_asset_grant_is_current(&state, root, ledger)
                    }
                    GrantKey::ExactReadWrite(_) => false,
                }
        }))
    }
    pub(crate) fn preview_scope_for(&self, file: impl AsRef<Path>) -> Result<AuthorizedPreviewScope, String> {
        let document = normalize_existing_path(file)?;
        if !document.is_file() {
            return Err("Path is not a file".into());
        }
        let mut state = self.lock()?;
        let document_origins = active_authority_origins_for_path(&state, &document);
        let root = state
            .grants
            .iter()
            .filter(|(_, ledger)| ledger.is_active())
            .filter_map(|(key, ledger)| match key {
                GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                    if path_is_under(&document, root)
                        && ledger_shares_current_origin(
                            &state,
                            root,
                            ledger,
                            &document_origins,
                        ) =>
                {
                    Some(root)
                }
                _ => None,
            })
            .max_by_key(|root| root.components().count())
            .cloned()
            .ok_or_else(|| {
                "File is outside the user-authorized session files and directories".to_string()
            })?;
        let lease = state.allocate_preview_lease(document.clone(), None)?;
        state.grant_once(
            GrantKey::InternalAsset(root.clone()),
            GrantOrigin::Preview(lease.clone()),
        )?;
        Ok(AuthorizedPreviewScope {
            document,
            root,
            lease,
        })
    }
    #[cfg(test)]
    pub(crate) fn preview_scope_for_anchored_file(
        &self,
        anchor: impl AsRef<Path>,
        file: impl AsRef<Path>,
    ) -> Result<AuthorizedPreviewScope, String> {
        self.preview_scope_for_anchored_file_with_root(anchor, file, None)
    }
    pub(crate) fn preview_scope_for_anchored_file_with_root(
        &self,
        anchor: impl AsRef<Path>,
        file: impl AsRef<Path>,
        workspace_root: Option<&Path>,
    ) -> Result<AuthorizedPreviewScope, String> {
        let anchor = normalize_existing_path(anchor)?;
        let document = normalize_existing_path(file)?;
        if !anchor.is_file() || !document.is_file() {
            return Err("Path is not a file".into());
        }
        let workspace_root = workspace_root.map(normalize_existing_path).transpose()?;
        if workspace_root.as_ref().is_some_and(|root| !root.is_dir()) {
            return Err("Workspace root is not a directory".into());
        }
        let mut state = self.lock()?;
        let anchor_origins = active_authority_origins_for_path(&state, &anchor);
        let root = if let Some(root) = workspace_root {
            anchored_preview_root_for_workspace(&state, &anchor, &document, &root, &anchor_origins)?
        } else {
            anchored_preview_root_for_directory(&state, &anchor, &document, &anchor_origins)?
        };
        let lease = state.allocate_preview_lease(document.clone(), Some(anchor.clone()))?;
        state.grant_once(
            GrantKey::InternalAsset(root.clone()),
            GrantOrigin::Preview(lease.clone()),
        )?;
        Ok(AuthorizedPreviewScope {
            document,
            root,
            lease,
        })
    }
    pub(crate) fn preview_lease_support_statuses(
        &self,
        leases: &[&PreviewLeaseId],
    ) -> Result<Vec<bool>, String> {
        let state = self.lock()?;
        Ok(leases
            .iter()
            .map(|lease| state.preview_lease_is_active_and_supported(lease))
            .collect())
    }
    #[cfg(test)]
    pub(crate) fn revoke_origin(&self, origin: &GrantOrigin, mode: RevokeOriginMode) -> Result<(), String> {
        let mut state = self.lock()?;
        state.revoke_origin(origin, mode)?;
        Ok(())
    }
    pub(crate) fn retire_preview_leases(
        &self,
        leases: &HashSet<PreviewLeaseId>,
    ) -> Result<(), PreviewRetirementError> {
        if leases.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(error) = self
            .next_preview_retirement_unavailable_error
            .lock()
            .map_err(|_| {
                PreviewRetirementError::AuthorizationUnavailable(
                    "Preview retirement unavailable test seam is poisoned".to_string(),
                )
            })?
            .take()
        {
            return Err(PreviewRetirementError::AuthorizationUnavailable(error));
        }
        let mut state = self
            .lock()
            .map_err(PreviewRetirementError::AuthorizationUnavailable)?;
        #[cfg(test)]
        if let Some(error) = self
            .next_preview_retirement_error
            .lock()
            .map_err(|_| {
                PreviewRetirementError::Recoverable(
                    "Preview retirement test seam is poisoned".to_string(),
                )
            })?
            .take()
        {
            return Err(PreviewRetirementError::Recoverable(error));
        }
        Self::retire_preview_leases_locked(&mut state, leases)
    }

    /// Revokes every still-tracked preview lease origin under the held
    /// authorization lock and advances the generation once for the batch.
    fn retire_preview_leases_locked(
        state: &mut AuthorizationState,
        leases: &HashSet<PreviewLeaseId>,
    ) -> Result<(), PreviewRetirementError> {
        let retiring = leases
            .iter()
            .filter(|lease| {
                let origin = GrantOrigin::Preview((*lease).clone());
                state
                    .grants
                    .values()
                    .any(|ledger| ledger.origins.contains_key(&origin))
            })
            .count() as u64;
        let next_generation = state
            .authorization_generation
            .checked_add(retiring)
            .ok_or_else(|| {
                PreviewRetirementError::AuthorizationUnavailable(
                    "Authorization generation is exhausted".to_string(),
                )
            })?;
        for lease in leases {
            state.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        state.authorization_generation = next_generation;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn revoke_authorized_file(
        &self,
        file: &AuthorizedFile,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let mut state = self.lock()?;
        state.revoke_origin_and_unsupported_previews(&file.origin, RevokeOriginMode::All)
    }
}
