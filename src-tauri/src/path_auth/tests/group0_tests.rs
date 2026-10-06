use super::prelude::*;

#[test]
fn workspace_authorization_rejects_a_replaced_root_object() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let displaced = directory.path().join("displaced");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), "same content").unwrap();
    let authorization = FileAuthorizationSession::default();
    let workspace = authorization.authorize_directory_root(&root).unwrap();
    let token = workspace.wire_token();
    let canonical_root = workspace.root().to_path_buf();

    fs::rename(&canonical_root, displaced).unwrap();
    fs::create_dir(&canonical_root).unwrap();
    fs::write(canonical_root.join("note.md"), "same content").unwrap();

    assert!(authorization
        .ensure_workspace_is_current(&workspace)
        .is_err());
    assert!(authorization
        .authorized_workspace_root_for_token(&token, &canonical_root)
        .is_err());
    assert!(authorization
        .file_for_read(canonical_root.join("note.md"))
        .is_err());
    assert!(authorization
        .file_for_watch(canonical_root.join("note.md"))
        .is_err());
    assert!(authorization.directory_for_read(&canonical_root).is_err());
    assert!(!authorization
        .is_authorized_preview_asset(&canonical_root.join("note.md"))
        .unwrap());
}
#[test]
fn save_does_not_refresh_a_stale_workspace_origin_through_a_standalone_origin() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("note.md");
    let displaced = directory.path().join("displaced.md");
    fs::write(&document, "workspace object").unwrap();
    let state = AppState::default();
    state
        .file_authorization()
        .authorize_directory_root(directory.path())
        .unwrap();
    let workspace_open = state
        .file_authorization()
        .open_workspace_file(&document)
        .unwrap();

    fs::rename(&document, &displaced).unwrap();
    fs::write(&document, "standalone replacement").unwrap();
    let standalone_open = state
        .file_authorization()
        .authorize_file(&document)
        .unwrap();
    let expected = capture_file_version(&document).unwrap().unwrap();

    let disposition = DocumentSaveCoordinator::default()
        .save_expected(
            state.file_authorization(),
            &document,
            b"saved replacement",
            expected,
            "mixed-origin-save",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    assert!(matches!(
        disposition,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));

    state
        .file_authorization()
        .revoke_authorized_file(&standalone_open)
        .unwrap();
    assert!(state
        .file_authorization()
        .with_exact_write_authority(&document, |_, _| Ok(()))
        .is_err());
    drop(workspace_open);
}
#[test]
fn standalone_open_document_keeps_its_existing_path_authority_contract() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("note.md");
    let displaced = directory.path().join("displaced.md");
    let asset = directory.path().join("image.png");
    fs::write(&document, "authorized content").unwrap();
    fs::write(&asset, b"image").unwrap();
    let authorization = FileAuthorizationSession::default();
    authorization.authorize_file(&document).unwrap();

    fs::rename(&document, &displaced).unwrap();
    fs::write(&document, "replacement content").unwrap();

    assert!(authorization.file_for_read(&document).is_ok());
    assert!(authorization.file_for_write(&document).is_ok());
    assert!(authorization
        .is_authorized_preview_asset(&asset.canonicalize().unwrap())
        .unwrap());
}
#[test]
fn identity_bound_exact_read_rejects_replacement_before_handle_open() {
    let directory = tempdir().unwrap();
    let original = directory.path().join("original.md");
    let renamed = directory.path().join("renamed.md");
    let displaced = directory.path().join("displaced.md");
    fs::write(&original, "authorized content").unwrap();
    let canonical_original = normalize_existing_path(&original).unwrap();
    let authorization = FileAuthorizationSession::default();
    authorization.authorize_file(&original).unwrap();

    fs::rename(&original, &renamed).unwrap();
    let canonical_renamed = normalize_existing_path(&renamed).unwrap();
    let renamed_identity = current_file_identity_for_origin(
        &authorization.lock().unwrap(),
        &canonical_renamed,
        None,
    )
    .unwrap();
    authorization
        .relocate_path_prefix_with_identity(
            &canonical_original,
            &canonical_renamed,
            &renamed_identity,
        )
        .unwrap();

    let result = authorization.open_file_for_read_with_before_open(&canonical_renamed, || {
        fs::rename(&canonical_renamed, &displaced).unwrap();
        fs::write(&canonical_renamed, "replacement content").unwrap();
    });

    assert!(result.is_err());
}
#[test]
fn revoking_a_workspace_open_document_removes_its_workspace_provenance() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("note.md");
    fs::write(&document, "authorized content").unwrap();
    let authorization = FileAuthorizationSession::default();
    authorization
        .authorize_directory_root(directory.path())
        .unwrap();
    let opened = authorization.open_workspace_file(&document).unwrap();

    assert_eq!(
        authorization
            .lock()
            .unwrap()
            .workspace_document_origins
            .len(),
        1
    );
    assert_eq!(
        authorization
            .lock()
            .unwrap()
            .document_origin_identities
            .len(),
        1
    );

    authorization
        .revoke_origin(opened.origin(), RevokeOriginMode::All)
        .unwrap();

    assert!(authorization
        .lock()
        .unwrap()
        .workspace_document_origins
        .is_empty());
    assert!(authorization
        .lock()
        .unwrap()
        .document_origin_identities
        .is_empty());
}
#[test]
fn anchored_workspace_preview_lease_remains_supported() {
    let workspace = tempdir().unwrap();
    let notes = workspace.path().join("notes");
    fs::create_dir(&notes).unwrap();
    let markdown = notes.join("notes.md");
    let html = notes.join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html).unwrap();
    let authorization = state.file_authorization().lock().unwrap();

    assert_eq!(scope.root(), normalize_existing_path(&notes).unwrap());
    assert!(!authorization
        .unsupported_preview_leases()
        .contains(scope.lease()));
}
#[test]
fn workspace_anchored_embed_scope_is_limited_to_the_html_directory() {
    let workspace = tempdir().unwrap();
    let notes = workspace.path().join("notes");
    let shared = workspace.path().join("shared");
    fs::create_dir(&notes).unwrap();
    fs::create_dir(&shared).unwrap();
    let markdown = notes.join("guide.md");
    let html = shared.join("embed.html");
    fs::write(&markdown, "# Guide").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let scope = preview_scope_for_anchored_file_with_root_inner(
        &state,
        &markdown,
        &html,
        Some(workspace.path()),
    )
    .unwrap();

    assert_eq!(scope.root(), normalize_existing_path(&shared).unwrap());
    assert!(!state
        .file_authorization()
        .lock()
        .unwrap()
        .unsupported_preview_leases()
        .contains(scope.lease()));
}
#[test]
fn standalone_markdown_authorizes_a_sibling_embed_without_html_write_access() {
    let directory = tempdir().unwrap();
    let markdown = directory.path().join("notes.md");
    let html = directory.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, markdown.clone()).unwrap();

    let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html)
        .expect("the Markdown document's internal-asset authority should cover siblings");

    assert_eq!(
        scope.root(),
        normalize_existing_path(directory.path()).unwrap()
    );
    assert!(!state
        .file_authorization()
        .lock()
        .unwrap()
        .unsupported_preview_leases()
        .contains(scope.lease()));
    assert!(ensure_authorized_write_file_inner(&state, &html).is_err());
}
