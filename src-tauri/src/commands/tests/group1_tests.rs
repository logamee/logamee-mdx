use super::fixtures2::*;

#[test]
fn recent_menu_refresh_reloads_and_retries_without_rolling_back_the_snapshot() {
    let initial = RecentFilesSnapshot { entries: vec![] };
    let reloaded = RecentFilesSnapshot {
        entries: vec![crate::models::RecentFileSummary {
            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            display_name: "notes.md".to_string(),
        }],
    };
    let reload_calls = Cell::new(0);
    let refreshed = RefCell::new(Vec::new());

    let result = refresh_recent_menu_with_retry(
        &initial,
        || {
            reload_calls.set(reload_calls.get() + 1);
            Ok(reloaded.clone())
        },
        |snapshot| {
            refreshed.borrow_mut().push(snapshot.clone());
            if refreshed.borrow().len() == 1 {
                Err("injected first refresh failure".to_string())
            } else {
                Ok(())
            }
        },
    );

    assert!(result.is_ok());
    assert_eq!(reload_calls.get(), 1);
    assert_eq!(*refreshed.borrow(), [initial, reloaded]);
}
#[test]
fn recent_menu_refresh_reports_failure_only_after_reload_and_retry() {
    let snapshot = RecentFilesSnapshot { entries: vec![] };
    let refresh_calls = Cell::new(0);

    let result = refresh_recent_menu_with_retry(
        &snapshot,
        || Ok(snapshot.clone()),
        |_| {
            refresh_calls.set(refresh_calls.get() + 1);
            Err("injected refresh failure".to_string())
        },
    );

    assert_eq!(result.unwrap_err(), RECENT_MENU_SYNC_ERROR);
    assert_eq!(refresh_calls.get(), 2);
}
#[test]
fn asset_scope_sync_retries_once_before_success() {
    let attempts = Cell::new(0);

    let result = retry_asset_scope_sync(|| {
        attempts.set(attempts.get() + 1);
        if attempts.get() == 1 {
            Err("injected asset scope failure".to_string())
        } else {
            Ok(())
        }
    });

    assert!(result.is_ok());
    assert_eq!(attempts.get(), 2);
}
#[test]
fn asset_scope_sync_reports_failure_only_after_retry() {
    let attempts = Cell::new(0);

    let result = retry_asset_scope_sync(|| {
        attempts.set(attempts.get() + 1);
        Err(format!("injected asset scope failure {}", attempts.get()))
    });

    assert_eq!(result, Err("injected asset scope failure 2".to_string()));
    assert_eq!(attempts.get(), 2);
}
#[test]
fn workspace_file_open_authorizes_exact_file_for_later_write() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let sibling = dir.path().join("sibling.md");
    fs::write(&doc, "# doc").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let response = open_workspace_file_inner(&state, &doc).unwrap();
    assert_eq!(response.content.as_deref(), Some("# doc"));
    assert_eq!(
        ensure_authorized_write_file_inner(&state, &doc).unwrap(),
        normalize_existing_path(&doc).unwrap()
    );
    assert!(ensure_authorized_write_file_inner(&state, &sibling).is_err());
}
#[test]
fn workspace_text_decode_failure_publishes_no_exact_write_grant() {
    let dir = tempdir().unwrap();
    let document = dir.path().join("invalid.md");
    fs::write(&document, [0xff, 0xfe, 0xfd]).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

    let result = open_workspace_file_inner(&state, &document);

    assert!(result.is_err());
    assert!(ensure_authorized_write_file_inner(&state, &document).is_err());
}
#[test]
fn standalone_open_uses_only_existing_parent_allow_pattern_before_internal_grant_publish() {
    use std::cell::RefCell;

    let dir = tempdir().unwrap();
    let document = dir.path().join("document.md");
    let sibling = dir.path().join("sibling.md");
    let asset = dir.path().join("asset.png");
    fs::write(&document, "# document").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    fs::write(&asset, b"png").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let canonical_parent = canonical_document.parent().unwrap().to_path_buf();
    let state = AppState::default();
    let events = RefCell::new(Vec::new());
    let transport_paths = RefCell::new(Vec::new());

    let response = open_standalone_file_with_ports_inner(
        &state,
        &document,
        |file| {
            events.borrow_mut().push("response");
            open_authorized_file_response(file.to_path_buf())
        },
        |parent| {
            assert_eq!(*events.borrow(), ["response"]);
            assert!(parent.is_dir());
            transport_paths.borrow_mut().push(parent.to_path_buf());
            events.borrow_mut().push("transport");
            Ok(())
        },
    )
    .unwrap();
    events.borrow_mut().push("published");

    assert_eq!(*events.borrow(), ["response", "transport", "published"]);
    assert_eq!(*transport_paths.borrow(), [canonical_parent]);
    assert_eq!(response.content.as_deref(), Some("# document"));
    assert!(ensure_authorized_write_file_inner(&state, &document).is_ok());
    assert!(ensure_authorized_existing_file_inner(&state, &sibling).is_err());
    assert!(is_authorized_image_path(&state, &asset.canonicalize().unwrap()).unwrap());

    let failed_state = AppState::default();
    let failed = open_standalone_file_with_ports_inner(
        &failed_state,
        &document,
        |file| open_authorized_file_response(file.to_path_buf()),
        |_| Err("injected transport failure".to_string()),
    );
    assert!(failed.is_err());
    assert!(ensure_authorized_existing_file_inner(&failed_state, &document).is_err());
    assert!(!is_authorized_image_path(&failed_state, &asset.canonicalize().unwrap()).unwrap());
}
#[cfg(any(unix, windows))]
#[test]
fn workspace_open_refuses_a_parent_link_swap_after_authorization() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let nested = workspace.path().join("nested");
    let moved = workspace.path().join("moved");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("note.md"), "authorized content").unwrap();
    fs::write(outside.path().join("note.md"), "external secret").unwrap();
    let state = AppState::default();
    let app_data = tempdir().unwrap();
    state
        .initialize_recent_files(app_data.path().to_path_buf())
        .unwrap();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

    let result = prepare_workspace_file_with_before_open_inner(
        &state,
        "main",
        nested.join("note.md"),
        || {
            fs::rename(&nested, &moved).unwrap();
            replace_directory_with_test_link(&nested, outside.path());
        },
    );

    assert!(result.is_err());

    let reread_nested = workspace.path().join("reread-nested");
    let reread_moved = workspace.path().join("reread-moved");
    fs::create_dir(&reread_nested).unwrap();
    fs::write(reread_nested.join("note.md"), "authorized reread").unwrap();
    let reread = read_file_with_before_open_inner(&state, reread_nested.join("note.md"), || {
        fs::rename(&reread_nested, &reread_moved).unwrap();
        replace_directory_with_test_link(&reread_nested, outside.path());
    });

    assert!(reread.is_err());
}
#[test]
fn workspace_prepare_reads_the_bound_root_but_cannot_commit_after_replacement() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let displaced = directory.path().join("workspace-original");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), "authorized content").unwrap();
    let state = AppState::default();
    let app_data = tempdir().unwrap();
    state
        .initialize_recent_files(app_data.path().to_path_buf())
        .unwrap();
    authorize_directory_root_inner(&state, root.clone()).unwrap();

    let response =
        prepare_workspace_file_with_before_open_inner(&state, "main", root.join("note.md"), || {
            fs::rename(&root, &displaced).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("note.md"), "external secret").unwrap();
        })
        .unwrap();

    assert_eq!(response.file.content.as_deref(), Some("authorized content"));
    assert!(matches!(
        state
            .recent_files()
            .unwrap()
            .commit_open(&response.open_receipt, "main", state.file_authorization(),)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(ensure_authorized_write_file_inner(&state, root.join("note.md")).is_err());
}
#[test]
fn unsupported_standalone_open_does_not_publish_or_request_transport_authority() {
    let dir = tempdir().unwrap();
    let document = dir.path().join("document.txt");
    let sibling = dir.path().join("sibling.md");
    fs::write(&document, "unsupported").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    let state = AppState::default();
    let transport_calls = Cell::new(0);

    let result = open_standalone_file_with_ports_inner(
        &state,
        &document,
        |file| open_authorized_file_response(file.to_path_buf()),
        |_| {
            transport_calls.set(transport_calls.get() + 1);
            Ok(())
        },
    );

    assert_eq!(
        result.unwrap_err(),
        "Selected file is not a supported preview file"
    );
    assert_eq!(transport_calls.get(), 0);
    assert!(ensure_authorized_existing_file_inner(&state, &document).is_err());
    assert!(ensure_authorized_existing_file_inner(&state, &sibling).is_err());
}
