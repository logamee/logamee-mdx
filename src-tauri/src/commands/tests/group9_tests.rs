use super::fixtures2::*;
use super::group9_helpers::{
    attempt_partial_remove, canonicalize_partial_remove_scenario, create_partial_remove_workspace,
    open_partial_remove_documents, PartialRemoveAttempt, PartialRemoveScenario,
};

fn assert_partial_remove_grants(scenario: &PartialRemoveScenario) {
    for document in [
        &scenario.canonical_removed_document,
        &scenario.canonical_retained_document,
    ] {
        assert_eq!(
            scenario
                .state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(document)
                .unwrap(),
            Some((GrantStatus::Active, 1)),
        );
    }
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_target)
            .unwrap(),
        Some((GrantStatus::Active, 4)),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated_document)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_unrelated)
            .unwrap(),
        Some((GrantStatus::Active, 2)),
    );
}

fn assert_partial_remove_sites(scenario: &PartialRemoveScenario) {
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        HashSet::from([
            scenario.canonical_removed_document.clone(),
            scenario.canonical_retained_document.clone(),
            scenario.canonical_unrelated_document.clone(),
        ]),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        3,
    );
}

fn assert_partial_remove_outcome(scenario: &PartialRemoveScenario, attempt: &PartialRemoveAttempt) {
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(&attempt.outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "delete",
            "paths": [scenario.canonical_target.to_string_lossy()],
            "recovery_message": "Directory deletion may have partially changed the workspace after an error: Failed to delete directory: injected partial directory delete failure. Refresh and inspect the directory before retrying.",
        }),
    );
    assert_eq!(attempt.filesystem.remove_dir_all_calls.get(), 1);
    assert_eq!(
        *attempt.filesystem.removed_paths.borrow(),
        vec![scenario.canonical_target.clone()],
    );
    assert_eq!(
        *attempt.filesystem.observed_paths.borrow(),
        vec![scenario.canonical_target.clone()],
    );
    assert_eq!(attempt.snapshot_calls, 0);
    assert_eq!(
        attempt.lock_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
        ],
    );
}

fn assert_partial_remove_disk_state(scenario: &PartialRemoveScenario) {
    assert!(scenario.canonical_target.is_dir());
    assert!(!scenario.canonical_removed_document.exists());
    assert!(!scenario.canonical_removed_image.exists());
    assert_eq!(
        fs::read_to_string(&scenario.canonical_retained_document).unwrap(),
        "retained",
    );
}

fn assert_partial_remove_suspended_grants(scenario: &PartialRemoveScenario) {
    for document in [
        &scenario.canonical_removed_document,
        &scenario.canonical_retained_document,
    ] {
        assert_eq!(
            scenario
                .state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(document)
                .unwrap(),
            Some((GrantStatus::Suspended, 1)),
        );
    }
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_target)
            .unwrap(),
        Some((GrantStatus::Suspended, 2)),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated_document)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_unrelated)
            .unwrap(),
        Some((GrantStatus::Active, 2)),
    );
}

fn assert_partial_remove_sealed_sites(scenario: &PartialRemoveScenario) {
    assert!(ensure_authorized_write_file_inner(
        &scenario.state,
        &scenario.canonical_retained_document
    )
    .is_err());
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        HashSet::from([scenario.canonical_unrelated_document.clone()]),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap(),
        scenario.unrelated_leases.clone(),
    );
}

fn assert_partial_remove_provenance(scenario: &PartialRemoveScenario) {
    resolve_authorized_workspace_root_for_token_inner(
        &scenario.state,
        &scenario.selected_token,
        &scenario.canonical_workspace,
    )
    .expect("selected workspace provenance must remain active");
    resolve_authorized_workspace_root_for_token_inner(
        &scenario.state,
        &scenario.ancestor_token,
        &scenario.canonical_outer,
    )
    .expect("ancestor workspace provenance must remain active");
}

#[test]
fn partial_remove_dir_all_is_indeterminate() {
    let files = create_partial_remove_workspace();
    let state = AppState::default();
    let ancestor_opened = open_directory_inner(&state, files.outer.path()).unwrap();
    let opened = open_directory_inner(&state, &files.workspace).unwrap();
    let unrelated_leases = open_partial_remove_documents(&state, &files);
    let scenario = canonicalize_partial_remove_scenario(
        files,
        state,
        opened.workspace_token,
        ancestor_opened.workspace_token,
        unrelated_leases,
    );
    assert_partial_remove_grants(&scenario);
    assert_partial_remove_sites(&scenario);
    let attempt = attempt_partial_remove(&scenario);
    assert_partial_remove_outcome(&scenario, &attempt);
    assert_partial_remove_disk_state(&scenario);
    assert_partial_remove_suspended_grants(&scenario);
    assert_partial_remove_sealed_sites(&scenario);
    assert_partial_remove_provenance(&scenario);
}
