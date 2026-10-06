//! Tail APIs: relocate, revoke, preview retirement.
use super::*;

#[cfg(test)]
pub(crate) fn relocate_authorized_path_prefix_inner(
    state: &AppState,
    old_prefix: &Path,
    new_prefix: &Path,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            state
                .file_authorization()
                .relocate_path_prefix(old_prefix, new_prefix)
        },
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
        },
    )
}

pub(crate) fn relocate_authorized_path_prefix_with_workspace_authorization_inner(
    state: &AppState,
    old_prefix: &Path,
    new_prefix: &Path,
    expected_identity: &str,
    authorization: &WorkspaceReadAuthorization,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            state
                .file_authorization()
                .relocate_path_prefix_with_workspace_authorization(
                    old_prefix,
                    new_prefix,
                    expected_identity,
                    authorization,
                )
        },
        |invalidated_preview_leases| {
            invalidate_preview_leases_after_authorization(state, &invalidated_preview_leases)
        },
    )
}

#[cfg(test)]
pub(crate) fn commit_indeterminate_delete_inner(
    state: &AppState,
    deleted_path: &Path,
) -> Result<(), String> {
    let mut authorization = state.file_authorization().lock()?;
    authorization.revoke_path_prefix(deleted_path)?;
    Ok(())
}

pub(crate) fn apply_authorization_then_preview_invalidation<T, R>(
    authorization: impl FnOnce() -> Result<T, String>,
    preview: impl FnOnce(T) -> Result<R, String>,
) -> Result<R, String> {
    let authorized = authorization()?;
    preview(authorized)
}

pub(crate) fn revoke_authorized_path_prefix_inner(
    state: &AppState,
    prefix: &Path,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || {
            let invalidated_preview_leases =
                state.file_authorization().revoke_path_prefix(prefix)?;
            state.workspace_index().discard_all();
            Ok(invalidated_preview_leases)
        },
        |invalidated_preview_leases| match state
            .html_preview_server
            .invalidate_preview_leases(&invalidated_preview_leases)
        {
            Ok(()) => Ok(()),
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_preview_leases_inner(state, &drained_leases)
                    .map_err(PreviewRetirementError::into_message)?;
                Err(error)
            }
        },
    )
}

#[cfg(test)]
pub(crate) fn revoke_authorized_file_inner(
    state: &AppState,
    file: &AuthorizedFile,
) -> Result<(), String> {
    apply_authorization_then_preview_invalidation(
        || state.file_authorization().revoke_authorized_file(file),
        |invalidated_preview_leases| match state
            .html_preview_server
            .invalidate_preview_leases(&invalidated_preview_leases)
        {
            Ok(()) => Ok(()),
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_preview_leases_inner(state, &drained_leases)
                    .map_err(PreviewRetirementError::into_message)?;
                Err(error)
            }
        },
    )
}

pub(crate) fn retire_preview_lease_inner(
    state: &AppState,
    lease: &PreviewLeaseId,
) -> Result<(), PreviewRetirementError> {
    retire_preview_leases_inner(state, &HashSet::from([lease.clone()]))
}

pub(crate) fn retire_preview_leases_inner(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), PreviewRetirementError> {
    state.file_authorization().retire_preview_leases(leases)
}
