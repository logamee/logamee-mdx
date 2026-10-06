//! Media preview preparation, lease scoping and release.
use serde::Serialize;
use std::{
    collections::HashSet,
    path::Path,
};

use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;
use crate::path_auth::{
    preview_scope_for_file_inner,
    retire_preview_leases_inner,
    AuthorizedPreviewScope,
    PreviewRetirementError,
};

#[cfg(test)]
use super::super::preview_commit_test_probe;
use super::release::retire_released_embed_leases;
use super::super::{
    HtmlPreviewSitesRecoveryError,
    MediaPreviewCommit,
    MediaPreviewSiteKey,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaPreviewHandle {
    pub(crate) url: String,
    pub(crate) owner_id: u64,
}

pub(crate) fn prepare_media_preview_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    owner_window: &str,
) -> Result<MediaPreviewHandle, String> {
    let scope = preview_scope_for_file_inner(state, path)?;
    if !matches!(
        WorkspaceFileKind::classify(scope.document()),
        Some(WorkspaceFileKind::Video | WorkspaceFileKind::Audio)
    ) {
        return Err("Media preview requires an audio or video file".into());
    }
    prepare_media_preview_with_scope_inner(state, scope, owner_window)
}

mod commit;

use commit::{enforce_media_lease_statuses, media_site_transaction, settle_media_transaction};
#[cfg(test)]
use commit::media_recoverable_retire_rollback;

pub(crate) fn prepare_media_preview_with_scope_inner(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    owner_window: &str,
) -> Result<MediaPreviewHandle, String> {
    let reserved_lease = scope.lease().clone();
    let key = MediaPreviewSiteKey(scope.document().to_path_buf());
    #[cfg(test)]
    preview_commit_test_probe::run(state, &reserved_lease);
    let site_transaction = media_site_transaction(state, scope, key, &reserved_lease, owner_window);
    let commit = settle_media_transaction(state, &reserved_lease, site_transaction)?;
    let MediaPreviewCommit {
        key,
        url,
        owner_id,
        active_lease,
        retired_leases,
    } = commit;
    let retired_leases = enforce_media_lease_statuses(
        state,
        &key,
        owner_id,
        &active_lease,
        reserved_lease,
        retired_leases,
    )?;
    match retire_preview_leases_inner(state, &retired_leases) {
        Ok(()) => Ok(MediaPreviewHandle { url, owner_id }),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => Err(
            media_recoverable_retire_rollback(
                state,
                &key,
                owner_id,
                &active_lease,
                retired_leases,
                error,
            )?,
        ),
    }
}

pub(crate) fn release_media_preview_inner(
    state: &AppState,
    owner_id: u64,
    owner_window: &str,
) -> Result<(), String> {
    let retired_leases = {
        let mut sites = state
            .html_preview_server
            .lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
        sites.media.iter_mut().for_each(|(_, site)| {
            site.owners
                .retain(|id, window| !(*id == owner_id && window == owner_window));
        });
        let empty_sites = sites
            .media
            .iter()
            .filter_map(|(key, site)| site.owners.is_empty().then_some(key.clone()))
            .collect::<Vec<_>>();
        empty_sites
            .into_iter()
            .filter_map(|key| sites.media.remove(&key).map(|site| site.lease.clone()))
            .collect::<HashSet<_>>()
    };
    retire_released_embed_leases(state, &retired_leases)
}
