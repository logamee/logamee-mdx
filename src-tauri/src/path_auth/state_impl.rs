//! AuthorizationState operations.
use super::*;

impl AuthorizationState {
    pub(crate) fn next_authorization_generation(&self) -> Result<u64, String> {
        self.authorization_generation
            .checked_add(1)
            .ok_or_else(|| "Authorization generation is exhausted".to_string())
    }

    pub(crate) fn advance_authorization_generation(&mut self) -> Result<(), String> {
        self.authorization_generation = self.next_authorization_generation()?;
        Ok(())
    }

    pub(crate) fn allocate_workspace_token(&mut self) -> Result<WorkspaceToken, String> {
        let id = self.next_workspace_token_id;
        self.next_workspace_token_id = id
            .checked_add(1)
            .ok_or_else(|| "Workspace authorization identifier space is exhausted".to_string())?;
        Ok(WorkspaceToken(id))
    }

    pub(crate) fn allocate_document_grant_id(&mut self) -> Result<DocumentGrantId, String> {
        let id = self.next_document_grant_id;
        self.next_document_grant_id = id
            .checked_add(1)
            .ok_or_else(|| "Document authorization identifier space is exhausted".to_string())?;
        Ok(DocumentGrantId(id))
    }

    pub(crate) fn allocate_preview_lease(
        &mut self,
        document: PathBuf,
        authority_anchor: Option<PathBuf>,
    ) -> Result<PreviewLeaseId, String> {
        let generation = self.next_preview_lease_id;
        self.next_preview_lease_id = generation
            .checked_add(1)
            .ok_or_else(|| "HTML preview lease identifier space is exhausted".to_string())?;
        Ok(PreviewLeaseId {
            generation,
            document,
            authority_anchor,
        })
    }

    pub(crate) fn grant(&mut self, key: GrantKey, origin: GrantOrigin) -> Result<(), String> {
        self.advance_authorization_generation()?;
        if let Some(ledger) = self.grants.get_mut(&key) {
            ledger.add_origin(origin);
            return Ok(());
        }
        let sequence = self.next_grant_sequence;
        self.next_grant_sequence = self.next_grant_sequence.saturating_add(1);
        self.grants.insert(key, GrantLedger::new(origin, sequence));
        Ok(())
    }

    pub(crate) fn grant_once(&mut self, key: GrantKey, origin: GrantOrigin) -> Result<(), String> {
        if self.grants.get(&key).is_some_and(|ledger| {
            ledger.status == GrantStatus::Active && ledger.origins.contains_key(&origin)
        }) {
            return Ok(());
        }
        self.advance_authorization_generation()?;
        if let Some(ledger) = self.grants.get_mut(&key) {
            ledger.origins.entry(origin).or_insert(1);
            ledger.status = GrantStatus::Active;
            return Ok(());
        }
        let sequence = self.next_grant_sequence;
        self.next_grant_sequence = self.next_grant_sequence.saturating_add(1);
        self.grants.insert(key, GrantLedger::new(origin, sequence));
        Ok(())
    }

    pub(crate) fn revoke_origin_raw(&mut self, origin: &GrantOrigin, mode: RevokeOriginMode) {
        for ledger in self.grants.values_mut() {
            ledger.revoke_origin(origin, mode);
        }
        self.grants.retain(|_, ledger| !ledger.origins.is_empty());
        if let GrantOrigin::Workspace(token) = origin {
            self.workspaces.remove(token);
        }
        if let GrantOrigin::OpenDocument(id) = origin {
            self.workspace_document_origins.remove(id);
            self.document_origin_identities.remove(id);
        }
    }

    #[cfg(test)]
    pub(crate) fn revoke_origin(
        &mut self,
        origin: &GrantOrigin,
        mode: RevokeOriginMode,
    ) -> Result<bool, String> {
        let changes = self
            .grants
            .values()
            .any(|ledger| ledger.origins.contains_key(origin))
            || matches!(origin, GrantOrigin::Workspace(token) if self.workspaces.contains_key(token));
        if !changes {
            return Ok(false);
        }
        self.advance_authorization_generation()?;
        self.revoke_origin_raw(origin, mode);
        Ok(true)
    }

    pub(crate) fn unsupported_preview_leases(&self) -> HashSet<PreviewLeaseId> {
        let preview_leases = self
            .grants
            .values()
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::Preview(lease) => Some(lease.clone()),
                _ => None,
            })
            .collect::<HashSet<_>>();

        preview_leases
            .into_iter()
            .filter(|lease| !self.preview_lease_is_supported(lease))
            .collect()
    }

}
