//! Embed lease retirement and release commands.
use std::collections::HashSet;

use crate::state::AppState;
use crate::path_auth::{
    retire_preview_leases_inner,
    PreviewRetirementError
};

use super::super::{
    PreviewLeaseId,
};


pub(super) fn retire_released_embed_leases(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    if leases.is_empty() {
        return Ok(());
    }
    match retire_preview_leases_inner(state, leases) {
        Ok(()) => Ok(()),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            retire_preview_leases_inner(state, leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}

pub(crate) fn release_markdown_html_embed_inner(
    state: &AppState,
    owner_id: u64,
    owner_window: &str,
) -> Result<(), String> {
    let retired_lease = {
        let mut sites = match state.html_preview_server.lock_sites() {
            Ok(sites) => sites,
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_released_embed_leases(state, &drained_leases)?;
                return Err(error);
            }
        };
        let Some(key) = sites.embeds.iter().find_map(|(key, site)| {
            site.owners
                .get(&owner_id)
                .filter(|window| window.as_str() == owner_window)
                .map(|_| key.clone())
        }) else {
            return Ok(());
        };
        let should_remove = {
            let site = sites
                .embeds
                .get_mut(&key)
                .expect("owner lookup found an embedded preview site");
            site.owners.remove(&owner_id);
            site.owners.is_empty()
        };
        should_remove
            .then(|| sites.embeds.remove(&key).map(|site| site.lease.clone()))
            .flatten()
    };

    retire_released_embed_leases(state, &retired_lease.into_iter().collect())
}

pub(crate) fn release_markdown_html_embed_window_inner(
    state: &AppState,
    owner_window: &str,
) -> Result<(), String> {
    let retired_leases = {
        let mut sites = match state.html_preview_server.lock_sites() {
            Ok(sites) => sites,
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_released_embed_leases(state, &drained_leases)?;
                return Err(error);
            }
        };
        for site in sites.embeds.values_mut() {
            site.owners.retain(|_, window| window != owner_window);
        }
        for site in sites.media.values_mut() {
            site.owners.retain(|_, window| window != owner_window);
        }
        let empty_embed_sites = sites
            .embeds
            .iter()
            .filter_map(|(key, site)| site.owners.is_empty().then_some(key.clone()))
            .collect::<Vec<_>>();
        let empty_media_sites = sites
            .media
            .iter()
            .filter_map(|(key, site)| site.owners.is_empty().then_some(key.clone()))
            .collect::<Vec<_>>();
        let mut retired_leases = empty_embed_sites
            .into_iter()
            .filter_map(|key| sites.embeds.remove(&key).map(|site| site.lease.clone()))
            .collect::<HashSet<_>>();
        retired_leases.extend(
            empty_media_sites
                .into_iter()
                .filter_map(|key| sites.media.remove(&key).map(|site| site.lease.clone())),
        );
        retired_leases
    };

    retire_released_embed_leases(state, &retired_leases)
}
