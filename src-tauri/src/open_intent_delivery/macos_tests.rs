use super::*;
use crate::open_intent::OpenIntentPreviewTarget;
use std::path::PathBuf;
use std::sync::Arc;

#[test]
fn opened_urls_enqueue_before_tauri_state_is_managed() {
    let coordinator = Arc::new(OpenIntentCoordinator::new(2));
    let first_url = tauri::Url::from_file_path("/tmp/opened-first.md").unwrap();
    let second_url = tauri::Url::from_file_path("/tmp/opened-second.md").unwrap();

    let first = enqueue_opened_url(&coordinator, &first_url).unwrap().head();
    let second = enqueue_opened_url(&coordinator, &second_url)
        .unwrap()
        .head();

    assert_eq!(coordinator.peek_head(), Some(first));
    assert!(coordinator.consume_matching_head(first.id()).is_some());
    assert_eq!(coordinator.peek_head(), Some(second));
    assert_eq!(
        coordinator.peek_preview().unwrap().target(),
        &OpenIntentPreviewTarget::CandidatePath(PathBuf::from("/tmp/opened-second.md"))
    );
}

#[test]
fn opened_urls_reject_non_file_schemes_without_mutating_the_queue() {
    let coordinator = OpenIntentCoordinator::default();
    let url = tauri::Url::parse("https://example.com/document.md").unwrap();

    assert_eq!(
        enqueue_opened_url(&coordinator, &url),
        Err(OpenIntentEnqueueError::InvalidCandidatePath)
    );
    assert_eq!(coordinator.peek_head(), None);
}
