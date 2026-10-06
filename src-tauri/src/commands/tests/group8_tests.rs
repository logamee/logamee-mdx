use super::fixtures2::*;
use super::group8_helpers::{
    arrange_remove_file_error_scenario, attempt_remove_file_error, RemoveFileErrorAttempt,
    RemoveFileErrorLayout, RemoveFileErrorScenario,
};

fn assert_remove_file_error_grants(
    layout: RemoveFileErrorLayout,
    scenario: &RemoveFileErrorScenario,
) {
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_affected)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
        "{layout:?}",
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
        "{layout:?}",
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_shared)
            .unwrap(),
        Some((GrantStatus::Active, 4)),
        "{layout:?}",
    );
    assert_eq!(
        scenario.sites_before,
        HashSet::from([
            scenario.canonical_affected.clone(),
            scenario.canonical_unrelated.clone(),
        ]),
        "{layout:?}",
    );
    assert_eq!(scenario.leases_before.len(), 2, "{layout:?}");
}

fn assert_remove_file_error_outcome(
    layout: RemoveFileErrorLayout,
    scenario: &RemoveFileErrorScenario,
    attempt: &RemoveFileErrorAttempt,
) {
    use serde_json::json;

    let expected = match layout {
        RemoveFileErrorLayout::Present => json!({
            "status": "confirmed-not-committed",
            "message": "Failed to delete file: injected post-attempt file delete failure",
        }),
        RemoveFileErrorLayout::Absent => json!({
            "status": "confirmed-committed",
            "receipt": {
                "committed": {
                    "deleted_path": scenario.canonical_affected.to_string_lossy(),
                },
                "workspace": {
                    "status": "stale",
                    "workspace_token": scenario.selected_token,
                    "repair_reason": "injected post-commit snapshot failure",
                },
            },
        }),
    };
    assert_eq!(
        serde_json::to_value(&attempt.outcome).unwrap(),
        expected,
        "{layout:?}"
    );
    assert_eq!(attempt.filesystem.remove_file_calls.get(), 1, "{layout:?}");
    assert_eq!(
        *attempt.filesystem.removed_paths.borrow(),
        vec![scenario.canonical_affected.clone()],
        "{layout:?}",
    );
    assert_eq!(
        *attempt.filesystem.observed_paths.borrow(),
        vec![scenario.canonical_affected.clone()],
        "{layout:?}",
    );
}

fn assert_present_remove_kept_everything(
    scenario: &RemoveFileErrorScenario,
    attempt: &RemoveFileErrorAttempt,
) {
    assert_eq!(attempt.snapshot_calls, 0);
    assert_eq!(
        fs::read_to_string(&scenario.canonical_affected).unwrap(),
        "affected"
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .state_fingerprint_for_test(),
        scenario.authorization_before,
    );
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        scenario.sites_before,
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap(),
        scenario.leases_before,
    );
    assert_eq!(
        attempt.lock_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
        ],
    );
}

fn assert_absent_remove_committed(
    scenario: &RemoveFileErrorScenario,
    attempt: &RemoveFileErrorAttempt,
) {
    assert_eq!(attempt.snapshot_calls, 1);
    assert!(!scenario.canonical_affected.exists());
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_affected)
            .unwrap(),
        None,
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated)
            .unwrap(),
        Some((GrantStatus::Active, 1)),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_shared)
            .unwrap(),
        Some((GrantStatus::Active, 2)),
    );
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        HashSet::from([scenario.canonical_unrelated.clone()]),
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        1,
    );
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

fn assert_remove_file_error_provenance(scenario: &RemoveFileErrorScenario) {
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
fn remove_file_error_layouts_distinguish_present_from_absent_commit() {
    for layout in [
        RemoveFileErrorLayout::Present,
        RemoveFileErrorLayout::Absent,
    ] {
        let scenario = arrange_remove_file_error_scenario();
        assert_remove_file_error_grants(layout, &scenario);
        let attempt = attempt_remove_file_error(layout, &scenario);
        assert_remove_file_error_outcome(layout, &scenario, &attempt);
        match layout {
            RemoveFileErrorLayout::Present => {
                assert_present_remove_kept_everything(&scenario, &attempt)
            }
            RemoveFileErrorLayout::Absent => assert_absent_remove_committed(&scenario, &attempt),
        }
        assert_remove_file_error_provenance(&scenario);
    }
}
