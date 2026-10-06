use std::{ffi::OsString, path::PathBuf, sync::Arc, thread};

use super::*;

pub(crate) fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

pub(crate) fn work_root() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\work")
    } else {
        PathBuf::from("/work")
    }
}

#[test]
fn queue_is_fifo_and_only_consumes_the_matching_head() {
    let coordinator = OpenIntentCoordinator::new(2);
    let first = coordinator
        .enqueue_args(
            args(&["mmd", "one.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();
    let second = coordinator
        .enqueue_args(
            args(&["mmd", "two.md"]),
            &work_root(),
            OpenIntentSource::SecondaryInstance,
        )
        .unwrap()
        .head();

    assert_eq!(coordinator.peek_head(), Some(first));
    assert_preview_matches_first_queued_intent(&coordinator, &first);
    assert_eq!(first.source(), OpenIntentSource::StartupArguments);
    assert!(!coordinator.discard_matching_head(second.id()));
    let consumed = coordinator.consume_matching_head(first.id()).unwrap();
    assert_consumed_intent_matches_first_queued_intent(&consumed, &first);
    assert_eq!(coordinator.peek_head(), Some(second));
}

fn assert_preview_matches_first_queued_intent(
    coordinator: &OpenIntentCoordinator,
    first: &OpenIntentHead,
) {
    let preview = coordinator.peek_preview().unwrap();
    assert_eq!(preview.id(), first.id());
    assert_eq!(preview.source(), OpenIntentSource::StartupArguments);
    assert_eq!(
        preview.target(),
        &OpenIntentPreviewTarget::CandidatePath(work_root().join("one.md"))
    );
}

fn assert_consumed_intent_matches_first_queued_intent(
    consumed: &ConsumedOpenIntent,
    first: &OpenIntentHead,
) {
    assert_eq!(consumed.id(), first.id());
    assert_eq!(consumed.source(), OpenIntentSource::StartupArguments);
    assert!(matches!(
        consumed.target(),
        ConsumedOpenIntentTarget::CandidatePath(path) if path == &work_root().join("one.md")
    ));
}

#[test]
fn opaque_session_restore_waits_behind_startup_arguments_without_a_path_payload() {
    let coordinator = OpenIntentCoordinator::new(2);
    let startup = coordinator
        .enqueue_args(
            args(&["mmd", "startup.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();
    let restore = coordinator.enqueue_session_restore().unwrap().head();

    assert_eq!(coordinator.peek_head(), Some(startup));
    let startup = coordinator.consume_matching_head(startup.id()).unwrap();
    assert!(matches!(
        startup.target(),
        ConsumedOpenIntentTarget::CandidatePath(path) if path == &work_root().join("startup.md")
    ));
    assert_eq!(coordinator.peek_head(), Some(restore));
    let preview = coordinator.peek_preview().unwrap();
    assert_eq!(preview.source(), OpenIntentSource::SessionRestore);
    assert_eq!(preview.target(), &OpenIntentPreviewTarget::SessionRestore);
    let restore = coordinator.consume_matching_head(restore.id()).unwrap();
    assert!(matches!(
        restore.target(),
        ConsumedOpenIntentTarget::SessionRestore
    ));
}

#[test]
fn coordinator_remembers_an_explicit_open_request_after_the_intent_is_consumed() {
    let coordinator = OpenIntentCoordinator::default();
    let startup = coordinator
        .enqueue_args(
            args(&["mmd", "startup.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();

    assert!(coordinator.has_explicit_open_request());
    coordinator.consume_matching_head(startup.id());
    assert!(coordinator.has_explicit_open_request());
}

#[test]
fn coordinator_treats_an_opened_event_as_an_explicit_open_request() {
    let coordinator = OpenIntentCoordinator::default();
    let opened = coordinator
        .enqueue_path(work_root().join("opened.md"), OpenIntentSource::OpenedEvent)
        .unwrap()
        .head();

    assert!(coordinator.has_explicit_open_request());
    coordinator.consume_matching_head(opened.id());
    assert!(coordinator.has_explicit_open_request());
}

#[test]
fn coordinator_treats_secondary_instance_and_drag_drop_as_explicit_opens() {
    for source in [
        OpenIntentSource::SecondaryInstance,
        OpenIntentSource::DragDrop,
    ] {
        let coordinator = OpenIntentCoordinator::default();
        let intent = coordinator
            .enqueue_path(work_root().join("explicit.md"), source)
            .unwrap()
            .head();

        assert!(coordinator.has_explicit_open_request());
        coordinator.consume_matching_head(intent.id());
        assert!(coordinator.has_explicit_open_request());
    }
}

#[test]
fn session_restore_coalesces_without_displacing_other_pending_requests() {
    let coordinator = OpenIntentCoordinator::new(3);
    let startup = coordinator
        .enqueue_args(
            args(&["mmd", "startup.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();
    let restore = coordinator.enqueue_session_restore().unwrap().head();

    assert_eq!(
        coordinator.enqueue_session_restore(),
        Ok(OpenIntentEnqueueOutcome::Coalesced(restore))
    );
    assert_eq!(coordinator.peek_head(), Some(startup));
}

#[test]
fn opened_file_urls_enqueue_only_absolute_candidates() {
    let coordinator = OpenIntentCoordinator::new(2);
    let preview = coordinator
        .enqueue_path(work_root().join("opened.md"), OpenIntentSource::OpenedEvent)
        .unwrap()
        .head();
    assert_eq!(coordinator.peek_head(), Some(preview));
    assert_eq!(
        coordinator.enqueue_path(PathBuf::from("relative.md"), OpenIntentSource::OpenedEvent,),
        Err(OpenIntentEnqueueError::InvalidCandidatePath)
    );
}

#[test]
fn pending_duplicate_targets_coalesce_across_delivery_sources() {
    let coordinator = OpenIntentCoordinator::new(3);
    let first = coordinator
        .enqueue_args(
            args(&["mmd", "same.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();
    let duplicate = coordinator
        .enqueue_args(
            args(&["mmd", "./same.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap();
    assert_eq!(duplicate, OpenIntentEnqueueOutcome::Coalesced(first));

    let other_source = coordinator
        .enqueue_args(
            args(&["mmd", "same.md"]),
            &work_root(),
            OpenIntentSource::SecondaryInstance,
        )
        .unwrap();
    assert_eq!(other_source, OpenIntentEnqueueOutcome::Coalesced(first));
}

#[test]
fn queue_is_bounded_without_evicting_pending_intents() {
    let coordinator = OpenIntentCoordinator::new(1);
    let first = coordinator
        .enqueue_args(
            args(&["mmd", "one.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments,
        )
        .unwrap()
        .head();
    assert_eq!(
        coordinator.enqueue_args(
            args(&["mmd", "two.md"]),
            &work_root(),
            OpenIntentSource::StartupArguments
        ),
        Err(OpenIntentEnqueueError::QueueFull)
    );
    assert_eq!(coordinator.peek_head(), Some(first));
}

#[test]
fn concurrent_enqueue_keeps_every_distinct_intent() {
    let coordinator = Arc::new(OpenIntentCoordinator::new(16));
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.enqueue_args(
                    vec![OsString::from("mmd"), OsString::from(format!("{index}.md"))],
                    &work_root(),
                    OpenIntentSource::SecondaryInstance,
                )
            })
        })
        .collect();

    for worker in workers {
        assert!(matches!(
            worker.join().unwrap(),
            Ok(OpenIntentEnqueueOutcome::Enqueued(_))
        ));
    }
    let mut consumed = 0;
    while let Some(head) = coordinator.peek_head() {
        assert!(coordinator.consume_matching_head(head.id()).is_some());
        consumed += 1;
    }
    assert_eq!(consumed, 8);
}
