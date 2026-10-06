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
mod private_fs;
mod recent_files;
mod resource_store;
mod settings;
mod state;
mod workspace_copy;
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
    cancel_document_overwrite_token, clear_recent_files, commit_recent_open, copy_workspace_entry,
    create_workspace_directory, create_workspace_file, delete_workspace_entry,
    discard_open_receipt, get_open_commit_status, get_settings, issue_document_overwrite_token,
    move_workspace_entry, open_directory_dialog, open_file_dialog,
    open_file_parent_directory, open_recent_file, open_workspace_file, persist_workspace_session,
    prepare_markdown_media_preview, prepare_workspace_media_preview, read_file,
    read_markdown_excalidraw, read_workspace_image, refresh_directory, release_media_preview,
    rename_workspace_entry, reset_settings, resolve_markdown_image,
    resolve_markdown_media, resolve_workspace_media, retry_document_save_with_token,
    reveal_workspace_entry, save_as_dialog, set_native_locale_preference,
    set_native_save_menu_enabled, set_native_theme_preference, update_settings, write_file,
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
    OpenIntentCoordinator,
    OpenIntentSource,
};
use open_intent_commands::{
    discard_open_intent, focus_main_window, peek_open_intent, request_session_restore,
    resolve_open_intent, settle_open_intent_workspace,
};
#[cfg(feature = "packaged-lifecycle-e2e")]
use packaged_lifecycle_e2e::setup_packaged_lifecycle_e2e;
#[cfg(feature = "packaged-lifecycle-e2e")]
use packaged_open_e2e::{get_packaged_open_e2e_config, record_packaged_open_app_event};
use resource_store::{
    authorize_resource_directory_dialog, pick_media_resources, write_excalidraw_asset_pair,
    write_workspace_resource,
};
use state::AppState;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use workspace_index_commands::{
    cancel_workspace_index_operation, discard_workspace_index, open_workspace_index_result,
    query_workspace_index, rebuild_workspace_index,
};

#[macro_use]
mod invoke_registry;

mod open_intent_delivery;

use open_intent_delivery::{
    deliver_open_intent_result, enqueue_drag_drop_paths, enqueue_startup_open_intent,
    publish_open_intent_result,
};
#[cfg(target_os = "macos")]
use open_intent_delivery::enqueue_opened_url;

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
            handle_single_instance(app, &single_instance_open_intents, args, &cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let state = setup_app(app, startup_open_intent)?;
            app.manage(state);
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, &event))
        .on_window_event(move |window, event| {
            handle_window_event(window, event, &drag_drop_open_intents)
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
            handle_opened_event(app, urls, &opened_event_open_intents);
        }
        if matches!(event, RunEvent::Exit) {
            handle_run_exit(app);
        }
    });
}

fn handle_single_instance(
    app: &tauri::AppHandle,
    open_intents: &OpenIntentCoordinator,
    args: Vec<String>,
    cwd: &str,
) {
    publish_open_intent_result(
        app,
        open_intents,
        open_intents.enqueue_args(args, Path::new(cwd), OpenIntentSource::SecondaryInstance),
    );
}

fn setup_app(
    app: &mut tauri::App,
    startup_open_intent: Option<
        Result<
            open_intent::OpenIntentEnqueueOutcome,
            open_intent::OpenIntentEnqueueError,
        >,
    >,
) -> Result<AppState, Box<dyn std::error::Error>> {
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
    if let Some(result) = startup_open_intent {
        deliver_open_intent_result(app.handle(), result);
    }
    let recent_files = state.recent_files()?.list()?;
    state.set_native_recent_files(recent_files);
    app.set_menu(native_menu::build_app_menu(
        app.handle(),
        &state.native_menu_state(),
    )?)?;
    Ok(state)
}

fn handle_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
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
}

fn handle_window_event(
    window: &tauri::Window,
    event: &WindowEvent,
    drag_drop_open_intents: &OpenIntentCoordinator,
) {
    if window.label() == "main" {
        if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            for result in enqueue_drag_drop_paths(drag_drop_open_intents, paths) {
                publish_open_intent_result(
                    window.app_handle(),
                    drag_drop_open_intents,
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
}

#[cfg(target_os = "macos")]
fn handle_opened_event(
    app: &tauri::AppHandle,
    urls: &[tauri::Url],
    opened_event_open_intents: &OpenIntentCoordinator,
) {
    for url in urls {
        let result = enqueue_opened_url(opened_event_open_intents, url);
        publish_open_intent_result(app, opened_event_open_intents, result);
    }
}

fn handle_run_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.active_document_watch().stop_all();
    state.workspace_index().discard_all();
    if let Ok(recent_files) = state.recent_files() {
        let _ = recent_files.shutdown();
    }
}
