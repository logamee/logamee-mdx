use super::fixtures2::*;
use super::fixtures3::*;
use super::group3_helpers::*;

#[test]
fn write_command_updates_an_opened_html_document() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    fs::write(&html, "<h1>Before</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    open_workspace_file_inner(&state, &html).unwrap();

    let outcome = write_file_inner(&state, &html, "<h1>After</h1>").unwrap();

    assert_eq!(fs::read_to_string(&html).unwrap(), "<h1>After</h1>");
    let MutationOutcome::ConfirmedCommitted { receipt } = outcome else {
        panic!("expected confirmed committed write outcome");
    };
    assert_eq!(
        Path::new(&receipt.committed.path),
        html.canonicalize().unwrap()
    );
    assert!(matches!(receipt.workspace, SnapshotReceipt::NotApplicable));
}
#[test]
fn workspace_file_open_rejects_arbitrary_path_outside_authorized_root() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_doc = outside.path().join("outside.md");
    fs::write(&outside_doc, "# outside").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    assert!(open_workspace_file_inner(&state, &outside_doc).is_err());
}
#[test]
fn arbitrary_directory_refresh_without_prior_authorization_is_denied() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("doc.md"), "# doc").unwrap();
    let state = AppState::default();

    assert!(refresh_directory_inner(&state, "workspace-0", dir.path()).is_err());
}
#[test]
fn workspace_mutations_create_rename_and_delete_entries_under_authorized_root() {
    let dir = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();

    let created_file = committed_outcome(create_workspace_file_inner(
        &state,
        &opened.workspace_token,
        dir.path(),
        "draft.md",
    ));
    assert_eq!(created_file.content.as_deref(), Some(""));
    assert!(Path::new(&created_file.path).is_file());
    assert!(ensure_authorized_write_file_inner(&state, &created_file.path).is_ok());

    let created_dir = committed_outcome(create_workspace_directory_inner(
        &state,
        &opened.workspace_token,
        dir.path(),
        "notes",
    ));
    assert!(Path::new(&created_dir.path).is_dir());

    let renamed = committed_rename_response(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &created_file.path,
        "renamed.md",
    ));
    assert!(Path::new(&renamed.new_path).is_file());
    assert!(ensure_authorized_write_file_inner(&state, &renamed.new_path).is_ok());

    let receipt = committed_receipt(delete_workspace_entry_legacy_inner(
        &state,
        &opened.workspace_token,
        &renamed.new_path,
    ));
    assert_eq!(receipt.committed.deleted_path, renamed.new_path);
    assert!(!Path::new(&receipt.committed.deleted_path).exists());
}
#[test]
fn confirmed_workspace_mutations_discard_only_the_matching_index_scope() {
    let dir = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();
    let root = Path::new(&opened.root);

    let created_file = assert_scope_discarded_after(&state, &opened, "create-file-index", || {
        committed_open_file_response(create_workspace_file_inner(
            &state,
            &opened.workspace_token,
            root,
            "draft.md",
        ))
    });
    let directory = assert_scope_discarded_after(&state, &opened, "create-directory-index", || {
        committed_workspace_mutation(create_workspace_directory_inner(
            &state,
            &opened.workspace_token,
            root,
            "notes",
        ))
    });
    let renamed = assert_scope_discarded_after(&state, &opened, "rename-index", || {
        committed_rename_response(rename_workspace_entry_inner(
            &state,
            &opened.workspace_token,
            &created_file.path,
            "renamed.md",
        ))
    });
    let moved = assert_scope_discarded_after(&state, &opened, "move-index", || {
        committed_rename_response(move_workspace_entry_inner(
            &state,
            &opened.workspace_token,
            &renamed.new_path,
            &directory.path,
        ))
    });
    assert_scope_discarded_after(&state, &opened, "delete-index", || {
        let deleted =
            delete_workspace_entry_legacy_inner(&state, &opened.workspace_token, &moved.new_path)
                .unwrap();
        assert!(matches!(
            deleted,
            MutationOutcome::ConfirmedCommitted { .. }
        ));
    });
}
#[test]
fn confirmed_content_saves_discard_the_active_index_but_rejected_saves_do_not() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, "before").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();
    open_workspace_file_inner(&state, &path).unwrap();
    let root = Path::new(&opened.root);

    let rejected_index =
        publish_workspace_index(&state, &opened.workspace_token, root, "rejected-save-index");
    assert!(save_expected_inner(
        &state,
        &path,
        "after",
        read_file_inner(&state, &path)
            .unwrap()
            .file_version
            .unwrap(),
        "rejected-save",
        "preview",
    )
    .is_err());
    assert!(state
        .workspace_index()
        .is_result_current(&opened.workspace_token, root, rejected_index.generation)
        .unwrap());

    let committed_index = publish_workspace_index(
        &state,
        &opened.workspace_token,
        root,
        "committed-save-index",
    );
    let response = save_expected_inner(
        &state,
        &path,
        "after",
        read_file_inner(&state, &path)
            .unwrap()
            .file_version
            .unwrap(),
        "committed-save",
        MAIN_SAVE_OWNER,
    )
    .unwrap();
    assert!(matches!(
        response,
        DocumentSaveResponse::ConfirmedCommitted { .. }
    ));
    assert_workspace_index_invalidated(&state, &opened.workspace_token, root, &committed_index);
}
#[test]
fn excalidraw_creation_open_write_and_save_as_require_valid_standard_scenes() {
    let directory = tempdir().unwrap();
    let state = AppState::default();
    let workspace = open_directory_inner(&state, directory.path()).unwrap();

    let created =
        create_default_excalidraw_file(&state, &workspace.workspace_token, directory.path());
    let initial_scene = default_excalidraw_scene();
    assert_created_excalidraw_matches_defaults(&created, initial_scene);

    let invalid_scene = r#"{"type":"excalidraw","version":2,"elements":[{"id":"shape","type":"rectangle","label":"private"}],"appState":{},"files":{}}"#;
    assert_rejected_excalidraw_write_and_save_as(
        &state,
        directory.path(),
        &created.path,
        invalid_scene,
        initial_scene,
    );

    let valid_destination = directory.path().join("copy.excalidraw");
    let saved = save_as_for_kind_inner(
        &state,
        &valid_destination,
        initial_scene.to_string(),
        Some(WorkspaceFileKind::Excalidraw),
    )
    .unwrap();
    assert!(matches!(saved, MutationOutcome::ConfirmedCommitted { .. }));
    assert_eq!(
        fs::read_to_string(&valid_destination).unwrap(),
        initial_scene
    );

    let malformed = directory.path().join("malformed.excalidraw");
    fs::write(&malformed, invalid_scene).unwrap();
    assert!(open_workspace_file_inner(&state, &malformed).is_err());
}
