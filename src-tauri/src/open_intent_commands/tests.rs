use std::{ffi::OsString, fs, path::Path};
use tempfile::tempdir;
use crate::open_intent::{
    OpenIntentCoordinator, OpenIntentSource, DEFAULT_OPEN_INTENT_CAPACITY,
};
use super::*;
pub(crate) fn enqueue(coordinator: &OpenIntentCoordinator, target: &Path) -> String {
    let cwd = target.parent().unwrap();
    coordinator
        .enqueue_args(
            [OsString::from("mmd"), target.as_os_str().to_os_string()],
            cwd,
            OpenIntentSource::StartupArguments,
        )
        .unwrap();
    peek_open_intent_inner(coordinator).unwrap().id
}

#[test]
fn preview_is_non_consuming_and_contains_only_display_metadata() {
    let directory = tempdir().unwrap();
    let file = directory.path().join("draft.md");
    fs::write(&file, "draft").unwrap();
    let coordinator = OpenIntentCoordinator::new(DEFAULT_OPEN_INTENT_CAPACITY);
    let id = enqueue(&coordinator, &file);

    let first = peek_open_intent_inner(&coordinator).unwrap();
    let second = peek_open_intent_inner(&coordinator).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.id, id);
    assert_eq!(first.display_path, file.to_string_lossy());
    assert_eq!(first.source, "startup_args");
    assert_eq!(first.target_kind, "file");
}

#[test]
fn preview_classifies_directories_and_keeps_missing_targets_untrusted() {
    let directory = tempdir().unwrap();
    let coordinator = OpenIntentCoordinator::default();
    let directory_id = enqueue(&coordinator, directory.path());

    let preview = peek_open_intent_inner(&coordinator).unwrap();
    assert_eq!(preview.id, directory_id);
    assert_eq!(preview.target_kind, "directory");
    assert!(discard_open_intent_inner(&coordinator, "main", &directory_id).unwrap());

    let missing = directory.path().join("missing.md");
    let missing_id = enqueue(&coordinator, &missing);
    let preview = peek_open_intent_inner(&coordinator).unwrap();
    assert_eq!(preview.id, missing_id);
    assert_eq!(preview.target_kind, "unknown");
}

#[test]
fn drag_drop_preview_uses_the_backend_source_wire_value() {
    let coordinator = OpenIntentCoordinator::default();
    let path = tempdir().unwrap().path().join("dropped.md");
    coordinator
        .enqueue_path(path, OpenIntentSource::DragDrop)
        .unwrap();

    assert_eq!(
        peek_open_intent_inner(&coordinator).unwrap().source,
        "drag_drop"
    );
}

#[test]
fn session_restore_preview_is_opaque_and_carries_no_persisted_path() {
    let coordinator = OpenIntentCoordinator::default();
    let id = coordinator.enqueue_session_restore().unwrap().head().id();

    let preview = peek_open_intent_inner(&coordinator).unwrap();
    assert_eq!(preview.id, id.to_wire());
    assert_eq!(preview.source, "session_restore");
    assert_eq!(preview.display_path, "Restore previous workspace");
    assert_eq!(preview.target_kind, "session_restore");
}

#[test]
fn main_app_restore_request_is_skipped_after_an_existing_native_open() {
    let coordinator = OpenIntentCoordinator::default();
    let directory = tempdir().unwrap();
    let association = directory.path().join("association.md");
    coordinator
        .enqueue_path(association, OpenIntentSource::OpenedEvent)
        .unwrap();

    assert!(!request_session_restore_inner(&coordinator, "main").unwrap());

    assert_eq!(
        peek_open_intent_inner(&coordinator).unwrap().source,
        "opened_event"
    );
    coordinator.consume_matching_head(
        coordinator
            .peek_head()
            .expect("opened intent remains queued")
            .id(),
    );
    assert!(peek_open_intent_inner(&coordinator).is_none());
}

#[test]
fn main_app_restore_request_is_skipped_after_a_startup_argument() {
    let coordinator = OpenIntentCoordinator::default();
    let directory = tempdir().unwrap();
    let startup = directory.path().join("startup.md");
    coordinator
        .enqueue_path(startup, OpenIntentSource::StartupArguments)
        .unwrap();

    assert!(!request_session_restore_inner(&coordinator, "main").unwrap());
    assert_eq!(
        peek_open_intent_inner(&coordinator).unwrap().source,
        "startup_args"
    );
    coordinator.consume_matching_head(
        coordinator
            .peek_head()
            .expect("startup intent remains queued")
            .id(),
    );
    assert!(peek_open_intent_inner(&coordinator).is_none());
}

#[test]
fn session_restore_resolution_is_a_noop_after_a_late_explicit_open() {
    let coordinator = OpenIntentCoordinator::default();
    // The restore request was issued before any explicit open arrived.
    coordinator.enqueue_session_restore().unwrap();
    // A late explicit open (macOS Opened event) then arrives after the request.
    let directory = tempdir().unwrap();
    coordinator
        .enqueue_path(directory.path().join("opened.md"), OpenIntentSource::OpenedEvent)
        .unwrap();

    let resolved =
        resolve_session_restore_response(&coordinator, &AppState::default(), "main").unwrap();

    let ResolvedOpenIntentResponse::SessionRestore {
        restore,
        workspace_open_receipt,
    } = resolved
    else {
        panic!("expected a session restore response");
    };
    assert!(restore.is_none());
    assert!(workspace_open_receipt.is_none());
}

#[test]
fn packaged_open_harness_keeps_restore_challenge_with_startup_arguments() {
    assert!(!should_skip_session_restore(false, false));
    assert!(!should_skip_session_restore(true, true));
    assert!(should_skip_session_restore(true, false));
}

#[test]
fn popout_restore_request_is_rejected_without_enqueuing() {
    let coordinator = OpenIntentCoordinator::default();

    assert!(request_session_restore_inner(&coordinator, "mmd-editor-popout").is_err());
    assert!(peek_open_intent_inner(&coordinator).is_none());
}

#[test]
fn session_restore_only_resolves_after_earlier_open_request_is_consumed() {
    let coordinator = OpenIntentCoordinator::default();
    let directory = tempdir().unwrap();
    let file = directory.path().join("startup.md");
    fs::write(&file, "startup").unwrap();
    let startup_id = enqueue(&coordinator, &file);
    let restore_id = coordinator
        .enqueue_session_restore()
        .unwrap()
        .head()
        .id()
        .to_wire();

    let result = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &restore_id,
        |_| Ok(()),
        |_| Ok(()),
    );
    assert!(result.is_err());

    let _ = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &startup_id,
        |_| Ok(()),
        |_| Ok(()),
    )
    .unwrap();
    let resolved = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &restore_id,
        |_| Ok(()),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(resolved, ResolvedOpenIntentInner::SessionRestore);
}
