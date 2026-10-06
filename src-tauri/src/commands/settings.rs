use tauri::{AppHandle, Emitter, State};

use crate::models::{Settings, SettingsEnvelope, SettingsError};
use crate::native_menu;
use crate::state::AppState;

pub(crate) const SETTINGS_CHANGED_EVENT: &str = "mmd:settings-changed";

fn get_settings_inner(state: &AppState) -> Result<SettingsEnvelope, SettingsError> {
    state.settings()?.load_or_create()
}

fn update_settings_inner(
    state: &AppState,
    expected_revision: u64,
    settings: Settings,
) -> Result<SettingsEnvelope, SettingsError> {
    state.settings()?.update(expected_revision, settings)
}

fn reset_settings_inner(
    state: &AppState,
    expected_revision: Option<u64>,
) -> Result<SettingsEnvelope, SettingsError> {
    let envelope = state.settings()?.reset(expected_revision)?;
    state.workspace_index().discard_all();
    Ok(envelope)
}

#[tauri::command]
pub(crate) fn get_settings(state: State<'_, AppState>) -> Result<SettingsEnvelope, SettingsError> {
    get_settings_inner(&state)
}

#[tauri::command]
pub(crate) fn update_settings(
    expected_revision: u64,
    settings: Settings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsEnvelope, SettingsError> {
    let envelope = update_settings_inner(&state, expected_revision, settings)?;
    state.set_native_shortcuts(envelope.settings.shortcuts.clone());
    native_menu::refresh_app_menu(&app, &state.native_menu_state()).map_err(|error| {
        SettingsError {
            code: crate::models::SettingsErrorCode::Persistence,
            message: format!(
                "Settings were saved, but native shortcuts could not be updated: {error}"
            ),
            can_reset: false,
        }
    })?;
    app.emit(SETTINGS_CHANGED_EVENT, &envelope)
        .map_err(|error| SettingsError {
            code: crate::models::SettingsErrorCode::Persistence,
            message: format!("Settings were saved, but open windows could not be updated: {error}"),
            can_reset: false,
        })?;
    Ok(envelope)
}

#[tauri::command]
pub(crate) fn reset_settings(
    expected_revision: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsEnvelope, SettingsError> {
    let envelope = reset_settings_inner(&state, expected_revision)?;
    state.set_native_shortcuts(envelope.settings.shortcuts.clone());
    native_menu::refresh_app_menu(&app, &state.native_menu_state()).map_err(|error| {
        SettingsError {
            code: crate::models::SettingsErrorCode::Persistence,
            message: format!(
                "Settings were reset, but native shortcuts could not be updated: {error}"
            ),
            can_reset: false,
        }
    })?;
    app.emit(SETTINGS_CHANGED_EVENT, &envelope)
        .map_err(|error| SettingsError {
            code: crate::models::SettingsErrorCode::Persistence,
            message: format!("Settings were reset, but open windows could not be updated: {error}"),
            can_reset: false,
        })?;
    Ok(envelope)
}

#[tauri::command]
pub(crate) fn set_native_save_menu_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.set_native_save_menu_enabled(enabled);
    native_menu::set_save_menu_enabled(&app, enabled)
}

#[tauri::command]
pub(crate) fn set_native_theme_preference(
    selected_skin: String,
    follow_system: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.set_native_theme_preference(&selected_skin, follow_system)?;
    native_menu::refresh_app_menu(&app, &state.native_menu_state())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn set_native_locale_preference(
    mode: String,
    effective_locale: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.set_native_locale_preference(&mode, &effective_locale)?;
    native_menu::refresh_app_menu(&app, &state.native_menu_state())
        .map_err(|error| error.to_string())
}
