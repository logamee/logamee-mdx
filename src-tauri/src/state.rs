use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use crate::{
    active_document_watch::ActiveDocumentWatchState,
    crash_draft_store::{DurableDraftWriter, ProductionCrashDraftStore, SystemDraftClock},
    document_save::DocumentSaveCoordinator,
    html_preview_server::HtmlPreviewServerState,
    native_menu::NativeMenuState,
    path_auth::FileAuthorizationSession,
    recent_files::RecentFilesState,
    settings::SettingsStore,
    workspace_index_runtime::WorkspaceIndexRuntime,
    workspace_session::WorkspaceSessionState,
};

#[derive(Default)]
pub(crate) struct AppState {
    active_document_watch: ActiveDocumentWatchState,
    document_save: DocumentSaveCoordinator,
    file_authorization: FileAuthorizationSession,
    native_menu: Mutex<NativeMenuState>,
    recent_files: OnceLock<RecentFilesState>,
    settings: OnceLock<SettingsStore>,
    workspace_session: OnceLock<WorkspaceSessionState>,
    workspace_index: WorkspaceIndexRuntime,
    crash_drafts: OnceLock<ProductionCrashDraftStore>,
    crash_draft_startup_error: Mutex<Option<crate::crash_drafts::CrashDraftError>>,
    pub(crate) html_preview_server: HtmlPreviewServerState,
}

impl AppState {
    pub(crate) fn initialize_crash_drafts(&self, app_data_dir: PathBuf) -> Result<(), String> {
        let store =
            ProductionCrashDraftStore::new(app_data_dir, DurableDraftWriter, SystemDraftClock);
        let startup_error = store.repair_startup().err();
        self.crash_drafts
            .set(store)
            .map_err(|_| "Crash draft state is already initialized".to_string())?;
        *self
            .crash_draft_startup_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = startup_error;
        Ok(())
    }

    pub(crate) fn take_crash_draft_startup_error(
        &self,
    ) -> Option<crate::crash_drafts::CrashDraftError> {
        self.crash_draft_startup_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    pub(crate) fn crash_drafts(&self) -> Result<&ProductionCrashDraftStore, String> {
        self.crash_drafts
            .get()
            .ok_or_else(|| "Crash draft state is not initialized".to_string())
    }

    pub(crate) fn active_document_watch(&self) -> &ActiveDocumentWatchState {
        &self.active_document_watch
    }

    pub(crate) fn file_authorization(&self) -> &FileAuthorizationSession {
        &self.file_authorization
    }

    pub(crate) fn document_save(&self) -> &DocumentSaveCoordinator {
        &self.document_save
    }

    pub(crate) fn native_menu_state(&self) -> NativeMenuState {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn set_native_save_menu_enabled(&self, enabled: bool) {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_save_enabled(enabled);
    }

    pub(crate) fn set_native_recent_files(&self, recent_files: crate::models::RecentFilesSnapshot) {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_recent_files(recent_files);
    }

    pub(crate) fn set_native_shortcuts(
        &self,
        shortcuts: std::collections::BTreeMap<String, String>,
    ) {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_shortcuts(shortcuts);
    }

    pub(crate) fn set_native_theme_preference(
        &self,
        selected_skin: &str,
        follow_system: bool,
    ) -> Result<(), String> {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_theme_preference(selected_skin, follow_system)
    }

    pub(crate) fn set_native_locale_preference(
        &self,
        mode: &str,
        effective_locale: &str,
    ) -> Result<(), String> {
        self.native_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_locale_preference(mode, effective_locale)
    }

    pub(crate) fn initialize_recent_files(&self, app_data_dir: PathBuf) -> Result<(), String> {
        self.recent_files
            .set(RecentFilesState::new(app_data_dir))
            .map_err(|_| "Recent files state is already initialized".to_string())
    }

    pub(crate) fn recent_files(&self) -> Result<&RecentFilesState, String> {
        self.recent_files
            .get()
            .ok_or_else(|| "Recent files state is not initialized".to_string())
    }

    pub(crate) fn initialize_settings(&self, app_data_dir: PathBuf) -> Result<(), String> {
        self.settings
            .set(SettingsStore::new(app_data_dir))
            .map_err(|_| "Settings state is already initialized".to_string())
    }

    pub(crate) fn settings(&self) -> Result<&SettingsStore, crate::models::SettingsError> {
        self.settings
            .get()
            .ok_or_else(|| crate::models::SettingsError {
                code: crate::models::SettingsErrorCode::NotInitialized,
                message: "Settings state is not initialized.".to_string(),
                can_reset: false,
            })
    }

    pub(crate) fn initialize_workspace_session(&self, app_data_dir: PathBuf) -> Result<(), String> {
        self.workspace_session
            .set(WorkspaceSessionState::new(app_data_dir))
            .map_err(|_| "Workspace session state is already initialized".to_string())
    }

    pub(crate) fn workspace_session(&self) -> Result<&WorkspaceSessionState, String> {
        self.workspace_session
            .get()
            .ok_or_else(|| "Workspace session state is not initialized".to_string())
    }

    pub(crate) fn workspace_index(&self) -> &WorkspaceIndexRuntime {
        &self.workspace_index
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn native_menu_state_starts_with_defaults_and_retains_all_projection_fields() {
        let state = AppState::default();

        assert!(!state.native_menu_state().save_enabled());
        assert_eq!(state.native_menu_state().selected_skin(), "original");
        state.set_native_save_menu_enabled(true);
        state
            .set_native_theme_preference("songke-zhuying", true)
            .unwrap();
        state
            .set_native_locale_preference("zh-CN", "zh-CN")
            .unwrap();
        assert!(state.native_menu_state().save_enabled());
        assert_eq!(state.native_menu_state().selected_skin(), "songke-zhuying");
        assert!(state.native_menu_state().follow_system());
        assert_eq!(state.native_menu_state().locale_mode(), "zh-CN");
        assert_eq!(state.native_menu_state().effective_locale(), "zh-CN");
    }

    #[test]
    fn crash_draft_state_remains_initialized_when_startup_repair_needs_overflow_batches() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("crash-drafts").join("v1");
        fs::create_dir_all(&root).unwrap();
        for index in 0..65 {
            fs::write(root.join(format!("{index:032x}.json")), b"invalid").unwrap();
        }
        let state = AppState::default();
        state
            .initialize_crash_drafts(directory.path().to_path_buf())
            .unwrap();

        assert!(state.take_crash_draft_startup_error().is_some());
        let error = state.crash_drafts().unwrap().list().unwrap_err();
        assert!(error.repair_receipt.is_some());
    }
}
