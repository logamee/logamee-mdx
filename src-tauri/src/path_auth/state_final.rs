//! AuthorizationState operations (final).
//! AuthorizationState operations (later half).
//! AuthorizationState operations.
use super::*;

impl AuthorizationState {
    pub(crate) fn restore_rename_grants(
        &mut self,
        transitioned_grants: &HashSet<GrantKey>,
    ) -> Result<(), String> {
        let changes = transitioned_grants.iter().any(|key| {
            self.grants.get(key).is_some_and(|ledger| {
                ledger.status == GrantStatus::Suspended && !ledger.origins.is_empty()
            })
        });
        if !changes {
            return Ok(());
        }
        self.advance_authorization_generation()?;
        for key in transitioned_grants {
            if let Some(ledger) = self.grants.get_mut(key) {
                if ledger.status == GrantStatus::Suspended && !ledger.origins.is_empty() {
                    ledger.status = GrantStatus::Active;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn finalize_indeterminate_rename(
        &mut self,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let _ = self.suspend_rename_path_prefixes(old_prefix, new_prefix)?;
        let is_affected =
            |path: &Path| path_is_under(path, old_prefix) || path_is_under(path, new_prefix);
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease)
                        if is_affected(key.path())
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
        Ok(invalidated_preview_leases)
    }

    pub(crate) fn suspend_delete_path_prefix(
        &mut self,
        prefix: &Path,
    ) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger.origins.keys().filter_map(|origin| match origin {
                    GrantOrigin::Preview(lease)
                        if path_is_under(key.path(), prefix) || lease.intersects_prefix(prefix) =>
                    {
                        Some(lease.clone())
                    }
                    _ => None,
                })
            })
            .collect::<HashSet<_>>();

        let suspends_grant = self.grants.iter().any(|(key, ledger)| {
            matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && path_is_under(key.path(), prefix)
                && ledger.status == GrantStatus::Active
        });
        if !suspends_grant && invalidated_preview_leases.is_empty() {
            return Ok(invalidated_preview_leases);
        }
        self.advance_authorization_generation()?;

        for (key, ledger) in &mut self.grants {
            if matches!(
                key,
                GrantKey::ExactReadWrite(_) | GrantKey::InternalAsset(_)
            ) && path_is_under(key.path(), prefix)
            {
                ledger.suspend();
            }
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        Ok(invalidated_preview_leases)
    }

    pub(crate) fn revoke_path_prefix(&mut self, prefix: &Path) -> Result<HashSet<PreviewLeaseId>, String> {
        let invalidates_preview = self.grants.values().any(|ledger| {
            ledger.origins.keys().any(|origin| {
                matches!(origin, GrantOrigin::Preview(lease) if lease.intersects_prefix(prefix))
            })
        });
        let changes = self
            .grants
            .keys()
            .any(|key| path_is_under(key.path(), prefix))
            || self
                .workspaces
                .values()
                .any(|workspace| path_is_under(&workspace.root, prefix))
            || invalidates_preview;
        if !changes {
            return Ok(HashSet::new());
        }
        self.advance_authorization_generation()?;
        Ok(self.revoke_path_prefix_entries(prefix))
    }

    /// Removes every grant, workspace, and preview lease under `prefix`.
    /// Only called once a change was detected and the authorization
    /// generation was advanced by the caller.
    fn revoke_path_prefix_entries(&mut self, prefix: &Path) -> HashSet<PreviewLeaseId> {
        let mut invalidated_preview_leases = self
            .grants
            .iter()
            .flat_map(|(key, ledger)| {
                ledger
                    .origins
                    .keys()
                    .filter_map(move |origin| match origin {
                        GrantOrigin::Preview(lease)
                            if path_is_under(key.path(), prefix)
                                || lease.intersects_prefix(prefix) =>
                        {
                            Some(lease.clone())
                        }
                        _ => None,
                    })
            })
            .collect::<HashSet<_>>();
        let origins = self
            .grants
            .iter()
            .filter(|(key, _)| path_is_under(key.path(), prefix))
            .flat_map(|(_, ledger)| ledger.origins.keys().cloned())
            .collect::<HashSet<_>>();
        for origin in origins {
            self.revoke_origin_raw(&origin, RevokeOriginMode::All);
        }
        for lease in &invalidated_preview_leases {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        self.grants
            .retain(|key, _| !path_is_under(key.path(), prefix));
        self.workspaces
            .retain(|_, workspace| !path_is_under(&workspace.root, prefix));
        let unsupported = self.unsupported_preview_leases();
        for lease in &unsupported {
            self.revoke_origin_raw(&GrantOrigin::Preview(lease.clone()), RevokeOriginMode::All);
        }
        invalidated_preview_leases.extend(unsupported);
        invalidated_preview_leases
    }
}
