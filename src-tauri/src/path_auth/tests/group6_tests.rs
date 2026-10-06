use super::prelude::*;

#[test]
fn persisted_workspace_restore_rejects_a_retargeted_root_before_snapshot_or_grant() {
    use std::cell::Cell;

    let expected = tempdir().unwrap();
    let retargeted = tempdir().unwrap();
    let expected_root = expected.path().canonicalize().unwrap();
    let session = FileAuthorizationSession::default();
    let snapshot_calls = Cell::new(0);
    let transport_calls = Cell::new(0);

    let result = session.open_workspace_at_canonical_root(
        retargeted.path(),
        &expected_root,
        |_| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Ok(())
        },
        |_| {
            transport_calls.set(transport_calls.get() + 1);
            Ok(())
        },
    );

    assert!(result.is_err());
    assert_eq!(snapshot_calls.get(), 0);
    assert_eq!(transport_calls.get(), 0);
    let state = session.lock().unwrap();
    assert!(state.workspaces.is_empty());
    assert!(state.grants.is_empty());
}
#[test]
fn directory_transport_failure_publishes_no_workspace_token_or_application_grant() {
    use std::cell::Cell;

    let workspace = tempdir().unwrap();
    let canonical_workspace = workspace.path().canonicalize().unwrap();
    let session = FileAuthorizationSession::default();
    let snapshot_calls = Cell::new(0);
    let transport_calls = Cell::new(0);

    let result = session.open_workspace(
        workspace.path(),
        |source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            let WorkspaceSnapshotSource::Candidate(candidate) = source else {
                panic!("initial workspace snapshot must receive a candidate");
            };
            assert_eq!(candidate.root, canonical_workspace);
            Ok(())
        },
        |root| {
            transport_calls.set(transport_calls.get() + 1);
            assert_eq!(root, canonical_workspace);
            Err("injected directory transport failure".to_string())
        },
    );
    let error = match result {
        Ok(_) => panic!("transport failure must prevent workspace publication"),
        Err(error) => error,
    };

    assert_eq!(error, "injected directory transport failure");
    assert_eq!(snapshot_calls.get(), 1);
    assert_eq!(transport_calls.get(), 1);
    let state = session.lock().unwrap();
    assert!(state.workspaces.is_empty());
    assert!(state.grants.is_empty());
    assert_eq!(state.next_workspace_token_id, 0);
}
#[test]
fn monotonic_transport_is_not_treated_as_application_authorization() {
    use std::cell::RefCell;

    let directory = tempdir().unwrap();
    let document = directory.path().join("index.html");
    let asset = directory.path().join("asset.png");
    fs::write(&document, "before").unwrap();
    fs::write(&asset, b"png").unwrap();
    let state = AppState::default();
    let transport_roots = RefCell::new(HashSet::new());

    let result = state.file_authorization().open_standalone_file(
        &document,
        |_| Ok(()),
        |parent| {
            transport_roots.borrow_mut().insert(parent.to_path_buf());
            Err("transport reported failure after allowing parent".to_string())
        },
    );
    assert!(result.is_err());

    fs::remove_file(&document).unwrap();
    fs::write(&document, "recreated").unwrap();
    let canonical_document = normalize_existing_path(&document).unwrap();
    let canonical_asset = normalize_existing_path(&asset).unwrap();
    assert!(transport_roots
        .borrow()
        .iter()
        .any(|root| path_is_under(&canonical_document, root)));
    assert!(ensure_authorized_existing_file_inner(&state, &canonical_document).is_err());
    assert!(!is_authorized_image_path(&state, &canonical_asset).unwrap());
    assert!(prepare_html_preview_inner(&state, &canonical_document, "recreated").is_err());
}
#[cfg(unix)]
#[test]
fn directory_authorization_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_doc = outside.path().join("outside.md");
    let linked_doc = workspace.path().join("linked.md");
    fs::write(&outside_doc, "# outside").unwrap();
    symlink(&outside_doc, &linked_doc).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    assert!(ensure_authorized_existing_file_inner(&state, &linked_doc).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &linked_doc).is_err());
}
#[test]
fn save_as_exact_path_allows_later_write_only_for_that_path() {
    let dir = tempdir().unwrap();
    let saved = dir.path().join("saved.md");
    let sibling = dir.path().join("sibling.md");
    fs::write(&sibling, "# sibling").unwrap();
    let state = AppState::default();
    let authorized = authorize_saved_file_inner(&state, &saved).unwrap();

    assert_eq!(
        ensure_authorized_write_file_inner(&state, &saved).unwrap(),
        authorized
    );
    assert!(ensure_authorized_write_file_inner(&state, &sibling).is_err());
}
#[test]
fn confirmed_external_missing_revokes_exact_grant_and_preview_but_allows_reauthorization() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("draft.html");
    fs::write(&document, "saved").unwrap();
    let state = AppState::default();
    let canonical = authorize_file_inner(&state, document.clone()).unwrap();
    prepare_html_preview_inner(&state, &canonical, "live draft").unwrap();

    fs::remove_file(&canonical).unwrap();
    assert_eq!(
        ensure_authorized_watch_file_inner(&state, &canonical).unwrap(),
        canonical
    );
    revoke_authorized_path_prefix_inner(&state, &canonical).unwrap();

    assert!(ensure_authorized_watch_file_inner(&state, &canonical).is_err());
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());

    fs::write(&canonical, "recreated").unwrap();
    assert!(ensure_authorized_existing_file_inner(&state, &canonical).is_err());
    assert_eq!(
        authorize_file_inner(&state, canonical.clone()).unwrap(),
        canonical
    );
}
#[test]
fn confirmed_external_missing_preserves_ancestor_workspace_authorization() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.md");
    fs::write(&document, "before").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let canonical = authorize_workspace_file_inner(&state, &document).unwrap();

    fs::remove_file(&canonical).unwrap();
    revoke_authorized_path_prefix_inner(&state, &canonical).unwrap();
    fs::write(&canonical, "after").unwrap();

    assert_eq!(
        authorize_workspace_file_inner(&state, &canonical).unwrap(),
        canonical
    );
}
#[test]
fn prepared_workspace_is_not_authorized_until_the_frontend_applies_it() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |source| {
            Ok(match source {
                WorkspaceSnapshotSource::Candidate(candidate) => candidate.root.clone(),
                WorkspaceSnapshotSource::Authorized(workspace) => workspace.root.clone(),
            })
        })
        .unwrap();
    let token = prepared.workspace.wire_token();
    let root = prepared.workspace.root().to_path_buf();

    assert!(session
        .authorized_workspace_root_for_token(&token, &root)
        .is_err());
    assert_eq!(
        session
            .pending_workspace_authority_count_for_test()
            .unwrap(),
        1
    );

    assert_eq!(
        session
            .settle_workspace_authorization("main", &prepared.receipt, true, |_| Ok(()))
            .unwrap(),
        PreparedWorkspaceSettlement::Applied
    );
    assert_eq!(
        session
            .authorized_workspace_root_for_token(&token, &root)
            .unwrap()
            .root(),
        root
    );
    assert_eq!(
        session
            .pending_workspace_authority_count_for_test()
            .unwrap(),
        0
    );
}
#[test]
fn discarded_workspace_receipt_removes_only_its_reservation() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let existing = session.authorize_directory_root(directory.path()).unwrap();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();

    assert_eq!(
        session
            .settle_workspace_authorization("main", &prepared.receipt, false, |_| {
                panic!("discard must not invoke transport")
            })
            .unwrap(),
        PreparedWorkspaceSettlement::Discarded
    );
    assert!(session
        .authorized_workspace_root_for_token(&existing.wire_token(), existing.root(),)
        .is_ok());
    assert!(session
        .authorized_workspace_root_for_token(
            &prepared.workspace.wire_token(),
            prepared.workspace.root(),
        )
        .is_err());
}
