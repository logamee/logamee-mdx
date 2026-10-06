//! Preview-scope root resolution helpers for `session_h`.
use super::super::*;

/// Resolves the preview scope root for an embed whose Markdown file is bound
/// to a workspace: both files must stay under the authorized workspace root,
/// and the workspace grant must still be shared with the Markdown file's
/// active scope.
pub(super) fn anchored_preview_root_for_workspace(
    state: &AuthorizationState,
    anchor: &Path,
    document: &Path,
    workspace_root: &Path,
    anchor_origins: &HashSet<GrantOrigin>,
) -> Result<PathBuf, String> {
    if !path_is_under(anchor, workspace_root) || !path_is_under(document, workspace_root) {
        return Err("HTML embed escaped the authorized workspace".to_string());
    }
    let workspace_is_shared = state.grants.iter().any(|(key, ledger)| {
        ledger.is_active()
            && matches!(key,
                GrantKey::DirectoryRead(grant_root) | GrantKey::InternalAsset(grant_root)
                    if grant_root == workspace_root)
            && ledger_shares_current_origin(state, workspace_root, ledger, anchor_origins)
    });
    if !workspace_is_shared {
        return Err(
            "HTML embed workspace is not authorized by the Markdown file's active scope"
                .to_string(),
        );
    }
    Ok(document
        .parent()
        .ok_or_else(|| "HTML embed file has no parent directory".to_string())?
        .to_path_buf())
}

/// Resolves the preview scope root for an embed that shares the Markdown
/// file's own directory scope: some active directory grant must cover both
/// files, and the embed may not escape that directory.
pub(super) fn anchored_preview_root_for_directory(
    state: &AuthorizationState,
    anchor: &Path,
    document: &Path,
    anchor_origins: &HashSet<GrantOrigin>,
) -> Result<PathBuf, String> {
    let scope_is_authorized = state
        .grants
        .iter()
        .filter(|(_, ledger)| ledger.is_active())
        .any(|(key, ledger)| {
            matches!(key,
                GrantKey::DirectoryRead(root) | GrantKey::InternalAsset(root)
                    if path_is_under(anchor, root)
                        && path_is_under(document, root)
                        && ledger_shares_current_origin(
                            state,
                            root,
                            ledger,
                            anchor_origins,
                        )
            )
        });
    if !scope_is_authorized {
        return Err(
            "HTML embed is outside the Markdown file's authorized scope".to_string()
        );
    }
    let root = anchor
        .parent()
        .ok_or_else(|| "Markdown file has no parent directory".to_string())?
        .to_path_buf();
    if !path_is_under(document, &root) {
        return Err("HTML embed escaped the Markdown directory".to_string());
    }
    Ok(root)
}
