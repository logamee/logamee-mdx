//! Prepared-grant reservation helpers for `session_c`.
use super::super::*;

impl FileAuthorizationSession {
    /// Pre-reserves room for the workspace-provenance records of one
    /// workspace-bound document grant.
    pub(super) fn reserve_workspace_provenance(
        state: &mut AuthorizationState,
    ) -> Result<(), String> {
        state
            .workspace_document_origins
            .try_reserve(1)
            .map_err(|_| "Cannot reserve workspace document provenance".to_string())?;
        state
            .document_origin_identities
            .try_reserve(1)
            .map_err(|_| "Cannot reserve document identity provenance".to_string())?;
        Ok(())
    }

    /// Derives the workspace-origin and identity records a prepared document
    /// grant will publish when it is bound to a workspace authorization.
    pub(super) fn workspace_origin_records(
        document_grant_id: DocumentGrantId,
        workspace_authorization: Option<&WorkspaceReadAuthorization>,
    ) -> (
        Option<(DocumentGrantId, WorkspaceToken)>,
        Option<(DocumentGrantId, String)>,
    ) {
        let workspace_document_origin = workspace_authorization
            .map(|authorization| (document_grant_id, authorization.token));
        let document_origin_identity = workspace_authorization.map(|authorization| {
            (document_grant_id, authorization.file_identity.clone())
        });
        (workspace_document_origin, document_origin_identity)
    }

    /// Pre-reserves grant-map and mutation capacity for a prepared document
    /// grant covering `keys`. The generation for the settlement is computed
    /// by the caller between this reservation and the mutation preparation.
    pub(super) fn reserve_document_grant_capacity(
        state: &mut AuthorizationState,
        keys: &[GrantKey; 2],
    ) -> Result<Vec<PreparedGrantMutation>, String> {
        let new_grant_count = keys
            .iter()
            .filter(|key| !state.grants.contains_key(*key))
            .count();
        state
            .grants
            .try_reserve(new_grant_count)
            .map_err(|_| "Cannot reserve document grants".to_string())?;

        let mut mutations = Vec::new();
        mutations
            .try_reserve_exact(keys.len())
            .map_err(|_| "Cannot reserve prepared document grants".to_string())?;
        Ok(mutations)
    }

    /// Records the prepared mutations for `keys` under `origin`, bumping the
    /// grant sequence once per newly created ledger.
    pub(super) fn prepare_document_grant_mutations(
        state: &mut AuthorizationState,
        origin: &GrantOrigin,
        keys: [GrantKey; 2],
        mutations: &mut Vec<PreparedGrantMutation>,
    ) -> Result<u64, String> {
        let mut next_grant_sequence = state.next_grant_sequence;
        for key in keys {
            if let Some(ledger) = state.grants.get_mut(&key) {
                ledger
                    .origins
                    .try_reserve(1)
                    .map_err(|_| "Cannot reserve document grant origin".to_string())?;
                mutations.push(PreparedGrantMutation::Existing {
                    key,
                    origin: origin.clone(),
                });
            } else {
                let ledger = GrantLedger::try_new(origin.clone(), next_grant_sequence)?;
                next_grant_sequence = next_grant_sequence
                    .checked_add(1)
                    .ok_or_else(|| "Document grant sequence is exhausted".to_string())?;
                mutations.push(PreparedGrantMutation::New { key, ledger });
            }
        }
        Ok(next_grant_sequence)
    }
}
