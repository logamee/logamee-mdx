//! HTML embed acquisition inside an authorized scope.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;
use crate::path_auth::{
    normalize_existing_path,
    path_is_under,
    preview_lease_support_statuses_inner,
    preview_scope_for_anchored_file_with_root_inner,
    retire_preview_leases_inner,
    AuthorizedPreviewScope,
    PreviewRetirementError,
};

#[cfg(test)]
use super::super::preview_commit_test_probe;
use super::settle_site_transaction;
#[cfg(test)]
use super::super::HtmlPreviewSitesRecoveryError;
use super::super::{
    EmbeddedPreviewSite,
    HtmlEmbedPreviewCommit,
    HtmlEmbedSiteKey,
    HtmlPreviewSiteTransactionError,
    MarkdownHtmlEmbedHandle,
    PreviewLeaseId,
    MAX_PREVIEW_SITES,
    PREVIEW_AUTHORIZATION_CHANGED_ERROR,
    retire_rollback_leases,
};

use super::paths::relative_html_embed_path;

fn html_embed_site_transaction(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    key: HtmlEmbedSiteKey,
    reserved_lease: &PreviewLeaseId,
    owner_window: &str,
) -> Result<HtmlEmbedPreviewCommit, HtmlPreviewSiteTransactionError> {
    let mut sites = state
        .html_preview_server
        .lock_sites()
        .map_err(HtmlPreviewSiteTransactionError::SitesRecovery)?;
    let owner_id = sites
        .allocate_embed_owner_id()
        .map_err(HtmlPreviewSiteTransactionError::Operation)?;
    let (url, active_lease, retired_leases) = if let Some(site) = sites.embeds.get_mut(&key) {
        if site.root.as_path() != scope.root() {
            return Err(HtmlPreviewSiteTransactionError::Operation(
                "HTML embed scope changed while the site was active".to_string(),
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
                "Too many active HTML preview sites".to_string(),
            ));
        }
        let site = state
            .html_preview_server
            .start_disk_site(scope)
            .map_err(HtmlPreviewSiteTransactionError::Operation)?;
        let url = site.url.clone();
        sites.embeds.insert(
            key.clone(),
            EmbeddedPreviewSite::new(site, owner_id, owner_window),
        );
        (url, reserved_lease.clone(), HashSet::new())
    };
    Ok(HtmlEmbedPreviewCommit {
        key,
        url,
        owner_id,
        active_lease,
        retired_leases,
    })
}

fn embed_lease_statuses(
    state: &AppState,
    reserved_lease: &PreviewLeaseId,
    active_lease: &PreviewLeaseId,
) -> Result<(bool, bool), String> {
    let statuses = match preview_lease_support_statuses_inner(
        state,
        &[reserved_lease, active_lease],
    ) {
        Ok(statuses) => statuses,
        Err(error) => {
            let _ = state.html_preview_server.stop_all_sites();
            return Err(error);
        }
    };
    Ok((statuses[0], statuses[1]))
}

fn rollback_invalid_embed_owner(
    state: &AppState,
    key: &HtmlEmbedSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    reserved_lease: PreviewLeaseId,
    active_lease_is_valid: bool,
) -> Result<String, String> {
    let mut rollback_leases = retired_leases;
    rollback_leases.insert(reserved_lease);
    let rollback_error = match state.html_preview_server.rollback_committed_embed_owner(
        key,
        owner_id,
        active_lease,
        !active_lease_is_valid,
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
    retire_rollback_leases(state, &rollback_leases)?;
    Ok(rollback_error.unwrap_or_else(|| PREVIEW_AUTHORIZATION_CHANGED_ERROR.to_string()))
}

#[cfg(test)]
fn embed_recoverable_retire_rollback(
    state: &AppState,
    key: &HtmlEmbedSiteKey,
    owner_id: u64,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    error: String,
) -> Result<String, String> {
    let mut rollback_leases = state
        .html_preview_server
        .rollback_committed_embed_owner(key, owner_id, active_lease, false)
        .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
    rollback_leases.extend(retired_leases);
    retire_preview_leases_inner(state, &rollback_leases)
        .map_err(|error| error.into_message())?;
    Err(error)
}

fn finish_embed_retirement(
    state: &AppState,
    _key: &HtmlEmbedSiteKey,
    owner_id: u64,
    _active_lease: &PreviewLeaseId,
    url: String,
    retired_leases: HashSet<PreviewLeaseId>,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    match retire_preview_leases_inner(state, &retired_leases) {
        Ok(()) => Ok(MarkdownHtmlEmbedHandle { url, owner_id }),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => Err(embed_recoverable_retire_rollback(
            state,
            _key,
            owner_id,
            _active_lease,
            retired_leases,
            error,
        )?),
    }
}

fn prepare_html_embed_with_scope_inner(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    anchor: PathBuf,
    owner_window: &str,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    let reserved_lease = scope.lease().clone();
    let key = HtmlEmbedSiteKey {
        anchor,
        document: scope.document().to_path_buf(),
    };
    #[cfg(test)]
    preview_commit_test_probe::run(state, &reserved_lease);
    let site_transaction = if WorkspaceFileKind::classify(scope.document())
        != Some(WorkspaceFileKind::Html)
    {
        Err(HtmlPreviewSiteTransactionError::Operation(
            "HTML preview requires an HTML file".into(),
        ))
    } else {
        html_embed_site_transaction(state, scope, key, &reserved_lease, owner_window)
    };
    let commit = settle_site_transaction(state, &reserved_lease, site_transaction)?;
    let HtmlEmbedPreviewCommit {
        key: _key,
        url,
        owner_id: _owner_id,
        active_lease: _active_lease,
        retired_leases,
    } = commit;
    let (reserved_lease_is_valid, active_lease_is_valid) =
        embed_lease_statuses(state, &reserved_lease, &_active_lease)?;
    if !reserved_lease_is_valid || !active_lease_is_valid {
        return Err(rollback_invalid_embed_owner(
            state,
            &_key,
            _owner_id,
            &_active_lease,
            retired_leases,
            reserved_lease,
            active_lease_is_valid,
        )?);
    }
    finish_embed_retirement(state, &_key, _owner_id, &_active_lease, url, retired_leases)
}

pub(super) fn acquire_markdown_html_embed_with_root_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    owner_window: &str,
    workspace_root: Option<&Path>,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    let relative = relative_html_embed_path(html_src)?;
    let markdown = normalize_existing_path(markdown_path)
        .map_err(|_| "HTML embed requires an authorized Markdown file".to_string())?;
    if !markdown.is_file()
        || WorkspaceFileKind::classify(&markdown) != Some(WorkspaceFileKind::Markdown)
    {
        return Err("HTML embed requires an authorized Markdown file".into());
    }
    let markdown_parent = markdown
        .parent()
        .ok_or_else(|| "Markdown file has no parent directory".to_string())?;
    let target = normalize_existing_path(markdown_parent.join(relative))
        .map_err(|_| "HTML embed target is unavailable".to_string())?;
    if !target.is_file() {
        return Err("HTML embed target is not a file".into());
    }
    if workspace_root.is_none() && !path_is_under(&target, markdown_parent) {
        return Err("HTML embed target escaped the Markdown directory".into());
    }
    let scope =
        preview_scope_for_anchored_file_with_root_inner(state, &markdown, &target, workspace_root)?;
    prepare_html_embed_with_scope_inner(state, scope, markdown, owner_window)
}

#[cfg(test)]
pub(crate) fn prepare_markdown_html_embed_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
) -> Result<String, String> {
    acquire_markdown_html_embed_inner(state, markdown_path, html_src, "test")
        .map(|handle| handle.url)
}

#[cfg(test)]
pub(crate) fn prepare_markdown_html_embed_in_workspace_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    workspace_root: impl AsRef<Path>,
) -> Result<String, String> {
    acquire_markdown_html_embed_with_root_inner(
        state,
        markdown_path,
        html_src,
        "test",
        Some(workspace_root.as_ref()),
    )
    .map(|handle| handle.url)
}

#[cfg(test)]
pub(crate) fn acquire_markdown_html_embed_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    owner_window: &str,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    acquire_markdown_html_embed_with_root_inner(state, markdown_path, html_src, owner_window, None)
}
