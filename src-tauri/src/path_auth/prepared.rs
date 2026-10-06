//! Prepared authorization and settlement types.
use super::*;

pub(crate) struct PreparedWorkspaceAuthorization<S> {
    pub(crate) workspace: AuthorizedWorkspace,
    pub(crate) snapshot: S,
    pub(crate) receipt: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreparedWorkspaceSettlement {
    Applied,
    Discarded,
    Expired,
    Unknown,
}

pub(crate) struct PreparedOpenDocumentGrant<'a> {
    pub(crate) state: AuthorizationGuard<'a>,
    pub(crate) mutations: Vec<PreparedGrantMutation>,
    pub(crate) workspace_authorization: Option<WorkspaceReadAuthorization>,
    pub(crate) workspace_document_origin: Option<(DocumentGrantId, WorkspaceToken)>,
    pub(crate) document_origin_identity: Option<(DocumentGrantId, String)>,
    pub(crate) next_document_grant_id: u64,
    pub(crate) next_grant_sequence: u64,
    pub(crate) next_authorization_generation: u64,
}

impl PreparedOpenDocumentGrant<'_> {
    pub(crate) fn apply(mut self) -> Result<(), String> {
        if self
            .workspace_authorization
            .as_ref()
            .is_some_and(|authorization| {
                !workspace_read_authorization_is_current(&self.state, authorization)
            })
        {
            return Err("Workspace file identity changed before open was committed".to_string());
        }
        self.state.next_document_grant_id = self.next_document_grant_id;
        self.state.next_grant_sequence = self.next_grant_sequence;
        self.state.authorization_generation = self.next_authorization_generation;
        Self::commit_prepared_mutations(&mut self.state, self.mutations);
        if let Some((document_id, workspace_token)) = self.workspace_document_origin {
            let replaced = self
                .state
                .workspace_document_origins
                .insert(document_id, workspace_token);
            debug_assert!(replaced.is_none());
        }
        if let Some((document_id, file_identity)) = self.document_origin_identity {
            let replaced = self
                .state
                .document_origin_identities
                .insert(document_id, file_identity);
            debug_assert!(replaced.is_none());
        }
        Ok(())
    }

    fn commit_prepared_mutations(
        state: &mut AuthorizationState,
        mutations: Vec<PreparedGrantMutation>,
    ) {
        for mutation in mutations {
            match mutation {
                PreparedGrantMutation::Existing { key, origin } => {
                    let ledger = state
                        .grants
                        .get_mut(&key)
                        .expect("prepared grant retains the authorization lock");
                    ledger.origins.insert(origin, 1);
                    ledger.status = GrantStatus::Active;
                }
                PreparedGrantMutation::New { key, ledger } => {
                    let replaced = state.grants.insert(key, ledger);
                    debug_assert!(replaced.is_none());
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RevokeOriginMode {
    All,
}
