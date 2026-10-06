#[cfg(test)]
use std::{fs, io, path::Path};

use tauri::{AppHandle, Emitter};

#[cfg(test)]
use crate::document_save::{DocumentSaveDisposition, OverwriteToken, MAIN_SAVE_OWNER};
#[cfg(test)]
use crate::models::{
    MutationOutcome, OpenCommitResult, OpenFileResponse, OverwriteTokenResponse, RecentFilesSnapshot,
    RenameWorkspaceEntryResponse, SnapshotReceipt, WorkspaceMutation,
};
#[cfg(test)]
use crate::models::WorkspaceSnapshot;
#[cfg(test)]
use crate::path_auth::WorkspaceSnapshotSource;
#[cfg(test)]
use crate::workspace_file_kind::WorkspaceFileKind;
#[cfg(test)]
use crate::workspace_snapshot::{capture_workspace_snapshot, CapturedWorkspaceSnapshot};
#[cfg(test)]
use crate::path_auth::ensure_authorized_existing_file_inner;
#[cfg(test)]
use crate::path_auth::resolve_authorized_workspace_root_for_token_inner;
#[cfg(test)]
use crate::excalidraw_scene::default_excalidraw_scene;
#[cfg(test)]
use crate::workspace_session::WorkspaceSessionRecord;
#[cfg(test)]
use crate::path_auth::rename_authorized_workspace_entry_inner;
#[cfg(test)]
use workspace_mutation::observe::observe_path;
#[cfg(test)]
use crate::workspace_trash::{TrashEntryKind, TrashPort};
use crate::docx_preflight::DOCX_SOURCE_LIMIT_BYTES;
#[cfg(test)]
use crate::{models::DocumentSaveResponse, state::AppState};

#[cfg(any(test, feature = "packaged-lifecycle-e2e"))]
pub(crate) use dialogs::open_directory_inner;
#[cfg(test)]
pub(crate) use dialogs::{
    open_directory_with_ports_inner, open_file_parent_directory_inner,
    open_persisted_directory_with_ports_inner,
};

#[cfg(test)]
use crate::path_auth::{
    authorize_directory_root_inner, ensure_authorized_directory_inner,
    ensure_authorized_write_file_inner, AuthorizedWriteOutcome, DeleteFileObservation,
    GrantStatus, WorkspaceCandidate,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ObservedPathKind {
    File,
    Directory,
    Symlink,
}

pub(crate) mod document_save;

pub(crate) use document_save::{
    cancel_document_overwrite_token, issue_document_overwrite_token, read_file,
    retry_document_save_with_token, save_as_dialog, write_file,
};

pub(crate) mod open_recent;

pub(crate) use open_recent::{
    clear_recent_files, commit_recent_open, discard_open_receipt, get_open_commit_status,
    open_file_dialog, open_recent_file, open_workspace_file, prepare_standalone_file_with_ports_inner,
    prepare_workspace_file_inner,
};
#[cfg(test)]
pub(crate) use document_save::{
    document_save_response, document_save_response_with_cleanup,
    issue_document_overwrite_token_inner, read_file_inner, read_file_with_before_open_inner,
    retry_document_save_with_token_inner, save_as_coordinated_inner, save_as_for_kind_inner,
    save_as_inner, save_as_with_ports_inner, save_expected_inner, write_file_inner,
    write_file_with_ports_inner, write_file_with_preflight_and_ports_inner,
};
#[cfg(test)]
pub(crate) use open_recent::{
    open_standalone_file_with_ports_inner, open_workspace_file_inner,
    prepare_workspace_file_with_before_open_inner, refresh_recent_menu_with_retry,
    RECENT_MENU_SYNC_ERROR,
};

pub(crate) mod session;

pub(crate) use session::persist_workspace_session;
#[cfg(test)]
pub(crate) use session::{
    persist_workspace_session_inner, restore_workspace_session_inner,
    restore_workspace_session_with_ports_inner, validate_workspace_session_owner,
};


pub(crate) use workspace_mutation::{
    copy_workspace_entry, create_workspace_directory, create_workspace_file,
    delete_workspace_entry, move_workspace_entry, refresh_directory, rename_workspace_entry,
    reveal_workspace_entry,
};

pub(crate) mod dialogs;

pub(crate) use dialogs::{open_directory_dialog, open_file_parent_directory};

pub(crate) mod media;

#[cfg(test)]
pub(crate) use media::{
    read_markdown_excalidraw_inner, read_workspace_image_inner, resolve_markdown_media_inner,
    resolve_workspace_media_inner, retry_asset_scope_sync,
};
pub(crate) use media::{
    allow_asset_preview_directory, allow_asset_preview_file_with_retry,
    open_authorized_file_response, open_authorized_file_response_from_handle,
    prepare_markdown_media_preview, prepare_workspace_media_preview, read_markdown_excalidraw,
    read_workspace_image, release_media_preview, resolve_markdown_image, resolve_markdown_media,
    resolve_workspace_media,
};

pub(crate) mod workspace_mutation;

#[cfg(test)]
pub(crate) use workspace_mutation::{
    refresh_directory_inner, refresh_directory_with_snapshot_inner, copy_workspace_entry_inner, create_workspace_directory_inner, create_workspace_file_for_kind_inner,
    create_workspace_file_inner, move_workspace_entry_inner, rename_workspace_entry_inner,
};
#[cfg(test)]
pub(crate) use workspace_mutation::{
    delete_workspace_entry_legacy_inner, delete_workspace_entry_with_ports_inner,
    delete_workspace_entry_with_snapshot_inner, delete_workspace_entry_with_trash_port_inner,
    rename_workspace_entry_with_preflight_and_ports_inner,
    rename_workspace_entry_with_ports_inner, rename_workspace_entry_with_snapshot_inner,
};
#[cfg(test)]
pub(crate) use workspace_mutation::{
    create_workspace_directory_with_ports_inner, create_workspace_directory_with_snapshot_inner,
    create_workspace_file_with_ports_inner, create_workspace_file_with_snapshot_inner,
};

pub(crate) mod settings;

pub(crate) use settings::{
    get_settings, reset_settings, set_native_locale_preference, set_native_save_menu_enabled,
    set_native_theme_preference, update_settings,
};

const APP_FEEDBACK_ERROR_EVENT: &str = "mmd:app-feedback-error";
pub(crate) const IMAGE_SOURCE_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const EXCALIDRAW_EMBED_SOURCE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const PDF_SOURCE_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) fn emit_app_feedback_error(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit_to("main", APP_FEEDBACK_ERROR_EVENT, message.into());
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ObservedContentEvidence {
    NotRequested,
    Compared {
        matches_expected: bool,
        bytes_read: usize,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ObservedPath {
    Missing,
    Present {
        canonical_path: Option<std::path::PathBuf>,
        kind: ObservedPathKind,
        content: ObservedContentEvidence,
    },
}

pub(crate) enum RenamePathEvidence {
    Missing,
    Matches,
    Unexpected,
    ObservationFailed(String),
}


#[cfg(windows)]
pub(crate) mod windows_handle_files;
mod ports;
mod rename;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix_no_follow;
mod platform_tails;

pub(crate) use ports::{SystemFileSystemPort, SystemRevealPort, RevealPort, committed_document_version, discard_workspace_index_after_workspace_mutation};
#[cfg(test)]
pub(crate) use ports::reveal_workspace_entry_with_port_inner;
#[cfg(windows)]
pub(crate) use windows_handle_files::rename_no_replace;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use unix_no_follow::{
    open_directory_without_following_links, open_regular_file_beneath_directory,
    open_regular_file_without_following_links, write_file_without_following_links,
};
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) use platform_tails::{
    open_directory_without_following_links, open_regular_file_beneath_directory,
    open_regular_file_without_following_links, write_file_without_following_links,
};
pub(crate) use platform_tails::{opened_file_platform_identity, FileSystemPort};

#[cfg(test)]
mod tests;
