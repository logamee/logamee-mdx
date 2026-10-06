//! Pending-save reservation helpers for `session_a`.
use super::super::*;

/// Pre-reserves the save-as authorization capacity (grant map, pending
/// reservation slot, and mutation vector) and records the prepared mutations
/// for `keys` under the save-as `origin`, bumping the grant sequence once per
/// newly created ledger. Returns the mutations together with the next grant
/// sequence for the caller to persist.
pub(super) fn prepare_pending_save_mutations(
    state: &mut AuthorizationState,
    origin: &GrantOrigin,
    keys: Vec<GrantKey>,
) -> Result<(Vec<PreparedGrantMutation>, u64), String> {
    let new_grant_count = keys
        .iter()
        .filter(|key| !state.grants.contains_key(*key))
        .count();
    state
        .grants
        .try_reserve(new_grant_count)
        .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
    state
        .pending_save_authorities
        .try_reserve(1)
        .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
    let mut mutations = Vec::new();
    mutations
        .try_reserve_exact(keys.len())
        .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
    let mut next_grant_sequence = state.next_grant_sequence;
    for key in keys {
        if let Some(ledger) = state.grants.get_mut(&key) {
            ledger
                .origins
                .try_reserve(1)
                .map_err(|_| "Cannot reserve save-as authorization".to_string())?;
            mutations.push(PreparedGrantMutation::Existing {
                key,
                origin: origin.clone(),
            });
        } else {
            mutations.push(PreparedGrantMutation::New {
                key,
                ledger: GrantLedger::try_new(origin.clone(), next_grant_sequence)?,
            });
            next_grant_sequence = next_grant_sequence
                .checked_add(1)
                .ok_or_else(|| "Document grant sequence is exhausted".to_string())?;
        }
    }
    Ok((mutations, next_grant_sequence))
}
