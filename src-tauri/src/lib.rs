mod active_document_watch;
mod commands;
mod crash_draft_commands;
mod crash_draft_store;
mod crash_drafts;
mod document_save;
mod docx_preflight;
mod durable_write;
mod excalidraw_scene;
mod export_store;
mod html_preview_server;
mod image_resolver;
mod markdown_files;
mod models;
mod native_menu;
mod open_intent;
mod open_intent_commands;
#[cfg(feature = "packaged-lifecycle-e2e")]
mod packaged_lifecycle_e2e;
#[cfg(feature = "packaged-lifecycle-e2e")]
mod packaged_open_e2e;
mod path_auth;
mod recent_files;
mod resource_store;
mod settings;
mod state;
mod workspace_file_kind;
pub mod workspace_index;
mod workspace_index_commands;
mod workspace_index_runtime;
mod workspace_session;
mod workspace_trash;
mod workspace_trash_native;

pub(crate) use path_auth::workspace_snapshot;

use std::{path::Path, sync::Arc};

use active_document_watch::{
    activate_active_document_watch, reconcile_active_document_watch, start_active_document_watch,
    stop_active_document_watch,
};
use commands::{
    cancel_document_overwrite_token, clear_recent_files, commit_recent_open,
    create_workspace_directory, create_workspace_file, delete_workspace_entry,
    discard_open_receipt, get_open_commit_status, get_settings, issue_document_overwrite_token,
    list_recent_files, move_workspace_entry, open_directory_dialog, open_file_dialog,
    open_file_parent_directory, open_recent_file, open_workspace_file, persist_workspace_session,
    prepare_markdown_media_preview, prepare_workspace_media_preview, read_file,
    read_markdown_excalidraw, read_workspace_image, refresh_directory, release_media_preview,
    remove_recent_file, rename_workspace_entry, reset_settings, resolve_markdown_image,
    resolve_markdown_media, resolve_workspace_media, retry_document_save_with_token,
    save_as_dialog, set_native_locale_preference, set_native_save_menu_enabled,
    set_native_theme_preference, update_settings, write_file,
};
use crash_draft_commands::{
    discard_crash_draft, list_crash_drafts, recover_crash_draft, reset_crash_draft_overflow_batch,
    reset_crash_drafts, write_crash_draft,
};
use export_store::{save_excalidraw_bundle_dialog, save_export_dialog};
use html_preview_server::{
    prepare_html_preview, prepare_markdown_html_embed, release_markdown_html_embed,
    release_markdown_html_embed_window_inner,
};
use open_intent::{
    OpenIntentCoordinator, OpenIntentEnqueueError, OpenIntentEnqueueOutcome, OpenIntentParseError,
    OpenIntentSource,
};
use open_intent_commands::{
    discard_open_intent, focus_main_window, peek_open_intent, request_session_restore,
    resolve_open_intent, settle_open_intent_workspace, OPEN_INTENT_FOCUS_EVENT,
    OPEN_INTENT_PENDING_EVENT,
};
#[cfg(feature = "packaged-lifecycle-e2e")]
use packaged_lifecycle_e2e::setup_packaged_lifecycle_e2e;
#[cfg(feature = "packaged-lifecycle-e2e")]
use packaged_open_e2e::{get_packaged_open_e2e_config, record_packaged_open_app_event};
use resource_store::{
    authorize_resource_directory_dialog, write_excalidraw_asset_pair, write_workspace_resource,
};
use state::AppState;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use workspace_index_commands::{
    cancel_workspace_index_operation, discard_workspace_index, open_workspace_index_result,
    query_workspace_index, rebuild_workspace_index,
};

macro_rules! app_invoke_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            open_file_dialog,
            open_workspace_file,
            list_recent_files,
            open_recent_file,
            commit_recent_open,
            get_open_commit_status,
            discard_open_receipt,
            remove_recent_file,
            clear_recent_files,
            get_settings,
            update_settings,
            reset_settings,
            set_native_save_menu_enabled,
            set_native_theme_preference,
            set_native_locale_preference,
            read_file,
            write_file,
            issue_document_overwrite_token,
            retry_document_save_with_token,
            cancel_document_overwrite_token,
            save_as_dialog,
            open_directory_dialog,
            open_file_parent_directory,
            persist_workspace_session,
            refresh_directory,
            create_workspace_file,
            create_workspace_directory,
            rename_workspace_entry,
            move_workspace_entry,
            delete_workspace_entry,
            resolve_markdown_image,
            resolve_markdown_media,
            prepare_workspace_media_preview,
            prepare_markdown_media_preview,
            release_media_preview,
            read_markdown_excalidraw,
            read_workspace_image,
            resolve_workspace_media,
            prepare_html_preview,
            prepare_markdown_html_embed,
            release_markdown_html_embed,
            start_active_document_watch,
            activate_active_document_watch,
            reconcile_active_document_watch,
            stop_active_document_watch,
            list_crash_drafts,
            write_crash_draft,
            recover_crash_draft,
            discard_crash_draft,
            reset_crash_drafts,
            reset_crash_draft_overflow_batch,
            peek_open_intent,
            request_session_restore,
            resolve_open_intent,
            discard_open_intent,
            focus_main_window,
            settle_open_intent_workspace,
            rebuild_workspace_index,
            query_workspace_index,
            discard_workspace_index,
            cancel_workspace_index_operation,
            open_workspace_index_result,
            authorize_resource_directory_dialog,
            write_excalidraw_asset_pair,
            write_workspace_resource
            ,save_export_dialog
            ,save_excalidraw_bundle_dialog
            $(, $extra)*
        ]
    };
}

fn open_intent_error_message(error: OpenIntentEnqueueError) -> &'static str {
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

fn publish_open_intent_result(
    app: &tauri::AppHandle,
    _coordinator: &OpenIntentCoordinator,
    result: Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>,
) {
    #[cfg(feature = "packaged-lifecycle-e2e")]
    packaged_open_e2e::observe_enqueue(_coordinator, &result);
    deliver_open_intent_result(app, result);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenIntentDeliveryAction {
    Pending,
    Focus,
    FeedbackAndFocus(&'static str),
}

fn open_intent_delivery_action(
    result: Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>,
) -> OpenIntentDeliveryAction {
    match result {
        Ok(OpenIntentEnqueueOutcome::Enqueued(_)) => OpenIntentDeliveryAction::Pending,
        Ok(OpenIntentEnqueueOutcome::Coalesced(_)) => OpenIntentDeliveryAction::Focus,
        Err(error) => OpenIntentDeliveryAction::FeedbackAndFocus(open_intent_error_message(error)),
    }
}

fn deliver_open_intent_result(
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
            commands::emit_app_feedback_error(app, message);
            let _ = app.emit_to("main", OPEN_INTENT_FOCUS_EVENT, ());
        }
    }
}

fn enqueue_startup_open_intent(
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

fn enqueue_drag_drop_paths(
    coordinator: &OpenIntentCoordinator,
    paths: &[std::path::PathBuf],
) -> Vec<Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError>> {
    paths
        .iter()
        .map(|path| coordinator.enqueue_path(path.clone(), OpenIntentSource::DragDrop))
        .collect()
}

#[cfg(target_os = "macos")]
fn enqueue_opened_url(
    coordinator: &OpenIntentCoordinator,
    url: &tauri::Url,
) -> Result<OpenIntentEnqueueOutcome, OpenIntentEnqueueError> {
    url.to_file_path()
        .map_err(|_| OpenIntentEnqueueError::InvalidCandidatePath)
        .and_then(|path| coordinator.enqueue_path(path, OpenIntentSource::OpenedEvent))
}

pub fn run() {
    #[cfg(feature = "packaged-lifecycle-e2e")]
    packaged_open_e2e::initialize();
    let open_intents = Arc::new(OpenIntentCoordinator::default());
    let startup_open_intent = enqueue_startup_open_intent(&open_intents);
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if let Some(result) = startup_open_intent.as_ref() {
        // Establish the primary receipt before macOS can deliver an Opened event ahead of setup.
        packaged_open_e2e::observe_enqueue(&open_intents, result);
    }
    let single_instance_open_intents = Arc::clone(&open_intents);
    let managed_open_intents = Arc::clone(&open_intents);
    let drag_drop_open_intents = Arc::clone(&open_intents);
    #[cfg(target_os = "macos")]
    let opened_event_open_intents = Arc::clone(&open_intents);
    let app = tauri::Builder::default()
        .manage(managed_open_intents)
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| {
            publish_open_intent_result(
                app,
                &single_instance_open_intents,
                single_instance_open_intents.enqueue_args(
                    args,
                    Path::new(&cwd),
                    OpenIntentSource::SecondaryInstance,
                ),
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let state = AppState::default();
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Cannot locate application data: {error}"))?;
            state
                .initialize_recent_files(app_data_dir.clone())
                .map_err(|error| format!("Cannot initialize recent files: {error}"))?;
            state
                .initialize_settings(app_data_dir.clone())
                .map_err(|error| format!("Cannot initialize settings: {error}"))?;
            state
                .initialize_workspace_session(app_data_dir.clone())
                .map_err(|error| format!("Cannot initialize workspace session: {error}"))?;
            state
                .initialize_crash_drafts(app_data_dir)
                .map_err(|error| format!("Cannot initialize crash recovery: {error}"))?;
            let settings_store = state.settings().map_err(|error| {
                format!(
                    "Cannot access settings for native shortcuts: {}",
                    error.message
                )
            })?;
            if let Ok(settings) = settings_store.load_or_create() {
                state.set_native_shortcuts(settings.settings.shortcuts);
            }
            app.manage(state);
            if let Some(result) = startup_open_intent {
                deliver_open_intent_result(app.handle(), result);
            }
            let recent_files = app.state::<AppState>().recent_files()?.list()?;
            app.state::<AppState>()
                .set_native_recent_files(recent_files);
            app.set_menu(native_menu::build_app_menu(
                app.handle(),
                &app.state::<AppState>().native_menu_state(),
            )?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(route) = native_menu::route_for_menu_id(event.id().as_ref()) else {
                return;
            };
            let target = match route {
                native_menu::MenuRoute::MainFile
                | native_menu::MenuRoute::MainThemeAuthority
                | native_menu::MenuRoute::MainLocaleAuthority => "main",
            };
            if let (Some(action), Some(window)) = (
                native_menu::action_for_menu_id(event.id().as_ref()),
                app.get_webview_window(target),
            ) {
                let _ = window.emit(native_menu::NATIVE_MENU_EVENT, action);
            }
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                    for result in enqueue_drag_drop_paths(&drag_drop_open_intents, paths) {
                        publish_open_intent_result(
                            window.app_handle(),
                            &drag_drop_open_intents,
                            result,
                        );
                    }
                }
            }
            if matches!(event, WindowEvent::Destroyed) {
                let state = window.app_handle().state::<AppState>();
                if window.label() == "main" {
                    state.active_document_watch().stop_all();
                }
                if let Ok(recent_files) = state.recent_files() {
                    let _ = recent_files.remove_owner(window.label());
                }
                let _ = release_markdown_html_embed_window_inner(&state, window.label());
            }
        });
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let app = app.invoke_handler(app_invoke_handler!(
        setup_packaged_lifecycle_e2e,
        get_packaged_open_e2e_config,
        record_packaged_open_app_event,
    ));
    #[cfg(not(feature = "packaged-lifecycle-e2e"))]
    let app = app.invoke_handler(app_invoke_handler!());
    let app = app
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(move |app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            for url in urls {
                let result = enqueue_opened_url(&opened_event_open_intents, url);
                publish_open_intent_result(app, &opened_event_open_intents, result);
            }
        }
        if matches!(event, RunEvent::Exit) {
            let state = app.state::<AppState>();
            state.active_document_watch().stop_all();
            state.workspace_index().discard_all();
            if let Ok(recent_files) = state.recent_files() {
                let _ = recent_files.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod drag_drop_tests {
    use super::*;
    use crate::open_intent::{ConsumedOpenIntentTarget, OpenIntentPreviewTarget};

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
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::open_intent::OpenIntentPreviewTarget;
    use std::path::PathBuf;

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
}
