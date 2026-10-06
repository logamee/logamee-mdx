use super::fixtures2::*;

#[test]
fn invalid_saved_active_file_is_cleared_while_its_workspace_is_restored() {
    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let unsupported = workspace.path().join("unsupported.txt");
    let excluded_directory = workspace.path().join(".git");
    let excluded_document = excluded_directory.join("hidden.md");
    let outside_document = outside.path().join("outside.md");
    fs::create_dir(&excluded_directory).unwrap();
    fs::write(&unsupported, "not a document").unwrap();
    fs::write(&excluded_document, "# hidden").unwrap();
    fs::write(&outside_document, "# outside").unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let canonical_outside = outside_document.canonicalize().unwrap();

    for active_path in [
        canonical_root.join("missing.md"),
        unsupported.canonicalize().unwrap(),
        excluded_document.canonicalize().unwrap(),
        canonical_outside.clone(),
    ] {
        let state = session_state(app_data.path().to_path_buf());
        state
            .workspace_session()
            .unwrap()
            .save(&WorkspaceSessionRecord::new(
                canonical_root.to_string_lossy().to_string(),
                Some(active_path.to_string_lossy().to_string()),
            ))
            .unwrap();

        let restored = restore_workspace_session_inner(&state)
            .unwrap()
            .expect("valid workspace root remains restorable");
        assert_eq!(restored.workspace.root, canonical_root.to_string_lossy());
        assert!(restored.active_file.is_none());
        assert_eq!(
            state
                .workspace_session()
                .unwrap()
                .load()
                .unwrap()
                .expect("workspace session root remains")
                .active_path(),
            None
        );
    }
}
#[cfg(unix)]
#[test]
fn symlinked_saved_active_file_is_not_restored() {
    use std::os::unix::fs::symlink;

    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_document = outside.path().join("outside.md");
    let linked_document = workspace.path().join("linked.md");
    fs::write(&outside_document, "# outside").unwrap();
    symlink(&outside_document, &linked_document).unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let state = session_state(app_data.path().to_path_buf());
    state
        .workspace_session()
        .unwrap()
        .save(&WorkspaceSessionRecord::new(
            canonical_root.to_string_lossy().to_string(),
            Some(linked_document.to_string_lossy().to_string()),
        ))
        .unwrap();

    let restored = restore_workspace_session_inner(&state)
        .unwrap()
        .expect("workspace root remains restorable");
    assert!(restored.active_file.is_none());
    assert_eq!(
        state
            .workspace_session()
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .active_path(),
        None
    );
}
#[test]
fn workspace_session_persistence_requires_the_current_workspace_and_a_supported_descendant() {
    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let document = workspace.path().join("notes.md");
    let outside_document = outside.path().join("outside.md");
    fs::write(&document, "# Notes").unwrap();
    fs::write(&outside_document, "# Outside").unwrap();
    let state = session_state(app_data.path().to_path_buf());
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    assert!(persist_workspace_session_inner(&state, "workspace-999", &opened.root, None,).is_err());
    assert!(persist_workspace_session_inner(
        &state,
        &opened.workspace_token,
        &opened.root,
        outside_document.canonicalize().unwrap().to_str(),
    )
    .is_err());
    assert!(state.workspace_session().unwrap().load().unwrap().is_none());
}
fn opened_editable(state: &AppState, path: &Path) -> OpenFileResponse {
    authorize_directory_root_inner(state, path.parent().unwrap().to_path_buf()).unwrap();
    open_workspace_file_inner(state, path).unwrap()
}

fn assert_reread_and_wire_version_match(state: &AppState, path: &Path, opened: &OpenFileResponse) {
    let reread = read_file_inner(state, path).unwrap();
    assert_eq!(reread.content, opened.content);
    assert_eq!(reread.file_version, opened.file_version);
    let wire = serde_json::to_value(opened).unwrap();
    assert!(wire["file_version"]["length"].is_string());
    assert!(wire["file_version"]["modifiedNanos"].is_string());
    assert_eq!(wire["content"], "a substantially longer document");
}

fn committed_save_version(
    outcome: Result<DocumentSaveResponse, String>,
) -> crate::durable_write::FileVersion {
    match outcome.unwrap() {
        DocumentSaveResponse::ConfirmedCommitted { version, .. } => version,
        other => panic!("expected committed save, got {other:?}"),
    }
}

#[test]
fn coordinated_save_uses_exact_versions_and_preserves_empty_and_shorter_bytes() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("note.md");
    fs::write(&path, "a substantially longer document").unwrap();
    let state = AppState::default();
    let opened = opened_editable(&state, &path);
    assert_reread_and_wire_version_match(&state, &path, &opened);
    let original = opened.file_version.unwrap();

    let shorter = committed_save_version(save_expected_inner(
        &state,
        &path,
        "short",
        original.clone(),
        "shorten",
        MAIN_SAVE_OWNER,
    ));
    assert_eq!(fs::read(&path).unwrap(), b"short");

    let empty = save_expected_inner(&state, &path, "", shorter, "empty", MAIN_SAVE_OWNER).unwrap();
    assert!(matches!(
        empty,
        DocumentSaveResponse::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(&path).unwrap(), b"");

    let stale =
        save_expected_inner(&state, &path, "stale", original, "stale", MAIN_SAVE_OWNER).unwrap();
    assert!(matches!(stale, DocumentSaveResponse::Conflict { .. }));
    assert_eq!(fs::read(&path).unwrap(), b"");
}
#[test]
fn coordinated_save_rejects_wrong_owner_before_writing() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("note.md");
    fs::write(&path, "before").unwrap();
    let state = AppState::default();
    let version = opened_editable(&state, &path).file_version.unwrap();

    let error =
        save_expected_inner(&state, &path, "after", version, "owner", "preview").unwrap_err();

    assert_eq!(error, "Document saves are owned by the main window");
    assert_eq!(fs::read_to_string(&path).unwrap(), "before");
}
fn issued_overwrite_token(
    state: &AppState,
    path: &Path,
    content: &str,
    operation_id: &str,
) -> OverwriteTokenResponse {
    issue_document_overwrite_token_inner(state, path, content, operation_id, MAIN_SAVE_OWNER)
        .unwrap()
}

fn assert_retry_save_rejected(
    state: &AppState,
    path: &Path,
    content: &str,
    operation_id: &str,
    overwrite_token: &str,
    owner: &str,
) {
    assert!(retry_document_save_with_token_inner(
        state,
        path,
        content,
        operation_id,
        overwrite_token,
        owner,
    )
    .is_err());
}

fn assert_overwrite_token_bound_to_content(state: &AppState, path: &Path) {
    let mismatched = issued_overwrite_token(state, path, "ours", "overwrite-1");
    assert_retry_save_rejected(
        state,
        path,
        "different",
        "overwrite-1",
        &mismatched.overwrite_token,
        MAIN_SAVE_OWNER,
    );
    assert_retry_save_rejected(
        state,
        path,
        "ours",
        "overwrite-1",
        &mismatched.overwrite_token,
        MAIN_SAVE_OWNER,
    );
}

fn assert_overwrite_token_owner_and_operation_checked(state: &AppState, path: &Path) {
    let token = issued_overwrite_token(state, path, "ours", "overwrite-2");
    assert_retry_save_rejected(
        state,
        path,
        "ours",
        "overwrite-2",
        &token.overwrite_token,
        "preview",
    );
    assert_retry_save_rejected(
        state,
        path,
        "ours",
        "overwrite-2",
        &token.overwrite_token,
        MAIN_SAVE_OWNER,
    );
}

fn assert_overwrite_token_commit_is_single_use(state: &AppState, path: &Path) {
    let replacement_token = issued_overwrite_token(state, path, "ours", "overwrite-3");
    let committed = retry_document_save_with_token_inner(
        state,
        path,
        "ours",
        "overwrite-3",
        &replacement_token.overwrite_token,
        MAIN_SAVE_OWNER,
    )
    .unwrap();
    assert!(matches!(
        committed,
        DocumentSaveResponse::ConfirmedCommitted { .. }
    ));
    assert_retry_save_rejected(
        state,
        path,
        "ours",
        "overwrite-3",
        &replacement_token.overwrite_token,
        MAIN_SAVE_OWNER,
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "ours");
}

#[test]
fn overwrite_token_is_bound_to_content_and_is_single_use() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("note.md");
    fs::write(&path, "disk").unwrap();
    let state = AppState::default();
    opened_editable(&state, &path);

    assert_overwrite_token_bound_to_content(&state, &path);
    assert_overwrite_token_owner_and_operation_checked(&state, &path);
    assert_overwrite_token_commit_is_single_use(&state, &path);
}
