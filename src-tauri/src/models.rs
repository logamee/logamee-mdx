use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    durable_write::FileVersion,
    workspace_file_kind::{ContentMode, WorkspaceFileKind},
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub(crate) autosave_enabled: bool,
    pub(crate) autosave_delay_ms: u32,
    #[serde(default = "default_autosave_mode")]
    pub(crate) autosave_mode: String,
    pub(crate) spellcheck_enabled: bool,
    pub(crate) wikilinks_enabled: bool,
    pub(crate) resource_directory: String,
    pub(crate) editor_pane_ratio: f64,
    #[serde(default = "default_editor_font_size")]
    pub(crate) editor_font_size: u32,
    pub(crate) selected_skin: String,
    pub(crate) follow_system_theme: bool,
    pub(crate) locale_mode: String,
    pub(crate) shortcuts: BTreeMap<String, String>,
    pub(crate) export_profiles: BTreeMap<String, serde_json::Value>,
}

fn default_editor_font_size() -> u32 {
    16
}

fn default_autosave_mode() -> String {
    "afterDelay".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            autosave_enabled: true,
            autosave_delay_ms: 1_000,
            autosave_mode: default_autosave_mode(),
            spellcheck_enabled: true,
            wikilinks_enabled: false,
            resource_directory: "assets".to_string(),
            editor_pane_ratio: 0.5,
            editor_font_size: default_editor_font_size(),
            selected_skin: "original".to_string(),
            follow_system_theme: false,
            locale_mode: "system".to_string(),
            shortcuts: BTreeMap::new(),
            export_profiles: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsEnvelope {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) settings: Settings,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SettingsErrorCode {
    Malformed,
    Oversized,
    Invalid,
    UnsupportedVersion,
    Conflict,
    Persistence,
    NotInitialized,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsError {
    pub(crate) code: SettingsErrorCode,
    pub(crate) message: String,
    pub(crate) can_reset: bool,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct MarkdownFileEntry {
    pub(crate) kind: WorkspaceFileKind,
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct WorkspaceDirectoryEntry {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct OpenFileResponse {
    pub(crate) kind: WorkspaceFileKind,
    pub(crate) path: String,
    pub(crate) content_mode: ContentMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) file_version: Option<FileVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bytes_base64: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DocumentSaveResponse {
    ConfirmedCommitted {
        path: String,
        version: FileVersion,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleanup_repair_receipt: Option<String>,
    },
    ConfirmedNotCommitted {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_version: Option<FileVersion>,
        message: String,
    },
    Conflict {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_version: Option<FileVersion>,
        #[serde(skip_serializing_if = "Option::is_none")]
        overwrite_token: Option<String>,
        message: String,
    },
    Indeterminate {
        path: String,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverwriteTokenResponse {
    pub(crate) overwrite_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct PreparedOpenFileResponse {
    pub(crate) file: OpenFileResponse,
    pub(crate) open_receipt: String,
    pub(crate) commit_operation_id: String,
}

pub(crate) const ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct RecentFileSummary {
    pub(crate) id: String,
    pub(crate) display_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct RecentFilesSnapshot {
    pub(crate) entries: Vec<RecentFileSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum OpenCommitResult {
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum OpenCommitStatus {
    Pending,
    Committed { recent_files: RecentFilesSnapshot },
    NotCommitted { message: String },
    Unknown,
}

mod watch;
mod workspace;

pub(crate) use watch::{
    ActiveDocumentDiskSnapshot, ActiveDocumentWatchEvent,
    ActiveDocumentWatchEventPayload, ActiveDocumentWatchHealthStatus, ActiveDocumentWatchReason,
    ActiveDocumentWatchRegistration, ActiveDocumentWatchSnapshotEnvelope,
};
pub(crate) use workspace::{
    DeleteWorkspaceEntryResponse, MutationCommitReceipt, MutationKind, MutationOutcome,
    RenameWorkspaceEntryResponse, SnapshotReceipt, WorkspaceDirectoryListing, WorkspaceMutation,
    WorkspaceSessionRestore, WorkspaceSnapshot,
};

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod session_settings_tests;
#[cfg(test)]
mod tests;
