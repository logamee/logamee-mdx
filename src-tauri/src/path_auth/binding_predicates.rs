//! Grant-currency predicates over workspace bindings.
use super::*;

pub(crate) fn capture_current_workspace_binding(
    workspace: &WorkspaceGrant,
    root: &Path,
) -> Option<WorkspaceRootBinding> {
    if workspace.root != root {
        return None;
    }
    let binding = WorkspaceRootBinding::capture(root).ok()?;
    (binding.identity == workspace.root_identity).then_some(binding)
}

pub(crate) fn directory_read_grant_is_current(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> bool {
    ledger.origins.keys().any(|origin| {
        let GrantOrigin::Workspace(token) = origin else {
            return false;
        };
        state
            .workspaces
            .get(token)
            .is_some_and(|workspace| capture_current_workspace_binding(workspace, root).is_some())
    })
}

pub(crate) fn current_workspace_binding_for_directory_grant(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> Option<(WorkspaceToken, WorkspaceRootBinding)> {
    ledger.origins.keys().find_map(|origin| {
        let GrantOrigin::Workspace(token) = origin else {
            return None;
        };
        state.workspaces.get(token).and_then(|workspace| {
            capture_current_workspace_binding(workspace, root).map(|binding| (*token, binding))
        })
    })
}

#[cfg(test)]
pub(crate) fn current_workspace_token_for_path(
    state: &AuthorizationState,
    path: &Path,
) -> Option<WorkspaceToken> {
    state
        .grants
        .iter()
        .filter_map(|(key, ledger)| {
            let GrantKey::DirectoryRead(root) = key else {
                return None;
            };
            if !ledger.is_active() || !path_is_under(path, root) {
                return None;
            }
            current_workspace_binding_for_directory_grant(state, root, ledger)
                .map(|(token, _)| (root.components().count(), token))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, token)| token)
}

pub(crate) fn internal_asset_grant_is_current(
    state: &AuthorizationState,
    root: &Path,
    ledger: &GrantLedger,
) -> bool {
    ledger.origins.keys().any(|origin| match origin {
        GrantOrigin::Preview(lease) => state.preview_lease_is_active_and_supported(lease),
        _ => grant_origin_is_current_for_path(state, root, origin),
    })
}

pub(crate) fn workspace_origin_is_current(
    state: &AuthorizationState,
    token: &WorkspaceToken,
    path: &Path,
) -> bool {
    state.workspaces.get(token).is_some_and(|workspace| {
        path_is_under(path, &workspace.root)
            && capture_current_workspace_binding(workspace, &workspace.root).is_some()
    })
}

pub(crate) fn grant_origin_is_current_for_path(
    state: &AuthorizationState,
    path: &Path,
    origin: &GrantOrigin,
) -> bool {
    match origin {
        GrantOrigin::Workspace(token) => workspace_origin_is_current(state, token, path),
        GrantOrigin::OpenDocument(id) => state
            .workspace_document_origins
            .get(id)
            .is_none_or(|token| workspace_origin_is_current(state, token, path)),
        GrantOrigin::SaveAs(_) | GrantOrigin::CreatedDocument(_) => true,
        GrantOrigin::Preview(_) => false,
    }
}

pub(crate) fn current_file_identity_for_origin(
    state: &AuthorizationState,
    path: &Path,
    workspace_token: Option<&WorkspaceToken>,
) -> Option<String> {
    let file = if let Some(token) = workspace_token {
        let workspace = state.workspaces.get(token)?;
        let binding = capture_current_workspace_binding(workspace, &workspace.root)?;
        let relative = path.strip_prefix(&workspace.root).ok()?;
        binding.open_regular_file(relative).ok()?
    } else {
        open_regular_file_without_following_links(path).ok()?
    };
    opened_file_platform_identity(&file).ok()
}

pub(crate) fn exact_origin_is_current_for_path(
    state: &AuthorizationState,
    path: &Path,
    origin: &GrantOrigin,
) -> bool {
    if !grant_origin_is_current_for_path(state, path, origin) {
        return false;
    }
    let GrantOrigin::OpenDocument(id) = origin else {
        return true;
    };
    state
        .document_origin_identities
        .get(id)
        .is_none_or(|expected| {
            current_file_identity_for_origin(state, path, state.workspace_document_origins.get(id))
                .is_some_and(|current| current == *expected)
        })
}

pub(crate) enum ExactReadAuthority {
    Path,
    Identity(String),
}

pub(crate) fn exact_read_authority(
    state: &AuthorizationState,
    path: &Path,
    ledger: &GrantLedger,
) -> Option<ExactReadAuthority> {
    if !ledger.is_active() {
        return None;
    }
    let mut expected_identity = None;
    for origin in ledger.origins.keys() {
        if !exact_origin_is_current_for_path(state, path, origin) {
            continue;
        }
        match origin {
            GrantOrigin::OpenDocument(id) => {
                if let Some(identity) = state.document_origin_identities.get(id) {
                    expected_identity.get_or_insert_with(|| identity.clone());
                } else {
                    return Some(ExactReadAuthority::Path);
                }
            }
            GrantOrigin::SaveAs(_) | GrantOrigin::CreatedDocument(_) => {
                return Some(ExactReadAuthority::Path);
            }
            GrantOrigin::Workspace(_) | GrantOrigin::Preview(_) => {}
        }
    }
    expected_identity.map(ExactReadAuthority::Identity)
}

pub(crate) fn exact_grant_is_current(state: &AuthorizationState, path: &Path, ledger: &GrantLedger) -> bool {
    exact_read_authority(state, path, ledger).is_some()
}

pub(crate) fn active_authority_origins_for_path(
    state: &AuthorizationState,
    path: &Path,
) -> HashSet<GrantOrigin> {
    let mut origins = HashSet::new();
    for (key, ledger) in &state.grants {
        if !ledger.is_active() {
            continue;
        }
        match key {
            GrantKey::ExactReadWrite(granted_path) if granted_path == path => {
                origins.extend(
                    ledger
                        .origins
                        .keys()
                        .filter(|origin| exact_origin_is_current_for_path(state, path, origin))
                        .cloned(),
                );
            }
            GrantKey::DirectoryRead(root)
                if path_is_under(path, root)
                    && directory_read_grant_is_current(state, root, ledger) =>
            {
                origins.extend(
                    ledger
                        .origins
                        .keys()
                        .filter(|origin| grant_origin_is_current_for_path(state, path, origin))
                        .cloned(),
                );
            }
            _ => {}
        }
    }
    origins
}

pub(crate) fn ledger_shares_current_origin(
    state: &AuthorizationState,
    path: &Path,
    ledger: &GrantLedger,
    origins: &HashSet<GrantOrigin>,
) -> bool {
    ledger.origins.keys().any(|origin| {
        origins.contains(origin) && grant_origin_is_current_for_path(state, path, origin)
    })
}

pub(crate) fn workspace_read_authorization_is_current(
    state: &AuthorizationState,
    authorization: &WorkspaceReadAuthorization,
) -> bool {
    if !opened_file_platform_identity(&authorization.file_binding)
        .is_ok_and(|identity| identity == authorization.file_identity)
    {
        return false;
    }
    let workspace_is_current =
        state
            .workspaces
            .get(&authorization.token)
            .is_some_and(|workspace| {
                workspace.root == authorization.root
                    && workspace.root_identity == authorization.root_binding.identity
                    && authorization.root_binding.is_current(&authorization.root)
            });
    let relative_matches = authorization
        .path
        .strip_prefix(&authorization.root)
        .is_ok_and(|relative| relative == authorization.relative);
    if !workspace_is_current || !relative_matches {
        return false;
    }
    authorization
        .root_binding
        .open_regular_file(&authorization.relative)
        .and_then(|file| opened_file_platform_identity(&file))
        .is_ok_and(|identity| identity == authorization.file_identity)
}
