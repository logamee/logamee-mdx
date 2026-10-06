use std::path::{Path, PathBuf};

use super::prelude::*;

fn preview_origin_count(state: &AppState, canonical_root: &Path) -> usize {
    state
        .file_authorization()
        .lock()
        .unwrap()
        .grants
        .get(&GrantKey::InternalAsset(canonical_root.to_path_buf()))
        .unwrap()
        .origins
        .keys()
        .filter(|origin| matches!(origin, GrantOrigin::Preview(_)))
        .count()
}

fn authorize_documents_and_collect_preview_leases(
    state: &AppState,
    first_document: &Path,
    second_document: &Path,
    workspace_root: &Path,
) -> (AuthorizedFile, AuthorizedFile, PreviewLeaseId, PreviewLeaseId, PathBuf) {
    let first_document_grant = state
        .file_authorization()
        .authorize_file(first_document)
        .unwrap();
    let second_document_grant = state
        .file_authorization()
        .authorize_file(second_document)
        .unwrap();
    let (_, _, first_preview_lease) = state
        .file_authorization()
        .preview_scope_for(first_document)
        .unwrap()
        .into_parts();
    let (_, _, second_preview_lease) = state
        .file_authorization()
        .preview_scope_for(second_document)
        .unwrap()
        .into_parts();
    let canonical_root = normalize_existing_path(workspace_root).unwrap();
    (
        first_document_grant,
        second_document_grant,
        first_preview_lease,
        second_preview_lease,
        canonical_root,
    )
}

fn revoke_preview_leases_and_assert_asset_stays_authorized(
    state: &AppState,
    canonical_root: &Path,
    canonical_asset: &Path,
    first_preview_lease: PreviewLeaseId,
    second_preview_lease: PreviewLeaseId,
) {
    state
        .file_authorization()
        .revoke_origin(
            &GrantOrigin::Preview(first_preview_lease),
            RevokeOriginMode::All,
        )
        .unwrap();
    assert_eq!(preview_origin_count(state, canonical_root), 1);

    state
        .file_authorization()
        .revoke_origin(
            &GrantOrigin::Preview(second_preview_lease),
            RevokeOriginMode::All,
        )
        .unwrap();
    assert_eq!(preview_origin_count(state, canonical_root), 0);
    assert!(is_authorized_image_path(state, canonical_asset).unwrap());
}

fn revoke_document_grants_and_assert_asset_unauthorized(
    state: &AppState,
    canonical_asset: &Path,
    first_document_grant: &AuthorizedFile,
    second_document_grant: &AuthorizedFile,
) {
    state
        .file_authorization()
        .revoke_origin(first_document_grant.origin(), RevokeOriginMode::All)
        .unwrap();
    state
        .file_authorization()
        .revoke_origin(second_document_grant.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(!is_authorized_image_path(state, canonical_asset).unwrap());
}

#[test]
fn preview_internal_asset_origins_are_reference_counted_and_revocable() {
    let directory = tempdir().unwrap();
    let first_document = directory.path().join("first.html");
    let second_document = directory.path().join("second.html");
    let asset = directory.path().join("asset.png");
    fs::write(&first_document, "first").unwrap();
    fs::write(&second_document, "second").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    let state = AppState::default();
    let (
        first_document_grant,
        second_document_grant,
        first_preview_lease,
        second_preview_lease,
        canonical_root,
    ) = authorize_documents_and_collect_preview_leases(
        &state,
        &first_document,
        &second_document,
        directory.path(),
    );

    assert_eq!(preview_origin_count(&state, &canonical_root), 2);

    revoke_preview_leases_and_assert_asset_stays_authorized(
        &state,
        &canonical_root,
        &canonical_asset,
        first_preview_lease,
        second_preview_lease,
    );

    revoke_document_grants_and_assert_asset_unauthorized(
        &state,
        &canonical_asset,
        &first_document_grant,
        &second_document_grant,
    );
}
