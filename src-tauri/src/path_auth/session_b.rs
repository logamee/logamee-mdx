//! FileAuthorizationSession operations (segment).
use super::*;

impl FileAuthorizationSession {
    #[cfg(test)]
    pub(crate) fn exact_write_grant_snapshot_for_test(
        &self,
        path: &Path,
    ) -> Result<Option<(GrantStatus, usize)>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .get(&GrantKey::ExactReadWrite(path.to_path_buf()))
            .map(|ledger| (ledger.status, ledger.origins.values().sum())))
    }
    #[cfg(test)]
    pub(crate) fn internal_asset_grant_snapshot_for_test(
        &self,
        path: &Path,
    ) -> Result<Option<(GrantStatus, usize)>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .get(&GrantKey::InternalAsset(path.to_path_buf()))
            .map(|ledger| (ledger.status, ledger.origins.values().sum())))
    }
    #[cfg(test)]
    pub(crate) fn preview_lease_snapshot(&self) -> Result<HashSet<PreviewLeaseId>, String> {
        let state = self.lock()?;
        Ok(state
            .grants
            .values()
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::Preview(lease) => Some(lease.clone()),
                _ => None,
            })
            .collect())
    }
    #[cfg(test)]
    pub(crate) fn fail_next_preview_retirement(
        &self,
        error: impl Into<String>,
    ) -> Result<(), String> {
        *self
            .next_preview_retirement_error
            .lock()
            .map_err(|_| "Preview retirement test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn fail_next_preview_retirement_as_unavailable(
        &self,
        error: impl Into<String>,
    ) -> Result<(), String> {
        *self
            .next_preview_retirement_unavailable_error
            .lock()
            .map_err(|_| "Preview retirement unavailable test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn fail_next_save_publish(&self, error: impl Into<String>) -> Result<(), String> {
        *self
            .next_save_publish_error
            .lock()
            .map_err(|_| "Save publication test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }
    pub(crate) fn workspace_candidate(&self, root: impl AsRef<Path>) -> Result<WorkspaceCandidate, String> {
        let root = normalize_existing_path(root)?;
        if !root.is_dir() {
            return Err("Authorized root must be a directory".into());
        }
        let root_binding = WorkspaceRootBinding::capture(&root)?;
        Ok(WorkspaceCandidate { root, root_binding })
    }
    #[cfg(test)]
    pub(crate) fn workspace_candidate_for_test(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<WorkspaceCandidate, String> {
        self.workspace_candidate(root)
    }
    pub(crate) fn open_workspace<S>(
        &self,
        root: impl AsRef<Path>,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, S), String> {
        let candidate = self.workspace_candidate(root)?;
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let mut state = self.lock()?;
        transport(&candidate.root)?;
        let workspace = Self::publish_workspace(&mut state, candidate)?;
        Ok((workspace, snapshot))
    }
    pub(crate) fn open_resource_directory(
        &self,
        root: impl AsRef<Path>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<AuthorizedWorkspace, String> {
        self.open_workspace(root, |_| Ok(()), transport)
            .map(|(authorization, ())| authorization)
    }
        #[cfg(test)]
    pub(crate) fn open_workspace_at_canonical_root<S>(
        &self,
        root: impl AsRef<Path>,
        expected_root: &Path,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(AuthorizedWorkspace, S), String> {
        let candidate = self.workspace_candidate(root)?;
        if candidate.root != expected_root {
            return Err("Saved workspace root changed while being restored".to_string());
        }
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let mut state = self.lock()?;
        transport(&candidate.root)?;
        let workspace = Self::publish_workspace(&mut state, candidate)?;
        Ok((workspace, snapshot))
    }
    pub(crate) fn prepare_workspace_authorization<S>(
        &self,
        owner_window: &str,
        root: impl AsRef<Path>,
        expected_root: Option<&Path>,
        snapshot: impl for<'a> FnOnce(WorkspaceSnapshotSource<'a>) -> Result<S, String>,
    ) -> Result<PreparedWorkspaceAuthorization<S>, String> {
        let candidate = self.workspace_candidate(root)?;
        if expected_root.is_some_and(|expected| candidate.root != expected) {
            return Err("Saved workspace root changed while being restored".to_string());
        }
        let snapshot = snapshot(WorkspaceSnapshotSource::Candidate(&candidate))?;
        let now = Instant::now();
        let mut state = self.lock()?;
        state
            .pending_workspace_authorities
            .retain(|_, pending| pending.expires_at > now);
        if state.pending_workspace_authorities.len() >= MAX_PENDING_WORKSPACE_AUTHORITIES {
            return Err("Too many workspace opens are awaiting completion".to_string());
        }
        let token = state.allocate_workspace_token()?;
        let workspace = AuthorizedWorkspace::new(
            token,
            candidate.root.clone(),
            candidate.root_binding.clone(),
        );
        let receipt = token.to_receipt();
        state.pending_workspace_authorities.insert(
            token,
            PendingWorkspaceReservation {
                owner_window: owner_window.to_string(),
                candidate,
                expires_at: now + PENDING_WORKSPACE_AUTHORITY_TTL,
            },
        );
        Ok(PreparedWorkspaceAuthorization {
            workspace,
            snapshot,
            receipt,
        })
    }
    pub(crate) fn settle_workspace_authorization(
        &self,
        owner_window: &str,
        receipt: &str,
        applied: bool,
        transport: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PreparedWorkspaceSettlement, String> {
        let token = WorkspaceToken::from_receipt(receipt)?;
        if token.to_receipt() != receipt {
            return Err("Invalid workspace open receipt".to_string());
        }
        let now = Instant::now();
        let mut state = self.lock()?;
        let target_expired = state
            .pending_workspace_authorities
            .get(&token)
            .is_some_and(|pending| pending.expires_at <= now);
        state
            .pending_workspace_authorities
            .retain(|_, pending| pending.expires_at > now);
        if target_expired {
            return Ok(PreparedWorkspaceSettlement::Expired);
        }
        let Some(pending) = state.pending_workspace_authorities.get(&token) else {
            return Ok(PreparedWorkspaceSettlement::Unknown);
        };
        if pending.owner_window != owner_window {
            return Err("Workspace open receipt belongs to another window".to_string());
        }
        let pending = state
            .pending_workspace_authorities
            .remove(&token)
            .expect("workspace reservation was checked while authorization was held");
        if !applied {
            return Ok(PreparedWorkspaceSettlement::Discarded);
        }

        let current = self.workspace_candidate(&pending.candidate.root)?;
        if current.root != pending.candidate.root
            || !current
                .root_binding
                .same_object(&pending.candidate.root_binding)
        {
            return Err("Workspace root changed before the open was applied".to_string());
        }
        let workspace = Self::publish_workspace_with_token(&mut state, token, current)?;
        if let Err(error) = transport(workspace.root()) {
            let origin = GrantOrigin::Workspace(token);
            state.revoke_origin_raw(&origin, RevokeOriginMode::All);
            return Err(error);
        }
        Ok(PreparedWorkspaceSettlement::Applied)
    }
    pub(crate) fn publish_workspace(
        state: &mut AuthorizationState,
        candidate: WorkspaceCandidate,
    ) -> Result<AuthorizedWorkspace, String> {
        let token = state.allocate_workspace_token()?;
        Self::publish_workspace_with_token(state, token, candidate)
    }
    pub(crate) fn publish_workspace_with_token(
        state: &mut AuthorizationState,
        token: WorkspaceToken,
        candidate: WorkspaceCandidate,
    ) -> Result<AuthorizedWorkspace, String> {
        if !candidate.root_binding.is_current(&candidate.root) {
            return Err("Workspace root changed before authorization was published".to_string());
        }
        state
            .authorization_generation
            .checked_add(2)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())?;
        let origin = GrantOrigin::Workspace(token);
        state.grant(
            GrantKey::DirectoryRead(candidate.root.clone()),
            origin.clone(),
        )?;
        state.grant(GrantKey::InternalAsset(candidate.root.clone()), origin)?;
        state.workspaces.insert(
            token,
            WorkspaceGrant {
                root: candidate.root.clone(),
                root_identity: candidate.root_binding.identity.clone(),
            },
        );
        Ok(AuthorizedWorkspace::new(
            token,
            candidate.root,
            candidate.root_binding,
        ))
    }
    #[cfg(test)]
    pub(crate) fn authorize_directory_root_with<F>(
        &self,
        root: impl AsRef<Path>,
        before_commit: F,
    ) -> Result<AuthorizedWorkspace, String>
    where
        F: FnOnce(&WorkspaceCandidate) -> Result<(), String>,
    {
        let candidate = self.workspace_candidate(root)?;
        let mut state = self.lock()?;
        before_commit(&candidate)?;
        Self::publish_workspace(&mut state, candidate)
    }
}
