use super::fixtures2::*;
use super::fixtures3::*;
use super::group7_helpers::*;

fn assert_rename_error_baseline(layout: RenameErrorLayout, scenario: &RenameErrorScenario) {
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        scenario.all_sites,
        "{layout:?}",
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        3,
        "{layout:?}",
    );
    for document in [
        &scenario.canonical_old_document,
        &scenario.canonical_new_document,
    ] {
        assert_eq!(
            scenario
                .state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(document)
                .unwrap(),
            Some((GrantStatus::Active, 1)),
            "{layout:?}",
        );
    }
    for directory in [&scenario.canonical_source, &scenario.canonical_target] {
        assert_eq!(
            scenario
                .state
                .file_authorization()
                .internal_asset_grant_snapshot_for_test(directory)
                .unwrap(),
            Some((GrantStatus::Active, 2)),
            "{layout:?}",
        );
    }
}

fn capture_unrelated_grant_baseline(
    scenario: &RenameErrorScenario,
) -> (Option<(GrantStatus, usize)>, Option<(GrantStatus, usize)>) {
    let unrelated_exact_before = scenario
        .state
        .file_authorization()
        .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated_document)
        .unwrap();
    let unrelated_internal_before = scenario
        .state
        .file_authorization()
        .internal_asset_grant_snapshot_for_test(&scenario.canonical_unrelated)
        .unwrap();
    assert_eq!(unrelated_exact_before, Some((GrantStatus::Active, 1)));
    assert_eq!(unrelated_internal_before, Some((GrantStatus::Active, 2)));
    (unrelated_exact_before, unrelated_internal_before)
}

fn assert_rename_error_attempt(
    layout: RenameErrorLayout,
    scenario: &RenameErrorScenario,
    attempt: &RenameErrorAttempt,
) {
    let expected = expected_rename_error_outcome(
        layout,
        &scenario.canonical_source,
        &scenario.canonical_target,
        &scenario.workspace_token,
    );
    assert_eq!(
        serde_json::to_value(&attempt.outcome).unwrap(),
        expected,
        "{layout:?}"
    );
    assert_eq!(attempt.filesystem.rename_calls.get(), 1, "{layout:?}");
    assert_eq!(
        *attempt.filesystem.renamed_paths.borrow(),
        vec![(
            scenario.canonical_source.clone(),
            scenario.canonical_target.clone()
        )],
        "{layout:?}",
    );
    let observed_paths = attempt.filesystem.observed_paths.borrow();
    assert_eq!(
        *observed_paths,
        vec![
            scenario.canonical_source.clone(),
            scenario.canonical_target.clone()
        ],
        "{layout:?}",
    );
}

fn assert_rename_error_lock_order(layout: RenameErrorLayout, attempt: &RenameErrorAttempt) {
    let authorization_acquired = attempt
        .lock_events
        .iter()
        .filter(|event| {
            matches!(
                event,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired
            )
        })
        .count();
    let authorization_released = attempt
        .lock_events
        .iter()
        .filter(|event| {
            matches!(
                event,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased
            )
        })
        .count();
    let html_acquired = attempt
        .lock_events
        .iter()
        .filter(|event| {
            matches!(
                event,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired
            )
        })
        .count();
    let html_released = attempt
        .lock_events
        .iter()
        .filter(|event| {
            matches!(
                event,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased
            )
        })
        .count();
    assert_eq!(authorization_acquired, authorization_released, "{layout:?}");
    assert_eq!(html_acquired, html_released, "{layout:?}");
    assert_eq!(
        attempt.snapshot_calls,
        usize::from(matches!(layout, RenameErrorLayout::NewOnly)),
        "{layout:?}",
    );
}

fn assert_rename_error_unrelated_grants(
    layout: RenameErrorLayout,
    scenario: &RenameErrorScenario,
    unrelated_before: (Option<(GrantStatus, usize)>, Option<(GrantStatus, usize)>),
) {
    assert_rename_error_filesystem(
        layout,
        &scenario.canonical_source,
        &scenario.canonical_target,
        &scenario.canonical_old_document,
        &scenario.canonical_new_document,
        &scenario.state,
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&scenario.canonical_unrelated_document)
            .unwrap(),
        unrelated_before.0,
        "{layout:?}",
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(&scenario.canonical_unrelated)
            .unwrap(),
        unrelated_before.1,
        "{layout:?}",
    );
}

fn assert_rename_error_preview_reconciliation(
    layout: RenameErrorLayout,
    scenario: &RenameErrorScenario,
) {
    let expected_sites = if matches!(layout, RenameErrorLayout::OldOnly) {
        scenario.all_sites.clone()
    } else {
        HashSet::from([scenario.canonical_unrelated_document.clone()])
    };
    assert_eq!(
        scenario.state.html_preview_server.site_documents().unwrap(),
        expected_sites,
        "{layout:?}",
    );
    assert_eq!(
        scenario
            .state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .len(),
        if matches!(layout, RenameErrorLayout::OldOnly) {
            3
        } else {
            1
        },
        "{layout:?}",
    );
}

#[test]
fn rename_os_error_layouts_are_classified_and_reconcile_affected_authority() {
    for layout in [
        RenameErrorLayout::OldOnly,
        RenameErrorLayout::NewOnly,
        RenameErrorLayout::Both,
        RenameErrorLayout::Neither,
    ] {
        let files = create_rename_error_workspace();
        let state = AppState::default();
        let opened = open_directory_inner(&state, files.workspace.path()).unwrap();
        open_rename_error_documents(&state, &files);
        let scenario = canonicalize_rename_error_scenario(files, state, opened.workspace_token);
        assert_rename_error_baseline(layout, &scenario);
        let unrelated_before = capture_unrelated_grant_baseline(&scenario);
        let attempt = attempt_rename_error(layout, &scenario);
        assert_rename_error_attempt(layout, &scenario, &attempt);
        assert_rename_error_lock_order(layout, &attempt);
        assert_rename_error_unrelated_grants(layout, &scenario, unrelated_before);
        assert_rename_error_preview_reconciliation(layout, &scenario);
        let refreshed = refresh_directory_inner(
            &scenario.state,
            &scenario.workspace_token,
            &scenario.canonical_workspace,
        )
        .unwrap();
        assert_eq!(
            refreshed.workspace_token, scenario.workspace_token,
            "{layout:?}"
        );
    }
}
