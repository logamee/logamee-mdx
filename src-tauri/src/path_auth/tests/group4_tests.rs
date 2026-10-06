use super::prelude::*;

#[test]
fn relocate_prefix_relocates_every_descendant_capability_and_revokes_old_prefix() {
    let container = tempdir().unwrap();
    let old_root = container.path().join("old");
    let old_document = old_root.join("nested/document.md");
    let old_asset = old_root.join("nested/asset.png");
    fs::create_dir_all(old_document.parent().unwrap()).unwrap();
    fs::write(&old_document, "# document").unwrap();
    fs::write(&old_asset, b"png").unwrap();
    let canonical_old_root = normalize_existing_path(&old_root).unwrap();
    let state = AppState::default();
    let workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_old_root)
        .unwrap();
    state
        .file_authorization()
        .authorize_file(&old_document)
        .unwrap();

    let new_root = container.path().join("new");
    fs::rename(&old_root, &new_root).unwrap();
    let canonical_new_root = normalize_existing_path(&new_root).unwrap();
    let new_document = canonical_new_root.join("nested/document.md");
    let new_asset = canonical_new_root.join("nested/asset.png");
    state
        .file_authorization()
        .relocate_path_prefix(&canonical_old_root, &canonical_new_root)
        .unwrap();

    assert!(state
        .file_authorization()
        .workspace_entry_for_mutation(workspace.token(), &new_document)
        .is_ok());
    assert!(ensure_authorized_existing_file_inner(&state, &new_document).is_ok());
    assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
    assert!(
        is_authorized_image_path(&state, &normalize_existing_path(&new_asset).unwrap())
            .unwrap()
    );

    fs::create_dir_all(old_document.parent().unwrap()).unwrap();
    fs::write(&old_document, "# recreated").unwrap();
    fs::write(&old_asset, b"recreated").unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &old_document).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &old_document).is_err());
    assert!(
        !is_authorized_image_path(&state, &normalize_existing_path(&old_asset).unwrap())
            .unwrap()
    );
}
#[test]
fn revoke_prefix_purges_exact_and_descendant_capabilities() {
    let directory = tempdir().unwrap();
    let retained_directory = tempdir().unwrap();
    let revoked_root = directory.path().join("revoked");
    let nested = revoked_root.join("nested");
    let first_document = revoked_root.join("first.md");
    let second_document = nested.join("second.md");
    let first_asset = revoked_root.join("first.png");
    let second_asset = nested.join("second.png");
    let retained_document = retained_directory.path().join("retained.md");
    fs::create_dir_all(&nested).unwrap();
    fs::write(&first_document, "# first").unwrap();
    fs::write(&second_document, "# second").unwrap();
    fs::write(&first_asset, b"first").unwrap();
    fs::write(&second_asset, b"second").unwrap();
    fs::write(&retained_document, "# retained").unwrap();
    let canonical_revoked_root = normalize_existing_path(&revoked_root).unwrap();
    let canonical_first_asset = normalize_existing_path(&first_asset).unwrap();
    let canonical_second_asset = normalize_existing_path(&second_asset).unwrap();
    let state = AppState::default();
    state
        .file_authorization()
        .authorize_file(&first_document)
        .unwrap();
    state
        .file_authorization()
        .authorize_file(&second_document)
        .unwrap();
    state
        .file_authorization()
        .authorize_file(&retained_document)
        .unwrap();

    state
        .file_authorization()
        .revoke_path_prefix(&canonical_revoked_root)
        .unwrap();

    assert!(ensure_authorized_existing_file_inner(&state, &first_document).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &first_document).is_err());
    assert!(ensure_authorized_existing_file_inner(&state, &second_document).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &second_document).is_err());
    assert!(!is_authorized_image_path(&state, &canonical_first_asset).unwrap());
    assert!(!is_authorized_image_path(&state, &canonical_second_asset).unwrap());
    assert!(ensure_authorized_write_file_inner(&state, &retained_document).is_ok());
}
#[test]
fn relocate_prefix_preserves_all_origins_without_collapsing_provenance() {
    let container = tempdir().unwrap();
    let old_root = container.path().join("old");
    let new_root = container.path().join("new");
    let old_document = old_root.join("document.md");
    let new_document = new_root.join("document.md");
    let new_asset = new_root.join("asset.png");
    fs::create_dir_all(&old_root).unwrap();
    fs::create_dir_all(&new_root).unwrap();
    fs::write(&old_document, "# old").unwrap();
    fs::write(&new_document, "# new").unwrap();
    fs::write(&new_asset, b"png").unwrap();
    let canonical_old_root = normalize_existing_path(&old_root).unwrap();
    let canonical_new_root = normalize_existing_path(&new_root).unwrap();
    let canonical_new_asset = normalize_existing_path(&new_asset).unwrap();
    let state = AppState::default();

    let source_open = state
        .file_authorization()
        .authorize_file(&old_document)
        .unwrap();
    let source_save = state
        .file_authorization()
        .authorize_save_destination(&old_document)
        .unwrap();
    let destination_open = state
        .file_authorization()
        .authorize_file(&new_document)
        .unwrap();

    state
        .file_authorization()
        .relocate_path_prefix(&canonical_old_root, &canonical_new_root)
        .unwrap();

    state
        .file_authorization()
        .revoke_origin(source_open.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_new_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(destination_open.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_write_file_inner(&state, &new_document).is_ok());
    assert!(is_authorized_image_path(&state, &canonical_new_asset).unwrap());

    state
        .file_authorization()
        .revoke_origin(source_save.origin(), RevokeOriginMode::All)
        .unwrap();
    assert!(ensure_authorized_write_file_inner(&state, &new_document).is_err());
    assert!(!is_authorized_image_path(&state, &canonical_new_asset).unwrap());
}
#[test]
fn relocate_prefix_does_not_reactivate_suspended_collision_origins() {
    let old_root = PathBuf::from("/workspace/old");
    let new_root = PathBuf::from("/workspace/new");
    let old_key = GrantKey::ExactReadWrite(old_root.join("document.md"));
    let new_key = GrantKey::ExactReadWrite(new_root.join("document.md"));
    let active_origin = GrantOrigin::OpenDocument(DocumentGrantId(1));
    let suspended_origin = GrantOrigin::SaveAs(DocumentGrantId(2));
    let mut state = AuthorizationState::default();
    state.grant(old_key, active_origin.clone()).unwrap();
    state
        .grant(new_key.clone(), suspended_origin.clone())
        .unwrap();
    state.grants.get_mut(&new_key).unwrap().suspend();

    state.relocate_path_prefix(&old_root, &new_root).unwrap();

    let relocated = state.grants.get(&new_key).unwrap();
    assert_eq!(relocated.status, GrantStatus::Active);
    assert_eq!(relocated.origins, HashMap::from([(active_origin, 1)]));
    assert!(!relocated.origins.contains_key(&suspended_origin));
}
#[test]
fn revoke_prefix_preserves_ancestor_workspace_grant() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("document.md");
    let sibling = workspace.path().join("sibling.md");
    let asset = workspace.path().join("asset.png");
    fs::write(&document, "# document").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();
    let canonical_document = normalize_existing_path(&document).unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    let state = AppState::default();

    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_root)
        .unwrap();
    state
        .file_authorization()
        .authorize_file(&canonical_document)
        .unwrap();

    state
        .file_authorization()
        .revoke_path_prefix(&canonical_document)
        .unwrap();

    assert!(ensure_authorized_write_file_inner(&state, &canonical_document).is_err());
    assert!(ensure_authorized_existing_file_inner(&state, &canonical_document).is_ok());
    assert!(state
        .file_authorization()
        .workspace_entry_for_mutation(authorized_workspace.token(), &sibling)
        .is_ok());
    assert!(is_authorized_image_path(&state, &canonical_asset).unwrap());
}
#[test]
fn published_workspace_ledger_does_not_retain_root_handles() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();

    let workspace = session.authorize_directory_root(directory.path()).unwrap();

    assert_eq!(Arc::strong_count(&workspace.root_binding.handle), 1);
    assert_eq!(session.lock().unwrap().workspaces.len(), 1);
}
