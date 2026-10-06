//! AuthorizationState operations (later half).
//! AuthorizationState operations.
use super::*;

impl AuthorizationState {
    pub(crate) fn preview_lease_is_supported(&self, lease: &PreviewLeaseId) -> bool {
        let authority_document = lease.authority_anchor.as_deref().unwrap_or(&lease.document);
        let authority_origins = active_authority_origins_for_path(self, authority_document);

        self.grants.iter().any(|(key, ledger)| {
            ledger.is_active()
                && matches!(key, GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                    if path_is_under(&lease.document, root)
                        && path_is_under(authority_document, root))
                && ledger_shares_current_origin(self, key.path(), ledger, &authority_origins)
        })
    }

    pub(crate) fn preview_lease_is_active_and_supported(&self, lease: &PreviewLeaseId) -> bool {
        let origin = GrantOrigin::Preview(lease.clone());
        self.grants
            .values()
            .any(|ledger| ledger.is_active() && ledger.origins.contains_key(&origin))
            && self.preview_lease_is_supported(lease)
    }

    #[cfg(test)]
    pub(crate) fn revoke_origin_and_unsupported_previews(
        &mut self,
        origin: &GrantOrigin,
        mode: RevokeOriginMode,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        self.revoke_origin(origin, mode)?;
        let mut invalidated = self.unsupported_preview_leases();
        if let GrantOrigin::Preview(lease) = origin {
            invalidated.insert(lease.clone());
        }
        for lease in &invalidated {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated)
    }

    pub(crate) fn relocate_path_prefix(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        self.relocate_path_prefix_with_identity(old_prefix, new_prefix, None)
    }

    pub(crate) fn relocate_path_prefix_with_identity(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
        expected_identity: Option<&str>,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        if old_prefix == new_prefix {
            return Ok(HashSet::new());
        }
        let unbound_documents = if expected_identity.is_some() {
            self.unbound_renamed_document_ids(old_prefix)?
        } else {
            Vec::new()
        };
        let invalidates_preview = self.grants.values().any(|ledger| {
            ledger.origins.keys().any(|origin| {
                matches!(origin, GrantOrigin::Preview(lease)
                    if lease.intersects_prefix(old_prefix) || lease.intersects_prefix(new_prefix))
            })
        });
        let changes = self
            .workspaces
            .values()
            .any(|workspace| path_is_under(&workspace.root, old_prefix))
            || self
                .grants
                .keys()
                .any(|key| path_is_under(key.path(), old_prefix))
            || invalidates_preview;
        if !changes {
            return Ok(HashSet::new());
        }
        self.advance_authorization_generation()?;
        let invalidated_preview_leases =
            self.revoke_preview_leases_between_prefixes(old_prefix, new_prefix);
        self.relocate_bound_grant_paths(old_prefix, new_prefix);
        if let Some(expected_identity) = expected_identity {
            for document_id in unbound_documents {
                self.document_origin_identities
                    .insert(document_id, expected_identity.to_string());
            }
        }
        Ok(invalidated_preview_leases)
    }

    /// Collects the open-document identifiers under `old_prefix` that have no
    /// recorded platform identity yet, and pre-reserves room for the records
    /// the caller will insert after the relocation is applied.
    fn unbound_renamed_document_ids(
        &mut self,
        old_prefix: &Path,
    ) -> Result<Vec<DocumentGrantId>, String> {
        let document_ids = self
            .grants
            .iter()
            .filter(|(key, ledger)| {
                ledger.is_active()
                    && matches!(key, GrantKey::ExactReadWrite(path) if path_is_under(path, old_prefix))
            })
            .flat_map(|(_, ledger)| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::OpenDocument(id) => Some(*id),
                _ => None,
            })
            .collect::<HashSet<_>>();
        let unbound = document_ids
            .iter()
            .filter(|id| !self.document_origin_identities.contains_key(id))
            .copied()
            .collect::<Vec<_>>();
        self.document_origin_identities
            .try_reserve(unbound.len())
            .map_err(|_| "Cannot reserve renamed document identity provenance".to_string())?;
        Ok(unbound)
    }

    /// Revokes every preview lease whose grant key or lease anchors intersect
    /// either relocation prefix, returning the revoked leases.
    fn revoke_preview_leases_between_prefixes(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> HashSet<PreviewLeaseId> {
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger
                    .origins
                    .keys()
                    .filter_map(move |origin| match origin {
                        GrantOrigin::Preview(lease)
                            if path_is_under(key.path(), old_prefix)
                                || path_is_under(key.path(), new_prefix)
                                || lease.intersects_prefix(old_prefix)
                                || lease.intersects_prefix(new_prefix) =>
                        {
                            Some(lease.clone())
                        }
                        _ => None,
                    })
            })
            .collect::<HashSet<_>>();
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        invalidated_preview_leases
    }

    /// Rewrites workspace roots and grant keys from the old prefix onto the
    /// new prefix, merging ledgers that land on the same key.
    fn relocate_bound_grant_paths(&mut self, old_prefix: &Path, new_prefix: &Path) {
        for workspace in self.workspaces.values_mut() {
            if let Ok(suffix) = workspace.root.strip_prefix(old_prefix) {
                workspace.root = new_prefix.join(suffix);
            }
        }
        let grants = std::mem::take(&mut self.grants);
        for (key, ledger) in grants {
            let relocated_key = key.relocated(old_prefix, new_prefix);
            if let Some(existing) = self.grants.get_mut(&relocated_key) {
                existing.merge(ledger);
            } else {
                self.grants.insert(relocated_key, ledger);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn suspend_write_path(&mut self, path: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidated_preview_leases = self
            .grants
            .values()
            .flat_map(|ledger| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease) if lease.references_path(path) => {
                        Some(lease.clone())
                    }
                    _ => None,
                })
            })
            .collect::<HashSet<_>>();

        let suspends_grant = self
            .grants
            .get(&GrantKey::ExactReadWrite(path.to_path_buf()))
            .is_some_and(|ledger| ledger.status == GrantStatus::Active);
        if !suspends_grant && invalidated_preview_leases.is_empty() {
            return Ok(invalidated_preview_leases);
        }
        self.advance_authorization_generation()?;

        if let Some(ledger) = self
            .grants
            .get_mut(&GrantKey::ExactReadWrite(path.to_path_buf()))
        {
            ledger.suspend();
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated_preview_leases)
    }

    pub(crate) fn suspend_rename_path_prefixes(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<GrantKey>, String> {
        let is_affected =
            |path: &Path| path_is_under(path, old_prefix) || path_is_under(path, new_prefix);
        let affected = self
            .grants
            .iter()
            .filter_map(|(key, ledger)| {
                (matches!(
                    key,
                    GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
                ) && is_affected(key.path())
                    && ledger.status == GrantStatus::Active)
                    .then_some(key.clone())
            })
            .collect::<HashSet<_>>();
        if affected.is_empty() {
            return Ok(affected);
        }
        self.advance_authorization_generation()?;
        let mut transitioned_grants = HashSet::new();
        for (key, ledger) in &mut self.grants {
            if matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && is_affected(key.path())
                && ledger.status == GrantStatus::Active
            {
                ledger.suspend();
                transitioned_grants.insert(key.clone());
            }
        }
        Ok(transitioned_grants)
    }

}
