use super::*;
use crate::open_intent::{ConsumedOpenIntentTarget, OpenIntentPreviewTarget};
use crate::state::AppState;

fn absolute(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(name)
}

#[test]
fn dropped_paths_enqueue_in_input_order_with_drag_drop_source() {
    let coordinator = OpenIntentCoordinator::new(4);
    let paths = [
        absolute("mmd-drop-first.md"),
        absolute("mmd-drop-second.md"),
    ];

    let outcomes = enqueue_drag_drop_paths(&coordinator, &paths);
    assert!(outcomes
        .iter()
        .all(|outcome| matches!(outcome, Ok(OpenIntentEnqueueOutcome::Enqueued(_)))));

    for expected in paths {
        let head = coordinator.peek_head().unwrap();
        assert_eq!(head.source(), OpenIntentSource::DragDrop);
        let consumed = coordinator.consume_matching_head(head.id()).unwrap();
        assert!(matches!(
            consumed.target(),
            ConsumedOpenIntentTarget::CandidatePath(path) if path == &expected
        ));
    }
    assert!(coordinator.peek_head().is_none());
}

#[test]
fn duplicate_dropped_paths_coalesce_without_reordering_the_queue() {
    let coordinator = OpenIntentCoordinator::new(3);
    let duplicate = absolute("mmd-drop-duplicate.md");
    let trailing = absolute("mmd-drop-trailing.md");

    let outcomes = enqueue_drag_drop_paths(
        &coordinator,
        &[duplicate.clone(), duplicate.clone(), trailing],
    );
    let first = outcomes[0].as_ref().unwrap().head();
    assert_eq!(outcomes[1], Ok(OpenIntentEnqueueOutcome::Coalesced(first)));
    assert_eq!(coordinator.peek_head(), Some(first));
    coordinator.consume_matching_head(first.id()).unwrap();
    assert_eq!(
        coordinator.peek_preview().unwrap().target(),
        &OpenIntentPreviewTarget::CandidatePath(absolute("mmd-drop-trailing.md"))
    );
}

#[test]
fn invalid_dropped_path_is_rejected_without_blocking_later_absolute_paths() {
    let coordinator = OpenIntentCoordinator::new(2);
    let valid = absolute("mmd-drop-valid.md");

    let outcomes = enqueue_drag_drop_paths(
        &coordinator,
        &[std::path::PathBuf::from("relative.md"), valid.clone()],
    );
    assert_eq!(
        outcomes[0],
        Err(OpenIntentEnqueueError::InvalidCandidatePath)
    );
    assert!(matches!(
        outcomes[1],
        Ok(OpenIntentEnqueueOutcome::Enqueued(_))
    ));
    assert_eq!(
        coordinator.peek_preview().unwrap().target(),
        &OpenIntentPreviewTarget::CandidatePath(valid)
    );
}

#[test]
fn dropped_paths_do_not_publish_filesystem_authorization_before_resolution() {
    let coordinator = OpenIntentCoordinator::default();
    let state = AppState::default();
    let before = state.file_authorization().state_fingerprint_for_test();

    let outcomes = enqueue_drag_drop_paths(
        &coordinator,
        &[
            absolute("mmd-drop-unresolved-file.md"),
            absolute("mmd-drop-unresolved-dir"),
        ],
    );

    assert_eq!(outcomes.len(), 2);
    assert_eq!(
        state.file_authorization().state_fingerprint_for_test(),
        before
    );
}

#[test]
fn delivery_focuses_only_active_or_coalesced_requests() {
    let coordinator = OpenIntentCoordinator::default();
    let path = absolute("mmd-focus-delivery.md");
    let enqueued = coordinator.enqueue_path(path.clone(), OpenIntentSource::DragDrop);
    assert_eq!(
        open_intent_delivery_action(enqueued),
        OpenIntentDeliveryAction::Pending
    );

    let coalesced = coordinator.enqueue_path(path, OpenIntentSource::SecondaryInstance);
    assert_eq!(
        open_intent_delivery_action(coalesced),
        OpenIntentDeliveryAction::Focus
    );
    assert_eq!(
        open_intent_delivery_action(Err(OpenIntentEnqueueError::QueueFull)),
        OpenIntentDeliveryAction::FeedbackAndFocus(
            "Too many files are waiting to be opened. Finish the current request and try again."
        )
    );
}
