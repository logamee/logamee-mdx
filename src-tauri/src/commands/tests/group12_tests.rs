use super::fixtures2::*;
use super::group12_helpers::{
    arrange_poisoned_preview_scenario, attempt_poisoning_partial_write,
    PartialSaveAsFileSystemPort, PoisonedPreviewScenario, PoisoningWriteAttempt,
};

fn assert_poisoned_preview_outcome(
    scenario: &PoisonedPreviewScenario,
    attempt: &PoisoningWriteAttempt,
) {
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(&attempt.outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "write",
            "paths": [scenario.canonical_document.to_string_lossy()],
            "recovery_message": "Write may have partially changed the file after an error: Failed to write file: injected partial write failure. Reopen and inspect it before retrying. Authorization suspension also failed: Authorization state is poisoned. All HTML preview sites were stopped.",
        })
    );
    assert_eq!(attempt.filesystem.write_calls.get(), 1);
    assert_eq!(attempt.filesystem.observe_calls.get(), 1);
    assert_eq!(fs::read(&scenario.canonical_document).unwrap(), b"<h1>");
}

fn assert_poisoned_preview_sites_stopped(
    scenario: &PoisonedPreviewScenario,
    attempt: &PoisoningWriteAttempt,
) {
    assert!(scenario
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
    assert!(
        ensure_authorized_write_file_inner(&scenario.state, &scenario.canonical_document).is_err()
    );
    assert_eq!(
        attempt.lock_events,
        [
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
            crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
        ]
    );
}

#[test]
fn authorization_unavailable_after_partial_write_stops_all_preview_sites() {
    let scenario = arrange_poisoned_preview_scenario();
    let attempt = attempt_poisoning_partial_write(&scenario);
    assert_poisoned_preview_outcome(&scenario, &attempt);
    assert_poisoned_preview_sites_stopped(&scenario, &attempt);
}

fn assert_partial_save_as_observation(
    filesystem: &PartialSaveAsFileSystemPort,
    normalized_destination: &Path,
    content: &str,
    outcome: MutationOutcome<WorkspaceMutation, WorkspaceSnapshot>,
) {
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "write",
            "paths": [normalized_destination.to_string_lossy()],
            "recovery_message": "Write may have partially changed the file after an error: Failed to write file: injected partial save-as failure. Reopen and inspect it before retrying.",
        })
    );
    assert_eq!(filesystem.write_calls.get(), 1);
    assert_eq!(filesystem.observe_calls.get(), 1);
    assert_eq!(
        filesystem.observed_path.borrow().as_deref(),
        Some(normalized_destination)
    );
    assert_eq!(
        filesystem.observed_expected_bytes.borrow().as_deref(),
        Some(content.as_bytes())
    );
    assert_eq!(fs::read(normalized_destination).unwrap(), b"<h1>");
}

fn assert_partial_save_as_ungranted(
    state: &AppState,
    normalized_destination: &Path,
    canonical_asset: &Path,
) {
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(normalized_destination)
            .unwrap(),
        None
    );
    assert!(ensure_authorized_write_file_inner(state, normalized_destination).is_err());
    assert!(!is_authorized_image_path(state, canonical_asset).unwrap());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
}

#[test]
fn partial_save_as_is_indeterminate_and_ungranted() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("saved.html");
    let asset = directory.path().join("asset.png");
    fs::write(&asset, b"png").unwrap();
    let canonical_directory = directory.path().canonicalize().unwrap();
    let normalized_destination = canonical_directory.join("saved.html");
    let canonical_asset = asset.canonicalize().unwrap();
    let content = "<h1>saved</h1>";

    let state = AppState::default();
    let filesystem = PartialSaveAsFileSystemPort {
        write_calls: Cell::new(0),
        observe_calls: Cell::new(0),
        observed_path: RefCell::new(None),
        observed_expected_bytes: RefCell::new(None),
    };

    let outcome = save_as_with_ports_inner(&state, &destination, content, &filesystem)
        .expect("post-call save-as errors must be returned as mutation outcomes");

    assert_partial_save_as_observation(&filesystem, &normalized_destination, content, outcome);
    assert_partial_save_as_ungranted(&state, &normalized_destination, &canonical_asset);
}
#[test]
fn save_as_grant_publication_failure_is_indeterminate_and_ungranted() {
    use serde_json::json;

    let directory = tempdir().unwrap();
    let destination = directory.path().join("saved.html");
    let normalized_destination = directory.path().canonicalize().unwrap().join("saved.html");
    let content = "<h1>saved</h1>";
    let state = AppState::default();
    state
        .file_authorization()
        .fail_next_save_publish("injected save grant publication failure")
        .unwrap();

    let outcome = save_as_with_ports_inner(&state, &destination, content, &SystemFileSystemPort)
        .expect("post-write grant publication failures must be mutation outcomes");

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "indeterminate",
            "operation": "write",
            "paths": [normalized_destination.to_string_lossy()],
            "recovery_message": "File contents were written, but save-as authorization could not be committed: injected save grant publication failure. Reopen and inspect the file before retrying.",
        }),
    );
    assert_eq!(
        fs::read_to_string(&normalized_destination).unwrap(),
        content
    );
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&normalized_destination)
            .unwrap(),
        None,
    );
    assert!(ensure_authorized_write_file_inner(&state, &normalized_destination).is_err());
    assert!(state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    assert!(state
        .html_preview_server
        .site_documents()
        .unwrap()
        .is_empty());
}
