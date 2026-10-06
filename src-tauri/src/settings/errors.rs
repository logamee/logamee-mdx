//! Settings error mapping and private permission helpers.
use std::{
    io,
};

use crate::models::{SettingsError, SettingsErrorCode};
pub(crate) use crate::private_fs::{set_private_directory_permissions, set_private_file_permissions};

pub(crate) fn map_read_error(error: io::Error) -> SettingsError {
    match error.kind() {
        io::ErrorKind::NotFound => not_initialized_error(),
        io::ErrorKind::FileTooLarge => SettingsError {
            code: SettingsErrorCode::Oversized,
            message: "The settings file is larger than mdx can safely read.".to_string(),
            can_reset: true,
        },
        _ => persistence_error(format!("Cannot read settings: {error}")),
    }
}

pub(crate) fn not_initialized_error() -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::NotInitialized,
        message: "Settings have not been created yet.".to_string(),
        can_reset: false,
    }
}

pub(crate) fn invalid_error(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Invalid,
        message: message.into(),
        can_reset: true,
    }
}

pub(crate) fn next_revision(current: u64) -> Result<u64, SettingsError> {
    current.checked_add(1).ok_or_else(|| {
        persistence_error("Settings revision capacity has been exhausted; settings were unchanged.")
    })
}

pub(crate) fn revision_conflict() -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Conflict,
        message: "Settings changed after this view loaded. Reload them and try again.".to_string(),
        can_reset: false,
    }
}

pub(crate) fn persistence_error(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Persistence,
        message: message.into(),
        can_reset: false,
    }
}
