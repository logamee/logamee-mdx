use super::prelude::*;
use super::super::lock_probe::{trace, LockEvent};

fn assert_authorization_then_preview<T>(operation: impl FnOnce() -> Result<T, String>) {
    let (result, events) = trace(operation);
    result.unwrap();
    assert_eq!(
        events,
        [
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::HtmlSitesAcquired,
            LockEvent::HtmlSitesReleased,
        ]
    );
}

fn assert_preview_prepare_lock_order<T>(operation: impl FnOnce() -> Result<T, String>) {
    let (result, events) = trace(operation);
    result.unwrap();
    assert_eq!(
        events,
        [
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::HtmlSitesAcquired,
            LockEvent::HtmlSitesReleased,
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
        ]
    );
}

fn prepare_stage_obeys_prepare_then_authorization_lock_order() {
    let prepare_dir = tempdir().unwrap();
    let prepare_document = prepare_dir.path().join("prepare.html");
    fs::write(&prepare_document, "prepare").unwrap();
    let prepare_state = AppState::default();
    prepare_state
        .file_authorization()
        .authorize_file(&prepare_document)
        .unwrap();
    assert_preview_prepare_lock_order(|| {
        prepare_html_preview_inner(&prepare_state, &prepare_document, "prepare")
    });
}

fn relocate_stage_obeys_authorization_then_preview_lock_order() {
    let relocate_dir = tempdir().unwrap();
    let old_root = relocate_dir.path().join("old");
    fs::create_dir(&old_root).unwrap();
    let old_document = old_root.join("relocate.html");
    fs::write(&old_document, "relocate").unwrap();
    let canonical_old_root = normalize_existing_path(&old_root).unwrap();
    let relocate_state = AppState::default();
    relocate_state
        .file_authorization()
        .authorize_file(&old_document)
        .unwrap();
    prepare_html_preview_inner(&relocate_state, &old_document, "relocate").unwrap();
    let new_root = relocate_dir.path().join("new");
    fs::rename(&old_root, &new_root).unwrap();
    let canonical_new_root = normalize_existing_path(&new_root).unwrap();
    assert_authorization_then_preview(|| {
        relocate_authorized_path_prefix_inner(
            &relocate_state,
            &canonical_old_root,
            &canonical_new_root,
        )
    });
}

fn revoke_prefix_stage_obeys_authorization_then_preview_lock_order() {
    let revoke_prefix_dir = tempdir().unwrap();
    let revoke_prefix_root = revoke_prefix_dir.path().join("workspace");
    fs::create_dir(&revoke_prefix_root).unwrap();
    let revoke_prefix_document = revoke_prefix_root.join("revoke-prefix.html");
    fs::write(&revoke_prefix_document, "revoke prefix").unwrap();
    let canonical_revoke_prefix = normalize_existing_path(&revoke_prefix_root).unwrap();
    let revoke_prefix_state = AppState::default();
    revoke_prefix_state
        .file_authorization()
        .authorize_directory_root(&revoke_prefix_root)
        .unwrap();
    prepare_html_preview_inner(
        &revoke_prefix_state,
        &revoke_prefix_document,
        "revoke prefix",
    )
    .unwrap();
    assert_authorization_then_preview(|| {
        revoke_authorized_path_prefix_inner(&revoke_prefix_state, &canonical_revoke_prefix)
    });
}

fn revoke_file_stage_obeys_authorization_then_preview_lock_order() {
    let revoke_file_dir = tempdir().unwrap();
    let revoke_file_document = revoke_file_dir.path().join("revoke-file.html");
    fs::write(&revoke_file_document, "revoke file").unwrap();
    let revoke_file_state = AppState::default();
    let authorized_file = revoke_file_state
        .file_authorization()
        .authorize_file(&revoke_file_document)
        .unwrap();
    prepare_html_preview_inner(&revoke_file_state, &revoke_file_document, "revoke file")
        .unwrap();
    assert_authorization_then_preview(|| {
        revoke_authorized_file_inner(&revoke_file_state, &authorized_file)
    });
}

#[test]
fn revoke_prefix_and_origin_revocation_invalidate_unsupported_preview_sites() {
    let workspace = tempdir().unwrap();
    let removed_root = workspace.path().join("removed");
    fs::create_dir(&removed_root).unwrap();
    let removed_document = removed_root.join("index.html");
    let retained_document = workspace.path().join("retained.html");
    fs::write(&removed_document, "removed").unwrap();
    fs::write(&retained_document, "retained").unwrap();
    let canonical_removed_root = normalize_existing_path(&removed_root).unwrap();
    let canonical_removed_document = normalize_existing_path(&removed_document).unwrap();
    let canonical_retained_document = normalize_existing_path(&retained_document).unwrap();
    let state = AppState::default();
    state
        .file_authorization()
        .authorize_directory_root(workspace.path())
        .unwrap();
    prepare_html_preview_inner(&state, &removed_document, "removed").unwrap();
    prepare_html_preview_inner(&state, &retained_document, "retained").unwrap();

    fs::remove_dir_all(&removed_root).unwrap();
    revoke_authorized_path_prefix_inner(&state, &canonical_removed_root).unwrap();

    let documents = state.html_preview_server.site_documents().unwrap();
    assert!(!documents.contains(&canonical_removed_document));
    assert!(documents.contains(&canonical_retained_document));

    let standalone = tempdir().unwrap();
    let standalone_document = standalone.path().join("standalone.html");
    let standalone_asset = standalone.path().join("asset.png");
    fs::write(&standalone_document, "standalone").unwrap();
    fs::write(&standalone_asset, b"png").unwrap();
    let canonical_standalone_document = normalize_existing_path(&standalone_document).unwrap();
    let canonical_standalone_asset = normalize_existing_path(&standalone_asset).unwrap();
    let authorized_file = state
        .file_authorization()
        .authorize_file(&standalone_document)
        .unwrap();
    prepare_html_preview_inner(&state, &standalone_document, "standalone").unwrap();

    revoke_authorized_file_inner(&state, &authorized_file).unwrap();

    assert!(!state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&canonical_standalone_document));
    assert!(!is_authorized_image_path(&state, &canonical_standalone_asset).unwrap());
}
#[test]
fn authorization_and_preview_operations_obey_one_lock_order() {
    prepare_stage_obeys_prepare_then_authorization_lock_order();
    relocate_stage_obeys_authorization_then_preview_lock_order();
    revoke_prefix_stage_obeys_authorization_then_preview_lock_order();
    revoke_file_stage_obeys_authorization_then_preview_lock_order();
}

fn fetch_preview_site_response(new_url: &str) -> String {
    use std::{
        io::{Read, Write},
        net::TcpStream,
    };

    let address_and_path = new_url.strip_prefix("http://").unwrap();
    let (address, path) = address_and_path.split_once('/').unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "GET /{path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn assert_reprepare_lock_order(events: Vec<LockEvent>) {
    assert_eq!(
        events,
        [
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::HtmlSitesAcquired,
            LockEvent::HtmlSitesReleased,
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
        ]
    );
}

#[test]
fn stale_invalidation_cannot_remove_reprepared_same_path_site() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("index.html");
    fs::write(&document, "old generation").unwrap();
    let canonical_document = normalize_existing_path(&document).unwrap();
    let state = AppState::default();
    state
        .file_authorization()
        .authorize_directory_root(workspace.path())
        .unwrap();
    let old_url = prepare_html_preview_inner(&state, &document, "old generation").unwrap();

    let stale_leases = state
        .file_authorization()
        .revoke_path_prefix(&canonical_document)
        .unwrap();
    assert_eq!(stale_leases.len(), 1);

    let (new_url, reprepare_events) = lock_order_test_probe::trace(|| {
        prepare_html_preview_inner(&state, &document, "new generation")
    });
    let new_url = new_url.unwrap();
    state
        .html_preview_server
        .invalidate_preview_leases(&stale_leases)
        .unwrap();

    assert!(
        state
            .html_preview_server
            .site_documents()
            .unwrap()
            .contains(&canonical_document),
        "stale invalidation removed the re-prepared same-path site"
    );
    assert_eq!(new_url, old_url);
    let response = fetch_preview_site_response(&new_url);
    assert!(response.contains("new generation"));
    assert_reprepare_lock_order(reprepare_events);
}
#[test]
fn directory_snapshot_failure_consumes_candidate_and_publishes_nothing() {
    use std::cell::Cell;

    let workspace = tempdir().unwrap();
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
            assert_eq!(candidate.root, workspace.path().canonicalize().unwrap());
            Err::<(), _>("injected first snapshot failure".to_string())
        },
        |_| {
            transport_calls.set(transport_calls.get() + 1);
            Ok(())
        },
    );

    assert!(result.is_err());
    assert_eq!(snapshot_calls.get(), 1);
    assert_eq!(transport_calls.get(), 0);
    let state = session.lock().unwrap();
    assert!(state.workspaces.is_empty());
    assert!(state.grants.is_empty());
    assert_eq!(state.next_workspace_token_id, 0);
}
