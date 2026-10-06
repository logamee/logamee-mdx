use super::fixtures2::*;
use super::group10_helpers::{
    arrange_complete_delete_scenario, delete_target_with_complete_delete_port,
    CompleteDeleteScenario, DeleteObservationFailurePort,
};

fn assert_complete_delete_receipt(
    scenario: &CompleteDeleteScenario,
    receipt: crate::models::MutationCommitReceipt<
        crate::models::DeleteWorkspaceEntryResponse,
        WorkspaceSnapshot,
    >,
) {
    assert_eq!(
        receipt.committed.deleted_path,
        scenario.canonical_target.to_string_lossy()
    );
    let SnapshotReceipt::Fresh { snapshot } = receipt.workspace else {
        panic!("expected a fresh workspace snapshot");
    };
    assert_eq!(snapshot.workspace_token, scenario.opened.workspace_token);
    assert_eq!(snapshot.root, scenario.opened.root);
    assert!(snapshot.files.is_empty());
    assert!(snapshot.directories.is_empty());
}

fn assert_complete_delete_cleanup(
    scenario: &CompleteDeleteScenario,
    lock_events: Vec<crate::path_auth::lock_order_test_probe::LockEvent>,
) {
    assert_eq!(scenario.filesystem.remove_dir_all_calls.get(), 1);
    assert_eq!(scenario.filesystem.observe_calls.get(), 1);
    assert!(!scenario.canonical_target.exists());
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_document)
            .unwrap(),
        None,
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_target)
            .unwrap(),
        None,
    );
    assert!(scenario
        .state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(scenario
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
    assert_eq!(
        lock_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
        ],
    );
}

#[test]
fn remove_dir_all_error_after_complete_delete_is_confirmed_committed() {
    let scenario = arrange_complete_delete_scenario();
    let outcome = delete_target_with_complete_delete_port(&scenario);
    assert_complete_delete_receipt(&scenario, outcome.receipt);
    assert_complete_delete_cleanup(&scenario, outcome.lock_events);
}
#[test]
fn delete_observation_failure_is_indeterminate_and_suspends_authority() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    fs::write(&document, "<h1>draft</h1>").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &document, "preview").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let filesystem = DeleteObservationFailurePort {
        remove_file_calls: Cell::new(0),
        observe_calls: Cell::new(0),
    };

    let outcome = delete_workspace_entry_with_ports_inner(
        &state,
        &opened.workspace_token,
        &canonical_document,
        &filesystem,
        |_source| Err("snapshot must not run for an indeterminate delete".to_string()),
    )
    .expect("post-attempt delete errors must remain mutation outcomes");

    let value = serde_json::to_value(outcome).unwrap();
    assert_eq!(value["status"], "indeterminate");
    assert_eq!(value["operation"], "delete");
    assert!(value["recovery_message"]
        .as_str()
        .unwrap()
        .contains("injected observation failure"));
    assert_eq!(filesystem.remove_file_calls.get(), 1);
    assert_eq!(filesystem.observe_calls.get(), 1);
    assert!(canonical_document.exists());
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&canonical_document)
            .unwrap()
            .map(|(status, _)| status),
        Some(GrantStatus::Suspended)
    );
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
}
#[test]
fn injected_pre_call_write_failure_changes_neither_bytes_nor_grants() {
    use serde_json::json;

    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    fs::write(&document, "<h1>before</h1>").unwrap();

    let state = AppState::default();
    open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &document, "<h1>preview</h1>")
        .unwrap();

    let canonical_document = document.canonicalize().unwrap();
    let authorization_before = state.file_authorization().state_fingerprint_for_test();
    let sites_before = state.html_preview_server.site_documents().unwrap();
    let filesystem = ScriptedFileSystemPort::default();

    let outcome = write_file_with_preflight_and_ports_inner(
        &state,
        &canonical_document,
        "<h1>after</h1>",
        |path| {
            assert_eq!(path, canonical_document);
            Err("injected pre-call write failure".to_string())
        },
        &filesystem,
    )
    .expect("pre-call failures must be returned as mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-not-committed",
            "message": "injected pre-call write failure",
        })
    );
    assert_eq!(filesystem.write_calls.get(), 0);
    assert_eq!(
        fs::read_to_string(&canonical_document).unwrap(),
        "<h1>before</h1>"
    );
    assert_eq!(
        state.file_authorization().state_fingerprint_for_test(),
        authorization_before
    );
    assert_eq!(
        state.html_preview_server.site_documents().unwrap(),
        sites_before
    );
}
