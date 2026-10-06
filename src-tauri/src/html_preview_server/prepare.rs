use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use tauri::State;

use crate::path_auth::{
    preview_lease_support_statuses_inner,
    preview_scope_for_file_inner,
    retire_preview_lease_inner,
    retire_preview_leases_inner,
    AuthorizedPreviewScope,
    PreviewRetirementError,
};
use crate::path_auth::PreviewLeaseId;
use crate::state::AppState;
use crate::workspace_file_kind::WorkspaceFileKind;

#[cfg(test)]
use super::preview_commit_test_probe;
#[cfg(test)]
use super::HtmlPreviewSitesRecoveryError;
use super::{
    HtmlPreviewCommit,
    HtmlPreviewSiteTransactionError,
    MarkdownHtmlEmbedHandle,
    MAX_PREVIEW_SITES,
    PREVIEW_AUTHORIZATION_CHANGED_ERROR,
    retire_rollback_leases,
};

pub(super) fn settle_site_transaction<T>(
    state: &AppState,
    reserved_lease: &PreviewLeaseId,
    site_transaction: Result<T, HtmlPreviewSiteTransactionError>,
) -> Result<T, String> {
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
            match retire_preview_leases_inner(state, &rollback_leases) {
                Ok(()) => Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    Err(error)
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => Err(error),
            }
        }
    }
}

pub(crate) fn prepare_html_preview_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<String, String> {
    let path = path.as_ref().to_path_buf();
    let scope = preview_scope_for_file_inner(state, path)?;
    prepare_html_preview_with_scope_inner(state, scope, content)
}

mod embed;
mod media;
mod paths;
mod release;

#[cfg(test)]
pub(crate) use embed::{acquire_markdown_html_embed_inner, prepare_markdown_html_embed_inner, prepare_markdown_html_embed_in_workspace_inner};
pub(crate) use media::{prepare_media_preview_inner, prepare_media_preview_with_scope_inner, release_media_preview_inner, MediaPreviewHandle};
pub(crate) use release::{release_markdown_html_embed_inner, release_markdown_html_embed_window_inner};
use embed::acquire_markdown_html_embed_with_root_inner;

fn html_site_transaction(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    document: PathBuf,
    content: &str,
    active_lease: PreviewLeaseId,
) -> Result<HtmlPreviewCommit, HtmlPreviewSiteTransactionError> {
    let mut sites = state
        .html_preview_server
        .lock_sites()
        .map_err(HtmlPreviewSiteTransactionError::SitesRecovery)?;
    let root_changed = sites
        .get(&document)
        .is_some_and(|site| site.root.as_path() != scope.root());
    let (url, retired_lease) = if root_changed {
        let replacement = state
            .html_preview_server
            .start_site(scope, content.to_string())
            .map_err(HtmlPreviewSiteTransactionError::Operation)?;
        let url = replacement.url.clone();
        let replaced = sites
            .insert(document.clone(), replacement)
            .expect("root comparison found an existing preview site");
        let retired_lease = replaced.lease.clone();
        drop(replaced);
        (url, Some(retired_lease))
    } else if let Some(site) = sites.get_mut(&document) {
        let (_, _, lease) = scope.into_parts();
        let (url, retired_lease) = site
            .update(content, lease)
            .map_err(HtmlPreviewSiteTransactionError::Operation)?;
        (url, Some(retired_lease))
    } else {
        if sites.len_all() >= MAX_PREVIEW_SITES {
            return Err(HtmlPreviewSiteTransactionError::Operation(
                "Too many active HTML preview sites".to_string(),
            ));
        }
        let site = state
            .html_preview_server
            .start_site(scope, content.to_string())
            .map_err(HtmlPreviewSiteTransactionError::Operation)?;
        let url = site.url.clone();
        sites.insert(document.clone(), site);
        (url, None)
    };
    Ok(HtmlPreviewCommit {
        document,
        url,
        active_lease,
        retired_leases: retired_lease.into_iter().collect(),
    })
}

fn rollback_invalid_html_commit(
    state: &AppState,
    document: &Path,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
) -> Result<String, String> {
    let mut rollback_leases = retired_leases;
    rollback_leases.insert(active_lease.clone());
    let rollback_error = match state
        .html_preview_server
        .remove_committed_generation(document, active_lease)
    {
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
fn html_recoverable_retire_rollback(
    state: &AppState,
    document: &Path,
    active_lease: &PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
    error: String,
) -> Result<String, String> {
    let mut rollback_leases = state
        .html_preview_server
        .remove_committed_generation(document, active_lease)
        .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
    rollback_leases.extend(retired_leases);
    retire_preview_leases_inner(state, &rollback_leases)
        .map_err(|error| error.into_message())?;
    Err(error)
}

fn prepare_html_preview_with_scope_inner(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    content: &str,
) -> Result<String, String> {
    let reserved_lease = scope.lease().clone();
    let active_lease = reserved_lease.clone();
    let document = scope.document().to_path_buf();
    #[cfg(test)]
    preview_commit_test_probe::run(state, &reserved_lease);
    let site_transaction = if WorkspaceFileKind::classify(scope.document())
        != Some(WorkspaceFileKind::Html)
    {
        Err(HtmlPreviewSiteTransactionError::Operation(
            "HTML preview requires an HTML file".into(),
        ))
    } else {
        html_site_transaction(state, scope, document, content, active_lease)
    };
    let commit = settle_site_transaction(state, &reserved_lease, site_transaction)?;
    let HtmlPreviewCommit {
        document: _document,
        url,
        active_lease: _active_lease,
        retired_leases,
    } = commit;
    let lease_is_valid = match preview_lease_support_statuses_inner(state, &[&_active_lease]) {
        Ok(statuses) => statuses[0],
        Err(error) => {
            let _ = state.html_preview_server.stop_all_sites();
            return Err(error);
        }
    };
    if !lease_is_valid {
        return Err(rollback_invalid_html_commit(
            state,
            &_document,
            &_active_lease,
            retired_leases,
        )?);
    }
    match retire_preview_leases_inner(state, &retired_leases) {
        Ok(()) => Ok(url),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => Err(
            html_recoverable_retire_rollback(state, &_document, &_active_lease, retired_leases, error)?,
        ),
    }
}

#[tauri::command]
pub(crate) fn prepare_html_preview(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    prepare_html_preview_inner(&state, path, &content)
}

#[tauri::command]
pub(crate) fn prepare_markdown_html_embed(
    markdown_path: String,
    html_src: String,
    workspace_root: Option<String>,
    webview_window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    acquire_markdown_html_embed_with_root_inner(
        &state,
        markdown_path,
        &html_src,
        webview_window.label(),
        workspace_root.as_deref().map(Path::new),
    )
}

#[tauri::command]
pub(crate) fn release_markdown_html_embed(
    owner_id: u64,
    webview_window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    release_markdown_html_embed_inner(&state, owner_id, webview_window.label())
}
