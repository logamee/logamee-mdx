//! Ports and post-commit workspace reconciliation.
use std::{fs, io::Write, path::Path};

use super::platform_tails::FileSystemPort;
use super::write_file_without_following_links;
use crate::durable_write::FileVersion;
use crate::models::DocumentSaveResponse;
use crate::path_auth::AuthorizedWorkspace;
use crate::state::AppState;
use super::rename::rename_no_replace;

pub(crate) struct SystemFileSystemPort;

impl FileSystemPort for SystemFileSystemPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        write_file_without_following_links(path, bytes)
    }

    fn create_new(&self, path: &Path) -> std::io::Result<()> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)
    }

    fn create_new_with_contents(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)
    }

    fn create_dir(&self, path: &Path) -> std::io::Result<()> {
        fs::create_dir(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        rename_no_replace(from, to)
    }

    #[cfg(test)]
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        fs::remove_file(path)
    }

    #[cfg(test)]
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        fs::remove_dir_all(path)
    }
}

pub(crate) fn committed_document_version(
    response: &Result<DocumentSaveResponse, String>,
) -> Option<&FileVersion> {
    match response {
        Ok(DocumentSaveResponse::ConfirmedCommitted { version, .. }) => Some(version),
        _ => None,
    }
}

pub(crate) fn discard_workspace_index_after_workspace_mutation(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
) {
    let _ = state
        .workspace_index()
        .discard(&workspace.wire_token(), workspace.root());
}

pub(crate) trait RevealPort: Send + Sync {
    fn reveal(&self, path: &Path) -> Result<(), String>;
}

pub(crate) struct SystemRevealPort;

#[cfg(target_os = "macos")]
impl RevealPort for SystemRevealPort {
    fn reveal(&self, path: &Path) -> Result<(), String> {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .status()
            .map_err(|error| format!("Failed to reveal the entry in Finder: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Failed to reveal the entry in Finder: exit status {status}"))
        }
    }
}

#[cfg(windows)]
impl RevealPort for SystemRevealPort {
    fn reveal(&self, path: &Path) -> Result<(), String> {
        // explorer reports a nonzero exit code on success for /select, so the
        // spawn result alone decides the outcome.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|error| format!("Failed to reveal the entry in File Explorer: {error}"))
            .map(|_| ())
    }
}

#[cfg(target_os = "linux")]
impl RevealPort for SystemRevealPort {
    fn reveal(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Revealed entry has no parent".to_string())?;
        let status = std::process::Command::new("xdg-open")
            .arg(parent)
            .status()
            .map_err(|error| format!("Failed to open the containing folder: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Failed to open the containing folder: exit status {status}"))
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl RevealPort for SystemRevealPort {
    fn reveal(_path: &Path) -> Result<(), String> {
        Err("Revealing entries in the system file manager is unsupported on this platform".into())
    }
}

#[cfg(test)]
pub(crate) fn reveal_workspace_entry_with_port_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    reveal: &dyn RevealPort,
) -> Result<std::path::PathBuf, String> {
    crate::path_auth::reveal_authorized_workspace_entry_inner(state, path, |canonical| {
        reveal.reveal(canonical)
    })
}
