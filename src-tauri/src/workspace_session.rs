//! Workspace session record types and shared persistence primitives.
use std::{
    fs,
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
const STORE_VERSION: u8 = 1;
const STORE_FILE_NAME: &str = "workspace-session-v1.json";
const LOCK_FILE_NAME: &str = "workspace-session-v1.lock";
const MAX_STORE_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const STAGING_ATTEMPTS: usize = 8;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceSessionRecord {
    version: u8,
    workspace_root: String,
    active_path: Option<String>,
}

impl WorkspaceSessionRecord {
    pub(crate) fn new(workspace_root: String, active_path: Option<String>) -> Self {
        Self {
            version: STORE_VERSION,
            workspace_root,
            active_path,
        }
    }

    pub(crate) fn workspace_root(&self) -> &str {
        &self.workspace_root
    }

    pub(crate) fn active_path(&self) -> Option<&str> {
        self.active_path.as_deref()
    }

    pub(crate) fn without_active_path(&self) -> Self {
        Self::new(self.workspace_root.clone(), None)
    }

    fn is_valid(&self) -> bool {
        self.version == STORE_VERSION
            && valid_persisted_path(&self.workspace_root)
            && self.active_path.as_deref().is_none_or(valid_persisted_path)
    }
}

pub(crate) trait WorkspaceSessionAtomicReplacer: Send + Sync {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()>;
}

pub(crate) struct SystemWorkspaceSessionAtomicReplacer;

impl WorkspaceSessionAtomicReplacer for SystemWorkspaceSessionAtomicReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        replace_file_atomically(staged, active)
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(staged: &Path, active: &Path) -> io::Result<()> {
    fs::rename(staged, active)
}

#[cfg(windows)]
fn replace_file_atomically(staged: &Path, active: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staged = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let active = active
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            staged.as_ptr(),
            active.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) struct WorkspaceSessionState {
    store: WorkspaceSessionStore,
}

impl WorkspaceSessionState {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            store: WorkspaceSessionStore::new(root),
        }
    }

    pub(crate) fn load(&self) -> Result<Option<WorkspaceSessionRecord>, String> {
        self.store.load()
    }

    pub(crate) fn save(&self, record: &WorkspaceSessionRecord) -> Result<(), String> {
        self.store.save(record)
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        self.store.clear()
    }
}

fn valid_persisted_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= MAX_PATH_BYTES && Path::new(path).is_absolute()
}

mod store;

pub(crate) use store::WorkspaceSessionStore;

#[cfg(test)]
mod tests;
