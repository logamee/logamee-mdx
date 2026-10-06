use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    models::{
        MarkdownFileEntry, WorkspaceDirectoryEntry, WorkspaceDirectoryListing, WorkspaceSnapshot,
    },
    path_auth::{AuthorizedWorkspace, WorkspaceSnapshotSource, WorkspaceToken},
    workspace_file_kind::WorkspaceFileKind,
    workspace_index::CancellationToken,
};

pub(crate) const EXCLUDED_WALK_DIRS: &[&str] = &[".git", "node_modules", "target", "dist"];
pub(crate) const MAX_WORKSPACE_INDEX_WALK_ENTRIES: usize = 200_000;

pub(crate) enum WorkspaceIndexSnapshotCapture {
    Completed(CapturedWorkspaceSnapshot),
    Cancelled,
}

pub(crate) fn is_excluded_walk_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| EXCLUDED_WALK_DIRS.contains(&name))
}

pub(crate) struct CapturedWorkspaceSnapshot {
    workspace_token: Option<WorkspaceToken>,
    root: PathBuf,
    files: Vec<MarkdownFileEntry>,
    directories: Vec<WorkspaceDirectoryEntry>,
}

impl CapturedWorkspaceSnapshot {
    fn validate_provenance(&self, workspace: &AuthorizedWorkspace) -> Result<(), String> {
        if self.root != workspace.root
            || self
                .workspace_token
                .is_some_and(|token| token != workspace.token)
        {
            return Err("Workspace snapshot provenance does not match authorization".into());
        }
        Ok(())
    }

    pub(crate) fn into_directory_listing(
        self,
        workspace: &AuthorizedWorkspace,
    ) -> Result<WorkspaceDirectoryListing, String> {
        self.validate_provenance(workspace)?;
        Ok(WorkspaceDirectoryListing {
            root: self.root.to_string_lossy().to_string(),
            files: self.files,
            directories: self.directories,
        })
    }

    pub(crate) fn into_workspace_snapshot(
        self,
        workspace: &AuthorizedWorkspace,
    ) -> Result<WorkspaceSnapshot, String> {
        let workspace_token = workspace.wire_token();
        let listing = self.into_directory_listing(workspace)?;
        Ok(WorkspaceSnapshot {
            workspace_token,
            root: listing.root,
            files: listing.files,
            directories: listing.directories,
        })
    }

    pub(crate) fn into_index_files(
        self,
        workspace: &AuthorizedWorkspace,
    ) -> Result<Vec<MarkdownFileEntry>, String> {
        self.validate_provenance(workspace)?;
        Ok(self.files)
    }
}

fn capture_workspace_snapshot_with(
    source: WorkspaceSnapshotSource<'_>,
    walker: &(impl WorkspaceWalker + ?Sized),
) -> Result<CapturedWorkspaceSnapshot, String> {
    capture_workspace_snapshot_with_canonicalizer(source, walker, &FileSystemWorkspaceCanonicalizer)
}

fn capture_workspace_snapshot_with_canonicalizer(
    source: WorkspaceSnapshotSource<'_>,
    walker: &(impl WorkspaceWalker + ?Sized),
    canonicalizer: &(impl WorkspaceCanonicalizer + ?Sized),
) -> Result<CapturedWorkspaceSnapshot, String> {
    capture_workspace_snapshot_with_options(source, walker, canonicalizer, None, None)?
        .ok_or_else(|| "Workspace snapshot capture was unexpectedly cancelled".to_string())
}

fn capture_walk_entry(
    entry: &WorkspaceWalkEntry,
    root: &Path,
    canonicalizer: &(impl WorkspaceCanonicalizer + ?Sized),
    files: &mut Vec<MarkdownFileEntry>,
    directories: &mut Vec<WorkspaceDirectoryEntry>,
) -> Result<(), String> {
    if entry.kind == WorkspaceWalkEntryKind::Symlink {
        return Ok(());
    }
    let canonical_path = canonicalizer.canonicalize(&entry.path)?;
    let relative_path = relative_path(root, &canonical_path)?;
    let canonical_metadata = fs::metadata(&canonical_path)
        .map_err(|error| format!("Failed to inspect canonical workspace entry: {error}"))?;
    let canonical_type_matches = match entry.kind {
        WorkspaceWalkEntryKind::File => canonical_metadata.is_file(),
        WorkspaceWalkEntryKind::Directory => canonical_metadata.is_dir(),
        WorkspaceWalkEntryKind::Symlink => {
            unreachable!("symlinks are skipped before canonicalization")
        }
    };
    if !canonical_type_matches {
        return Err("Workspace entry type changed during canonicalization".to_string());
    }
    match entry.kind {
        WorkspaceWalkEntryKind::File => {
            let Some(kind) = WorkspaceFileKind::classify(&canonical_path) else {
                return Ok(());
            };
            files.push(MarkdownFileEntry {
                kind,
                path: canonical_path.to_string_lossy().to_string(),
                relative_path,
                name: entry_name(&canonical_path, "Untitled.md"),
            });
        }
        WorkspaceWalkEntryKind::Directory => {
            directories.push(WorkspaceDirectoryEntry {
                path: canonical_path.to_string_lossy().to_string(),
                relative_path,
                name: entry_name(&canonical_path, "Untitled"),
            });
        }
        WorkspaceWalkEntryKind::Symlink => unreachable!("symlinks are skipped before capture"),
    }
    Ok(())
}

fn capture_workspace_snapshot_with_options(
    source: WorkspaceSnapshotSource<'_>,
    walker: &(impl WorkspaceWalker + ?Sized),
    canonicalizer: &(impl WorkspaceCanonicalizer + ?Sized),
    cancellation: Option<&CancellationToken>,
    max_entries: Option<usize>,
) -> Result<Option<CapturedWorkspaceSnapshot>, String> {
    let (root, workspace_token) = match source {
        WorkspaceSnapshotSource::Candidate(candidate) => (candidate.root.as_path(), None),
        WorkspaceSnapshotSource::Authorized(workspace) => {
            (workspace.root.as_path(), Some(workspace.token))
        }
    };
    let mut files = Vec::new();
    let mut directories = Vec::new();
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Ok(None);
    }
    let mut walked_entries = 0usize;

    for entry in walker.walk(root)? {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Ok(None);
        }
        walked_entries = walked_entries.saturating_add(1);
        if max_entries.is_some_and(|limit| walked_entries > limit) {
            return Err("Workspace index traversal exceeded its entry limit".to_string());
        }
        let entry = entry?;
        capture_walk_entry(&entry, root, canonicalizer, &mut files, &mut directories)?;
    }

    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    directories.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    Ok(Some(CapturedWorkspaceSnapshot {
        workspace_token,
        root: root.to_path_buf(),
        files,
        directories,
    }))
}

pub(crate) fn capture_workspace_snapshot(
    source: WorkspaceSnapshotSource<'_>,
) -> Result<CapturedWorkspaceSnapshot, String> {
    capture_workspace_snapshot_with(source, &WalkDirWorkspaceWalker)
}

pub(crate) fn capture_workspace_index_snapshot(
    workspace: &AuthorizedWorkspace,
    cancellation: &CancellationToken,
) -> Result<WorkspaceIndexSnapshotCapture, String> {
    match capture_workspace_snapshot_with_options(
        WorkspaceSnapshotSource::Authorized(workspace),
        &WalkDirWorkspaceWalker,
        &FileSystemWorkspaceCanonicalizer,
        Some(cancellation),
        Some(MAX_WORKSPACE_INDEX_WALK_ENTRIES),
    )? {
        Some(snapshot) => Ok(WorkspaceIndexSnapshotCapture::Completed(snapshot)),
        None => Ok(WorkspaceIndexSnapshotCapture::Cancelled),
    }
}


#[cfg(test)]
mod canonical_tests;
#[cfg(test)]
mod tests;
mod walker;

use walker::{
    entry_name, relative_path, FileSystemWorkspaceCanonicalizer, WalkDirWorkspaceWalker,
    WorkspaceCanonicalizer, WorkspaceWalker, WorkspaceWalkEntry, WorkspaceWalkEntryKind,
};
