use super::test_prelude::*;
use super::*;

#[test]
fn rename_follow_rejects_a_candidate_replaced_before_it_is_read() {
    let workspace = tempdir().unwrap();
    let old_path = workspace.path().join("old.md");
    let new_path = workspace.path().join("new.md");
    let displaced = workspace.path().join("displaced.md");
    fs::write(&old_path, "authorized content").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, old_path.clone()).unwrap();
    let canonical_old = old_path.canonicalize().unwrap();
    let watch = ActiveDocumentWatchState::default();
    watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());

    fs::rename(&canonical_old, &new_path).unwrap();
    fs::rename(&new_path, &displaced).unwrap();
    fs::write(&new_path, "replacement content").unwrap();
    let canonical_new = new_path.canonicalize().unwrap();
    let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
    context
        .rename_candidates
        .push((canonical_old.clone(), canonical_new.clone()));
    let mut resolved = resolve_disk_state(&state, &context).unwrap();
    let mut watch_state = watch.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();

    assert!(finalize_authorization_transition(&state, entry, &mut resolved).is_err());
    assert_eq!(entry.path, canonical_old);
    assert!(ensure_authorized_write_file_inner(&state, &canonical_new).is_err());
}
#[test]
fn rename_follow_migrates_write_authority_when_the_target_identity_is_unchanged() {
    let workspace = tempdir().unwrap();
    let old_path = workspace.path().join("old.md");
    let new_path = workspace.path().join("new.md");
    fs::write(&old_path, "authorized content").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, old_path.clone()).unwrap();
    let canonical_old = old_path.canonicalize().unwrap();
    let watch = ActiveDocumentWatchState::default();
    watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());
    fs::rename(&canonical_old, &new_path).unwrap();
    let canonical_new = new_path.canonicalize().unwrap();
    let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
    context
        .rename_candidates
        .push((canonical_old.clone(), canonical_new.clone()));
    let mut resolved = resolve_disk_state(&state, &context).unwrap();
    let mut watch_state = watch.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();

    finalize_authorization_transition(&state, entry, &mut resolved).unwrap();

    assert_eq!(entry.path, canonical_new);
    assert!(ensure_authorized_write_file_inner(&state, &entry.path).is_ok());
    assert!(ensure_authorized_write_file_inner(&state, &canonical_old).is_err());
}
#[test]
fn committed_save_binding_survives_an_immediate_rename_before_watch_settlement() {
    let workspace = tempdir().unwrap();
    let old_path = workspace.path().join("old.md");
    let new_path = workspace.path().join("new.md");
    fs::write(&old_path, "old content").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_workspace_file_inner(&state, &old_path).unwrap();
    let canonical_old = old_path.canonicalize().unwrap();
    let watch = ActiveDocumentWatchState::default();
    watch.install_for_test("watch-1", "pane-document-1", 7, canonical_old.clone());
    assert!(watch.activate_for_test("watch-1", "pane-document-1", 7, 1));
    let token = watch
        .begin_app_write(&canonical_old, b"saved content".to_vec())
        .unwrap();
    let expected = capture_file_version(&canonical_old).unwrap().unwrap();
    let outcome = DocumentSaveCoordinator::default()
        .save_expected(
            state.file_authorization(),
            &canonical_old,
            b"saved content",
            expected,
            "save-before-rename",
            MAIN_SAVE_OWNER,
        )
        .unwrap();
    let DocumentSaveDisposition::ConfirmedCommitted { version, .. } = outcome else {
        panic!("save must commit");
    };

    fs::rename(&canonical_old, &new_path).unwrap();
    let canonical_new = new_path.canonicalize().unwrap();
    watch.apply_committed_version(&token, &version);
    watch.settle_app_write(token, true);
    let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
    context
        .rename_candidates
        .push((canonical_old.clone(), canonical_new.clone()));
    let mut resolved = resolve_disk_state(&state, &context).unwrap();
    let mut watch_state = watch.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();

    finalize_authorization_transition(&state, entry, &mut resolved).unwrap();

    assert_eq!(entry.path, canonical_new);
    assert!(ensure_authorized_write_file_inner(&state, &entry.path).is_ok());
    assert!(ensure_authorized_write_file_inner(&state, &canonical_old).is_err());
}
#[test]
fn ambiguous_or_incompatible_rename_candidates_become_missing() {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let old_path = root.join("old.md");
    let first = root.join("first.md");
    let second = root.join("second.md");
    let html = root.join("new.html");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();
    fs::write(&html, "<p>html</p>").unwrap();
    let first = fs::canonicalize(first).unwrap();
    let second = fs::canonicalize(second).unwrap();
    let html = fs::canonicalize(html).unwrap();

    let mut ambiguous = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
    ambiguous.rename_candidates = vec![(old_path.clone(), first), (old_path.clone(), second)];
    assert!(matches!(
        resolve_disk_state(&state, &ambiguous).unwrap(),
        ResolvedDisk::Missing
    ));

    let mut incompatible = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
    incompatible.rename_candidates = vec![(old_path, html)];
    assert!(matches!(
        resolve_disk_state(&state, &incompatible).unwrap(),
        ResolvedDisk::Missing
    ));
}
#[test]
fn unauthorized_rename_destination_is_not_followed() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let old_path = root.join("old.md");
    let outside_path = outside.path().join("outside.md");
    fs::write(&outside_path, "outside").unwrap();
    let outside_path = fs::canonicalize(outside_path).unwrap();
    let mut context = reconcile_context(&old_path, WorkspaceFileKind::Markdown);
    context.rename_candidates = vec![(old_path, outside_path)];

    assert!(matches!(
        resolve_disk_state(&state, &context).unwrap(),
        ResolvedDisk::Missing
    ));
}
#[test]
fn committed_write_suppression_requires_exact_path_and_bytes_and_is_cleared() {
    let state = installed_state();
    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    let path = PathBuf::from("/workspace/notes.md");
    let token = state.begin_app_write(&path, b"# Saved".to_vec()).unwrap();
    assert!(state.settle_app_write(token, true).is_none());

    let matching = resolved_present_changed_file(&path, "# Saved", "matching-identity");
    let different_bytes = resolved_present_changed_file(&path, "# External", "different-identity");

    let mut watch_state = state.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();
    assert!(ActiveDocumentWatchState::committed_write_matches(
        entry, &matching
    ));
    assert!(!ActiveDocumentWatchState::committed_write_matches(
        entry,
        &different_bytes,
    ));
    let prior_epoch = entry.write_epoch;
    ActiveDocumentWatchState::clear_committed_expectation(entry).unwrap();
    assert!(entry.write_epoch > prior_epoch);
    assert!(!ActiveDocumentWatchState::committed_write_matches(
        entry, &matching
    ));
}

fn resolved_present_changed_file(path: &Path, content: &str, identity: &str) -> ResolvedDisk {
    ResolvedDisk::Present {
        file: OpenFileResponse {
            kind: WorkspaceFileKind::Markdown,
            path: path.to_string_lossy().to_string(),
            content_mode: ContentMode::Text,
            file_version: None,
            content: Some(content.to_string()),
            mime_type: None,
            bytes_base64: None,
        },
        file_identity: identity.to_string(),
        file_binding: Arc::new(tempfile().unwrap()),
        workspace_authorization: None,
        reason: ActiveDocumentWatchReason::Changed,
        previous_path: None,
    }
}
