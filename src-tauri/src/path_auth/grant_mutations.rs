//! Prepared grant mutations and reservation types.
use super::*;

impl SaveAuthorizationScope<'_> {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state.authorization_generation
    }

    pub(crate) fn has_exact_write_authority(&self) -> bool {
        self.state.grants.iter().any(|(key, ledger)| {
            matches!(key, GrantKey::ExactReadWrite(file)
                if file == &self.path && exact_grant_is_current(self.state, file, ledger))
        })
    }

    /// Restores exact-write currency after the granted file object was replaced
    /// under the still-authorized workspace root. Each workspace-bound document
    /// origin is re-opened through the workspace root binding (per-component
    /// O_NOFOLLOW) and its identity record is re-bound to the observed object.
    /// Content races stay governed by version arbitration at the durable writer;
    /// substitutions the workspace open rejects (symlinks, non-regular files,
    /// missing files, moved roots) leave the stale binding in place so the save
    /// fails closed.
    pub(crate) fn refresh_workspace_document_identity(&mut self) {
        if self.has_exact_write_authority() {
            return;
        }
        let Some(ledger) = self
            .state
            .grants
            .get(&GrantKey::ExactReadWrite(self.path.clone()))
        else {
            return;
        };
        if !ledger.is_active() {
            return;
        }
        let document_ids = ledger
            .origins
            .keys()
            .filter_map(|origin| match origin {
                GrantOrigin::OpenDocument(id) => Some(*id),
                _ => None,
            })
            .collect::<Vec<_>>();
        for document_id in document_ids {
            self.rebind_stale_document_identity(document_id);
        }
    }

    /// Re-opens one workspace-bound document origin through the current
    /// workspace root binding and re-binds its identity record to the
    /// observed object. Skips (returns without changes) whenever the
    /// workspace binding can no longer authorize the re-open, so the save
    /// fails closed.
    fn rebind_stale_document_identity(&mut self, document_id: DocumentGrantId) {
        let Some(token) = self
            .state
            .workspace_document_origins
            .get(&document_id)
            .copied()
        else {
            return;
        };
        let Some(workspace) = self.state.workspaces.get(&token) else {
            return;
        };
        let Some(binding) = capture_current_workspace_binding(workspace, &workspace.root)
        else {
            return;
        };
        let workspace_grant_is_active = self.state.grants.iter().any(|(key, grant_ledger)| {
            matches!(key, GrantKey::DirectoryRead(root)
                if *root == workspace.root
                    && grant_ledger.is_active()
                    && grant_ledger.origins.contains_key(&GrantOrigin::Workspace(token)))
        });
        if !workspace_grant_is_active {
            return;
        }
        let Ok(relative) = self.path.strip_prefix(&workspace.root) else {
            return;
        };
        let opened = binding.open_regular_file(relative);
        let Ok(opened) = opened else {
            return;
        };
        let Ok(identity) = opened_file_platform_identity(&opened) else {
            return;
        };
        if let Some(record) = self
            .state
            .document_origin_identities
            .get_mut(&document_id)
        {
            *record = identity;
        }
    }

    pub(crate) fn matches_pending(&self, pending: &PendingSaveAuthority) -> bool {
        pending.path == self.path
            && pending.generation == self.state.authorization_generation
            && self
                .state
                .pending_save_authorities
                .get(&pending.id)
                .is_some_and(|reservation| reservation.path == self.path)
    }

    pub(crate) fn capture_identity_origins(&self) -> Result<SaveIdentityOrigins, String> {
        let document_ids = self
            .state
            .grants
            .get(&GrantKey::ExactReadWrite(self.path.clone()))
            .into_iter()
            .filter(|ledger| ledger.is_active())
            .flat_map(|ledger| ledger.origins.keys())
            .filter_map(|origin| match origin {
                GrantOrigin::OpenDocument(id)
                    if self.state.document_origin_identities.contains_key(id)
                        && exact_origin_is_current_for_path(self.state, &self.path, origin) =>
                {
                    Some(*id)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let settlement_generation = if document_ids.is_empty() {
            None
        } else {
            Some(self.state.next_authorization_generation()?)
        };
        Ok(SaveIdentityOrigins {
            document_ids,
            settlement_generation,
        })
    }

    pub(crate) fn settle_identity_origins(
        &mut self,
        origins: &SaveIdentityOrigins,
        platform_identity: &str,
    ) {
        let changes = origins.document_ids.iter().any(|id| {
            self.state
                .document_origin_identities
                .get(id)
                .is_some_and(|identity| identity != platform_identity)
        });
        if !changes {
            return;
        }
        self.state.authorization_generation = origins
            .settlement_generation
            .expect("identity-bound save origins reserve their settlement generation");
        for id in &origins.document_ids {
            if let Some(identity) = self.state.document_origin_identities.get_mut(id) {
                *identity = platform_identity.to_string();
            }
        }
    }

    pub(crate) fn publish_pending(&mut self, pending: &PendingSaveAuthority) {
        debug_assert!(self.matches_pending(pending));
        let reservation = self
            .state
            .pending_save_authorities
            .remove(&pending.id)
            .expect("pending save reservation was checked while authorization was held");
        self.state.authorization_generation += 1;
        for mutation in reservation.mutations {
            match mutation {
                PreparedGrantMutation::Existing { key, origin } => {
                    let ledger = self
                        .state
                        .grants
                        .get_mut(&key)
                        .expect("pending save grant retains its reserved ledger");
                    ledger.origins.insert(origin, 1);
                    ledger.status = GrantStatus::Active;
                }
                PreparedGrantMutation::New { key, ledger } => {
                    let replaced = self.state.grants.insert(key, ledger);
                    debug_assert!(replaced.is_none());
                }
            }
        }
    }

    pub(crate) fn invalidate_pending(&mut self, pending: &PendingSaveAuthority) {
        if self
            .state
            .pending_save_authorities
            .remove(&pending.id)
            .is_some()
            && pending.generation == self.state.authorization_generation
        {
            self.state.authorization_generation += 1;
        }
    }
}

pub(crate) struct AuthorizedPreviewScope {
    pub(crate) document: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) lease: PreviewLeaseId,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum GrantOrigin {
    Workspace(WorkspaceToken),
    OpenDocument(DocumentGrantId),
    SaveAs(DocumentGrantId),
    CreatedDocument(DocumentGrantId),
    Preview(PreviewLeaseId),
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizationEvidenceGrant {
    pub(crate) kind: &'static str,
    pub(crate) path: String,
    pub(crate) origin: &'static str,
    pub(crate) status: &'static str,
    pub(crate) count: usize,
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizationEvidenceSnapshot {
    pub(crate) generation: u64,
    pub(crate) pending_workspace_receipts: usize,
    pub(crate) grants: Vec<AuthorizationEvidenceGrant>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum GrantKey {
    ExactReadWrite(PathBuf),
    DirectoryRead(PathBuf),
    InternalAsset(PathBuf),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GrantStatus {
    Active,
    Suspended,
}

pub(crate) struct GrantLedger {
    pub(crate) origins: HashMap<GrantOrigin, usize>,
    pub(crate) status: GrantStatus,
    pub(crate) first_granted_sequence: u64,
}
