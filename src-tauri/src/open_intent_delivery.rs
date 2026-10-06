//! Delivery of open intents into the coordinator from startup, single
//! instance, drag-drop and opened-URL events.
use tauri::Emitter;

use crate::commands::emit_app_feedback_error;
use crate::open_intent_commands::{OPEN_INTENT_FOCUS_EVENT, OPEN_INTENT_PENDING_EVENT};
use crate::open_intent::{
    OpenIntentCoordinator, OpenIntentEnqueueError, OpenIntentEnqueueOutcome,
    OpenIntentParseError, OpenIntentSource,
};

pub(crate) fn open_intent_error_message(error: OpenIntentEnqueueError) -> &'static str {
    match error {
        OpenIntentEnqueueError::Parse(OpenIntentParseError::MissingTarget) => {
            "No file or directory was supplied to mdx."
        }
        OpenIntentEnqueueError::Parse(OpenIntentParseError::MultipleTargets) => {
            "mdx can open one file or directory per launch request."
        }
        OpenIntentEnqueueError::Parse(OpenIntentParseError::UnexpectedOption) => {
            "This mdx command-line option is not supported."
        }
        OpenIntentEnqueueError::Parse(OpenIntentParseError::InvalidWorkingDirectory)
        | OpenIntentEnqueueError::InvalidCandidatePath => {
            "The launch request did not include a valid working directory."
        }
        OpenIntentEnqueueError::Parse(OpenIntentParseError::EmptyTarget) => {
            "The launch request contained an empty path."
        }
        OpenIntentEnqueueError::QueueFull => {
            "Too many files are waiting to be opened. Finish the current request and try again."
        }
    }
}

pub(crate) fn publish_open_intent_result(
    app: &tauri::AppHandle,
    _coordinator: &OpenIntentCoordinator,
    result: Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>,
) {
    #[cfg(feature = "packaged-lifecycle-e2e")]
    crate::packaged_open_e2e::observe_enqueue(_coordinator, &result);
    deliver_open_intent_result(app, result);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenIntentDeliveryAction {
    Pending,
    Focus,
    FeedbackAndFocus(&'static str),
}

pub(crate) fn open_intent_delivery_action(
    result: Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>,
) -> OpenIntentDeliveryAction {
    match result {
        Ok(OpenIntentEnqueueOutcome::Enqueued(_)) => OpenIntentDeliveryAction::Pending,
        Ok(OpenIntentEnqueueOutcome::Coalesced(_)) => OpenIntentDeliveryAction::Focus,
        Err(error) => OpenIntentDeliveryAction::FeedbackAndFocus(open_intent_error_message(error)),
    }
}

pub(crate) fn deliver_open_intent_result(
    app: &tauri::AppHandle,
    result: Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>,
) {
    match open_intent_delivery_action(result) {
        OpenIntentDeliveryAction::Pending => {
            let _ = app.emit_to("main", OPEN_INTENT_PENDING_EVENT, ());
        }
        OpenIntentDeliveryAction::Focus => {
            let _ = app.emit_to("main", OPEN_INTENT_FOCUS_EVENT, ());
        }
        OpenIntentDeliveryAction::FeedbackAndFocus(message) => {
            emit_app_feedback_error(app, message);
            let _ = app.emit_to("main", OPEN_INTENT_FOCUS_EVENT, ());
        }
    }
}

pub(crate) fn enqueue_startup_open_intent(
    coordinator: &OpenIntentCoordinator,
) -> Option<Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() <= 1 {
        return None;
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(_) => {
            return Some(Err(OpenIntentEnqueueError::Parse(
                OpenIntentParseError::InvalidWorkingDirectory,
            )))
        }
    };
    Some(coordinator.enqueue_args(args, &cwd, OpenIntentSource::StartupArguments))
}

pub(crate) fn enqueue_drag_drop_paths(
    coordinator: &OpenIntentCoordinator,
    paths: &[std::path::PathBuf],
) -> Vec<Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>> {
    paths
        .iter()
        .map(|path| coordinator.enqueue_path(path.clone(), OpenIntentSource::DragDrop))
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) fn enqueue_opened_url(
    coordinator: &OpenIntentCoordinator,
    url: &tauri::Url,
) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError> {
    url.to_file_path()
        .map_err(|_| OpenIntentEnqueueError::InvalidCandidatePath)
        .and_then(|path| coordinator.enqueue_path(path, OpenIntentSource::OpenedEvent))
}

#[cfg(test)]
mod drag_drop_tests;
#[cfg(all(test, target_os = "macos"))]
mod macos_tests;
