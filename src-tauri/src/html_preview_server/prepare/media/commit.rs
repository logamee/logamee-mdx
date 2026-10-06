//! Media preview commit settlement, lease validation and rollback paths.
use std::collections::HashSet;

use crate::html_preview_server::{
    EmbeddedPreviewSite,
    HtmlPreviewSiteTransactionError,
    MediaPreviewCommit,
    MediaPreviewSiteKey,
    MAX_PREVIEW_SITES,
    PREVIEW_AUTHORIZATION_CHANGED_ERROR,
    retire_rollback_leases,
};
use crate::path_auth::{
    preview_lease_support_statuses_inner,
    retire_preview_lease_inner,
    retire_preview_leases_inner,
    AuthorizedPreviewScope,
    PreviewLeaseId,
    PreviewRetirementError,
};
use crate::state::AppState;

pub(super) fn media_site_transaction(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    key: MediaPreviewSiteKey,
    reserved_lease: &PreviewLeaseId,
    owner_window: &str,
) -> Result<MediaPreviewCommit, HtmlPreviewSiteTransactionError> {
    let mut sites = state
        .html_preview_server
        .lock_sites()
        .map_err(HtmlPreviewSiteTransactionError::SitesRecovery)?;
    let owner_id = sites
        .allocate_embed_owner_id()
        .map_err(HtmlPreviewSiteTransactionError::Operation)?;
    let (url, active_lease, retired_leases) = if let Some(site) = sites.media.get_mut(&key) {
        if site.root.as_path() != scope.root() {
            return Err(HtmlPreviewSiteTransactionError::Operation(
                "Media preview scope changed while the site was active".to_string(),
            ));
        }
        site.owners.insert(owner_id, owner_window.to_string());
        (
            site.url.clone(),
            site.lease.clone(),
            HashSet::from([reserved_lease.clone()]),
        )
    } else {
        if sites.len_all() >= MAX_PREVIEW_SITES {
            return Err(HtmlPreviewSiteTransactionError::Operation(
                "Too many active preview sites".to_string(),
            ));
        }
        let site = state
            .html_preview_server
            .start_disk_site(scope)
            .map_err(HtmlPreviewSiteTransactionError::Operation)?;
        let url = site.url.clone();
        sites.media.insert(
            key.clone(),
            EmbeddedPreviewSite::new(site, owner_id, owner_window),
        );
        (url, reserved_lease.clone(), HashSet::new())
    };
    Ok(MediaPreviewCommit {
        key,
        url,
        owner_id,
        active_lease,
        retired_leases,
    })
}

pub(super) fn settle_media_transaction(
    state: &AppState,
    reserved_lease: &PreviewLeaseId,
    site_transaction: Result<MediaPreviewCommit, HtmlPreviewSiteTransactionError>,
) -> Result<MediaPreviewCommit, String> {
    match site_transaction {
        Ok(committed) => Ok(committed),
        Err(HtmlPreviewSiteTransactionError::Operation(error)) => {
            match retire_preview_lease_inner(state, reserved_lease) {
                Ok(()) => Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    Err(error)
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => Err(error),
            }
        }
        Err(HtmlPreviewSiteTransactionError::SitesRecovery(recovery)) => {
            let (error, mut rollback_leases) = recovery.into_parts();
            rollback_leases.insert(reserved_lease.clone());
            retire_preview_leases_inner(state, &rollback_leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}

fn drained_media_rollback(
    state: &AppState,
    key: &MediaPreviewSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    remove_generation: bool,
    mut rollback_leases: HashSet<PreviewLeaseId>,
) -> (HashSet<PreviewLeaseId>, Option<String>) {
    let rollback_error = match state.html_preview_server.rollback_committed_media_owner(
        key,
        owner_id,
        active_lease,
        remove_generation,
    ) {
        Ok(removed_leases) => {
            rollback_leases.extend(removed_leases);
            None
        }
        Err(recovery) => {
            let (error, drained_leases) = recovery.into_parts();
            rollback_leases.extend(drained_leases);
            Some(error)
        }
    };
    (rollback_leases, rollback_error)
}

fn media_status_error_rollback(
    state: &AppState,
    key: &MediaPreviewSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    reserved_lease: PreviewLeaseId,
    error: String,
) -> Result<String, String> {
    let mut rollback_leases = retired_leases;
    rollback_leases.insert(reserved_lease);
    let (rollback_leases, _) =
        drained_media_rollback(state, key, owner_id, active_lease, true, rollback_leases);
    retire_rollback_leases(state, &rollback_leases)?;
    Ok(error)
}

fn rollback_invalid_media_owner(
    state: &AppState,
    key: &MediaPreviewSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    reserved_lease: PreviewLeaseId,
    active_lease_is_valid: bool,
) -> Result<String, String> {
    let mut rollback_leases = retired_leases;
    rollback_leases.insert(reserved_lease);
    let (rollback_leases, rollback_error) = drained_media_rollback(
        state,
        key,
        owner_id,
        active_lease,
        !active_lease_is_valid,
        rollback_leases,
    );
    retire_rollback_leases(state, &rollback_leases)?;
    Ok(rollback_error.unwrap_or_else(|| PREVIEW_AUTHORIZATION_CHANGED_ERROR.to_string()))
}

#[cfg(test)]
pub(super) fn media_recoverable_retire_rollback(
    state: &AppState,
    key: &MediaPreviewSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    error: String,
) -> Result<String, String> {
    let (rollback_leases, rollback_error) = drained_media_rollback(
        state,
        key,
        owner_id,
        active_lease,
        false,
        retired_leases,
    );
    retire_preview_leases_inner(state, &rollback_leases)
        .map_err(PreviewRetirementError::into_message)?;
    if let Some(rollback_error) = rollback_error {
        return Err(rollback_error);
    }
    Err(error)
}

pub(super) fn enforce_media_lease_statuses(
    state: &AppState,
    key: &MediaPreviewSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    reserved_lease: PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
) -> Result<HashSet<PreviewLeaseId>, String> {
    let lease_statuses = match preview_lease_support_statuses_inner(
        state,
        &[&reserved_lease, active_lease],
    ) {
        Ok(statuses) => statuses,
        Err(error) => {
            return Err(media_status_error_rollback(
                state,
                key,
                owner_id,
                active_lease,
                retired_leases,
                reserved_lease,
                error,
            )?);
        }
    };
    if lease_statuses[0] && lease_statuses[1] {
        return Ok(retired_leases);
    }
    Err(rollback_invalid_media_owner(
        state,
        key,
        owner_id,
        active_lease,
        retired_leases,
        reserved_lease,
        lease_statuses[1],
    )?)
}
