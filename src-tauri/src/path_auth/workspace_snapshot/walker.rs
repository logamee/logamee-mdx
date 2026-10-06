use std::{
    fs,
    path::{Path, PathBuf},
};

use super::is_excluded_walk_dir;

use walkdir::WalkDir;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceWalkEntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceWalkEntry {
    pub(crate) path: PathBuf,
    pub(crate) kind: WorkspaceWalkEntryKind,
}

impl WorkspaceWalkEntry {
    #[cfg(test)]
    pub(crate) fn file(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::File,
        }
    }

    #[cfg(test)]
    pub(crate) fn directory(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::Directory,
        }
    }

    #[cfg(test)]
    pub(crate) fn symlink(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::Symlink,
        }
    }
}

pub(crate) trait WorkspaceWalker {
    fn walk<'a>(
        &'a self,
        root: &'a Path,
    ) -> Result<Box<dyn Iterator<Item = Result<WorkspaceWalkEntry, String>> + 'a>, String>;
}

pub(crate) trait WorkspaceCanonicalizer {
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, String>;
}

pub(crate) struct WalkDirWorkspaceWalker;

pub(crate) struct FileSystemWorkspaceCanonicalizer;

impl WorkspaceCanonicalizer for FileSystemWorkspaceCanonicalizer {
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, String> {
        fs::canonicalize(path)
            .map_err(|error| format!("Failed to canonicalize workspace entry: {error}"))
    }
}

impl WorkspaceWalker for WalkDirWorkspaceWalker {
    fn walk<'a>(
        &'a self,
        root: &'a Path,
    ) -> Result<Box<dyn Iterator<Item = Result<WorkspaceWalkEntry, String>> + 'a>, String> {
        let entries = WalkDir::new(root)
            .follow_links(false)
            .min_depth(1)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !is_excluded_walk_dir(entry.path()))
            .map(|entry| {
                let entry = entry.map_err(|error| format!("Failed to walk directory: {error}"))?;
                let file_type = entry.file_type();
                let kind = if file_type.is_symlink() {
                    WorkspaceWalkEntryKind::Symlink
                } else if file_type.is_file() {
                    WorkspaceWalkEntryKind::File
                } else if file_type.is_dir() {
                    WorkspaceWalkEntryKind::Directory
                } else {
                    return Err("Workspace entry has an unsupported type".to_string());
                };
                Ok(WorkspaceWalkEntry {
                    path: entry.into_path(),
                    kind,
                })
            });
        Ok(Box::new(entries))
    }
}

pub(crate) fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "Workspace entry escaped snapshot root".to_string())
}

pub(crate) fn entry_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .to_string()
}
