use std::path::Path;

use super::prelude::*;

#[test]
fn authorization_generation_tracks_suspend_restore_and_relocation() {
    let directory = tempdir().unwrap();
    let old = directory.path().join("old.md");
    let new = directory.path().join("new.md");
    fs::write(&old, "# document").unwrap();
    let canonical_old = normalize_existing_path(&old).unwrap();
    let session = FileAuthorizationSession::default();
    session.authorize_file(&old).unwrap();
    let after_grant = session.authorization_generation().unwrap();

    let transitioned = {
        let mut state = session.lock().unwrap();
        state
            .suspend_rename_path_prefixes(&canonical_old, &new)
            .unwrap()
    };
    let after_suspend = session.authorization_generation().unwrap();
    assert!(after_suspend > after_grant);

    {
        let mut state = session.lock().unwrap();
        state.restore_rename_grants(&transitioned).unwrap();
    }
    let after_restore = session.authorization_generation().unwrap();
    assert!(after_restore > after_suspend);

    fs::rename(&old, &new).unwrap();
    let canonical_new = normalize_existing_path(&new).unwrap();
    session
        .relocate_path_prefix(&canonical_old, &canonical_new)
        .unwrap();
    assert!(session.authorization_generation().unwrap() > after_restore);
}
#[test]
fn authorization_generation_is_stable_for_reads_noops_and_failed_publication() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical = normalize_existing_path(&document).unwrap();
    let session = FileAuthorizationSession::default();
    let initial = session.authorization_generation().unwrap();

    assert!(session.file_for_read(&canonical).is_err());
    assert_eq!(session.authorization_generation().unwrap(), initial);
    session.revoke_path_prefix(&canonical).unwrap();
    assert_eq!(session.authorization_generation().unwrap(), initial);
    session
        .relocate_path_prefix(&canonical, &canonical)
        .unwrap();
    assert_eq!(session.authorization_generation().unwrap(), initial);
    assert!(session
        .authorize_directory_root_with(directory.path(), |_| Err("injected failure".into()))
        .is_err());
    assert_eq!(session.authorization_generation().unwrap(), initial);
}
#[test]
fn authorization_generation_overflow_fails_closed_before_grant_mutation() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical = normalize_existing_path(&document).unwrap();
    let session = FileAuthorizationSession::default();
    session.lock().unwrap().authorization_generation = u64::MAX;

    let error = match session.authorize_file(&document) {
        Ok(_) => panic!("overflow must reject the grant"),
        Err(error) => error,
    };

    assert_eq!(error, "Authorization generation is exhausted");
    assert_eq!(session.authorization_generation().unwrap(), u64::MAX);
    assert_eq!(
        session
            .exact_write_grant_snapshot_for_test(&canonical)
            .unwrap(),
        None
    );
}
#[test]
fn directory_authorization_allows_descendant_read_but_not_write_without_file_authorization() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("notes");
    fs::create_dir(&nested).unwrap();
    let doc = nested.join("doc.md");
    let new_doc = nested.join("new.md");
    fs::write(&doc, "# doc").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    assert!(ensure_authorized_existing_file_inner(&state, &doc).is_ok());
    assert!(ensure_authorized_write_file_inner(&state, &doc).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &new_doc).is_err());
}
#[test]
fn failed_directory_authorization_grants_no_partial_capability() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let state = AppState::default();

    let result = state
        .file_authorization()
        .authorize_directory_root_with(workspace.path(), |_| {
            Err("injected authorization commit failure".into())
        });

    assert!(result.is_err());
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
    assert!(!is_authorized_image_path(&state, &document).unwrap());
}
#[test]
fn overlapping_origins_are_reference_counted() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    let asset = directory.path().join("asset.png");
    fs::write(&document, "# document").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    let state = AppState::default();

    let first_open = state
        .file_authorization()
        .authorize_file(&document)
        .unwrap();
    let second_open = state
        .file_authorization()
        .authorize_file(&document)
        .unwrap();
    let save = state
        .file_authorization()
        .authorize_save_destination(&document)
        .unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(first_open.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(second_open.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(save.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
    assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
}
#[test]
fn mixed_standalone_and_workspace_acquisitions_revoke_independently() {
    let workspace_root = tempdir().unwrap();
    let document = workspace_root.path().join("document.md");
    let asset = workspace_root.path().join("asset.png");
    fs::write(&document, "# document").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_root = normalize_existing_path(workspace_root.path()).unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    let state = AppState::default();

    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_root)
        .unwrap();
    let standalone = state
        .file_authorization()
        .authorize_file(&document)
        .unwrap();
    let workspace = state
        .file_authorization()
        .open_workspace_file(&document)
        .unwrap();

    assert_ne!(standalone.origin(), workspace.origin());

    let workspace_root_origin = GrantOrigin::Workspace(*authorized_workspace.token());
    state
        .file_authorization()
        .revoke_origin(&workspace_root_origin, RevokeOriginMode::All)
        .unwrap();
    state
        .file_authorization()
        .revoke_origin(workspace.origin(), RevokeOriginMode::All)
        .unwrap();

    assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(standalone.origin(), RevokeOriginMode::All)
        .unwrap();

    assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
    assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
}
fn assert_distinct_origins(
    standalone: &AuthorizedFile,
    workspace: &AuthorizedFile,
    workspace_root_origin: &GrantOrigin,
) {
    assert_ne!(standalone.origin(), workspace.origin());
    assert_ne!(standalone.origin(), workspace_root_origin);
    assert_ne!(workspace.origin(), workspace_root_origin);
}

fn revoke_standalone_assert_workspace_access(
    state: &AppState,
    document: &Path,
    canonical_asset: &Path,
    standalone: &AuthorizedFile,
) {
    state
        .file_authorization()
        .revoke_origin(standalone.origin(), RevokeOriginMode::All)
        .unwrap();

    assert!(ensure_authorized_write_file_inner(state, document).is_ok());
    assert!(is_authorized_image_path(state, canonical_asset).unwrap());
}

fn revoke_workspace_file_assert_read_only(
    state: &AppState,
    document: &Path,
    canonical_asset: &Path,
    workspace: &AuthorizedFile,
) {
    state
        .file_authorization()
        .revoke_origin(workspace.origin(), RevokeOriginMode::All)
        .unwrap();

    assert!(ensure_authorized_write_file_inner(state, document).is_err());
    assert!(ensure_authorized_existing_file_inner(state, document).is_ok());
    assert!(is_authorized_image_path(state, canonical_asset).unwrap());
}

fn revoke_root_and_assert_no_access(
    state: &AppState,
    document: &Path,
    canonical_asset: &Path,
    workspace_root_origin: &GrantOrigin,
) {
    state
        .file_authorization()
        .revoke_origin(workspace_root_origin, RevokeOriginMode::All)
        .unwrap();

    assert!(ensure_authorized_existing_file_inner(state, document).is_err());
    assert!(!is_authorized_image_path(state, canonical_asset).unwrap());
}

#[test]
fn mixed_standalone_and_workspace_acquisitions_revoke_independently_in_inverse_order() {
    let workspace_root = tempdir().unwrap();
    let document = workspace_root.path().join("document.md");
    let asset = workspace_root.path().join("asset.png");
    fs::write(&document, "# document").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_root = normalize_existing_path(workspace_root.path()).unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    let state = AppState::default();

    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_root)
        .unwrap();
    let standalone = state
        .file_authorization()
        .authorize_file(&document)
        .unwrap();
    let workspace = state
        .file_authorization()
        .open_workspace_file(&document)
        .unwrap();
    let workspace_root_origin = GrantOrigin::Workspace(*authorized_workspace.token());

    assert_distinct_origins(&standalone, &workspace, &workspace_root_origin);

    revoke_standalone_assert_workspace_access(&state, &document, &canonical_asset, &standalone);

    revoke_workspace_file_assert_read_only(&state, &document, &canonical_asset, &workspace);

    revoke_root_and_assert_no_access(&state, &document, &canonical_asset, &workspace_root_origin);
}
