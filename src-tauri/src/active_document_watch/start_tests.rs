use super::test_prelude::*;
use super::*;

#[test]
fn pending_registration_buffers_hint_and_activation_replays_it() {
    let state = installed_state();
    state.note_hint_for_test("watch-1");

    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    assert!(state.take_reconcile_request_for_test("watch-1"));
    assert!(!state.take_reconcile_request_for_test("watch-1"));
}
#[test]
fn activation_rejects_wrong_identity_and_registration_sequence() {
    let state = installed_state();

    assert!(!state.activate_for_test("watch-2", "pane-document-1", 7, 1));
    assert!(!state.activate_for_test("watch-1", "pane-document-2", 7, 1));
    assert!(!state.activate_for_test("watch-1", "pane-document-1", 8, 1));
    assert!(!state.activate_for_test("watch-1", "pane-document-1", 7, 2));
    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
}
#[test]
fn stale_stop_cannot_stop_the_current_watch() {
    let state = installed_state();

    assert!(!state.stop_for_test("watch-stale"));
    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
}
#[test]
fn write_epoch_invalidates_inflight_reconcile_and_requests_one_rerun() {
    let state = installed_state();
    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    let captured_epoch = state.captured_write_epoch_for_test("watch-1").unwrap();

    let write_epoch = state
        .begin_write_for_test(
            PathBuf::from("/workspace/notes.md").as_path(),
            b"# Saved".to_vec(),
        )
        .unwrap();
    assert!(write_epoch > captured_epoch);
    state.note_hint_for_test("watch-1");

    assert!(state.settle_write_for_test(true));
    assert!(state.take_reconcile_request_for_test("watch-1"));
    assert!(!state.take_reconcile_request_for_test("watch-1"));
}
#[test]
fn relevant_burst_coalesces_into_one_scheduled_reconcile_and_one_follow_up() {
    let state = installed_state();
    assert!(state.activate_for_test("watch-1", "pane-document-1", 7, 1));
    let path = PathBuf::from("/workspace/notes.md");

    assert!(state
        .note_native_hint("watch-1", std::slice::from_ref(&path), Vec::new(), false)
        .unwrap());
    assert!(!state
        .note_native_hint("watch-1", std::slice::from_ref(&path), Vec::new(), false)
        .unwrap());
    assert!(!state
        .note_native_hint(
            "watch-1",
            &[PathBuf::from("/workspace/unrelated.md")],
            Vec::new(),
            false,
        )
        .unwrap());

    assert!(state
        .capture_scheduled_context("watch-1", ScheduledReconcileMode::Event)
        .unwrap()
        .is_some());
    let mut watch_state = state.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();
    assert!(ActiveDocumentWatchState::finish_scheduled(entry));
    assert!(entry.reconcile_scheduled);
    assert!(!entry.reconcile_again);
}
#[test]
fn missing_grace_reuses_one_token_and_invalidates_it_when_presence_returns() {
    let state = installed_state();
    let mut watch_state = state.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();

    let first = ActiveDocumentWatchState::begin_missing_grace(entry).unwrap();
    let repeated = ActiveDocumentWatchState::begin_missing_grace(entry).unwrap();
    assert_eq!(repeated, first);
    assert!(entry.missing_pending);

    ActiveDocumentWatchState::cancel_missing_grace(entry).unwrap();
    assert!(!entry.missing_pending);
    assert!(entry.missing_token > first);
}
#[test]
fn stop_all_stops_the_native_handle_once_and_is_idempotent() {
    let state = installed_state();
    let stop_count = Arc::new(AtomicUsize::new(0));
    state.lock().unwrap().current.as_mut().unwrap().handle =
        Some(Box::new(CountingHandle(stop_count.clone())));

    state.stop_all();
    state.stop_all();

    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
}
#[test]
fn tracked_present_path_outranks_rename_away_candidates() {
    let workspace = tempdir().unwrap();
    let active = workspace.path().join("notes.md");
    let backup = workspace.path().join("notes.backup.md");
    fs::write(&active, "final contents").unwrap();
    fs::write(&backup, "old contents").unwrap();
    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let active = fs::canonicalize(root.join("notes.md")).unwrap();
    let backup = fs::canonicalize(root.join("notes.backup.md")).unwrap();
    let mut context = reconcile_context(&active, WorkspaceFileKind::Markdown);
    context.rename_candidates.push((active.clone(), backup));

    match resolve_disk_state(&state, &context).unwrap() {
        ResolvedDisk::Present {
            file,
            reason,
            previous_path,
            ..
        } => {
            assert_eq!(file.path, active.to_string_lossy());
            assert_eq!(file.content.as_deref(), Some("final contents"));
            assert_eq!(reason, ActiveDocumentWatchReason::Changed);
            assert_eq!(previous_path, None);
        }
        ResolvedDisk::Missing => panic!("tracked path must win while present"),
    }
}
#[test]
fn rename_follow_requires_one_authorized_candidate_with_the_exact_file_kind() {
    for (extension, file_kind) in [
        ("md", WorkspaceFileKind::Markdown),
        ("pdf", WorkspaceFileKind::Pdf),
        ("docx", WorkspaceFileKind::Docx),
    ] {
        let workspace = tempdir().unwrap();
        let state = AppState::default();
        let root =
            authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let old_path = root.join(format!("old.{extension}"));
        let new_path = root.join(format!("new.{extension}"));
        let bytes = if file_kind == WorkspaceFileKind::Docx {
            minimal_docx_zip()
        } else {
            b"replacement bytes".to_vec()
        };
        fs::write(&new_path, bytes).unwrap();
        let new_path = fs::canonicalize(new_path).unwrap();
        let mut context = reconcile_context(&old_path, file_kind);
        context
            .rename_candidates
            .push((old_path.clone(), new_path.clone()));
        context
            .rename_candidates
            .push((old_path.clone(), new_path.clone()));

        match resolve_disk_state(&state, &context).unwrap() {
            ResolvedDisk::Present {
                file,
                reason,
                previous_path,
                ..
            } => {
                assert_eq!(file.path, new_path.to_string_lossy());
                assert_eq!(reason, ActiveDocumentWatchReason::Renamed);
                assert_eq!(previous_path, Some(old_path));
            }
            ResolvedDisk::Missing => panic!("one authorized same-kind rename must be followed"),
        }
    }
}
#[test]
fn rename_follow_does_not_migrate_write_authority_to_a_replacement_target() {
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
    let canonical_new = new_path.canonicalize().unwrap();
    let mut context = reconcile_context(&canonical_old, WorkspaceFileKind::Markdown);
    context
        .rename_candidates
        .push((canonical_old.clone(), canonical_new.clone()));
    let mut resolved = resolve_disk_state(&state, &context).unwrap();

    fs::rename(&canonical_new, &displaced).unwrap();
    fs::write(&canonical_new, "replacement content").unwrap();
    let mut watch_state = watch.lock().unwrap();
    let entry = watch_state.current.as_mut().unwrap();

    assert!(finalize_authorization_transition(&state, entry, &mut resolved).is_err());
    assert_eq!(entry.path, canonical_old);
    assert!(ensure_authorized_write_file_inner(&state, &canonical_new).is_err());
}
