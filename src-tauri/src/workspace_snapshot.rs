use std::{
    fs,
    path::{Path, PathBuf},
};

use walkdir::WalkDir;

use crate::{
    models::{
        MarkdownFileEntry, WorkspaceDirectoryEntry, WorkspaceDirectoryListing, WorkspaceSnapshot,
    },
    path_auth::{AuthorizedWorkspace, WorkspaceSnapshotSource, WorkspaceToken},
    workspace_file_kind::WorkspaceFileKind,
    workspace_index::CancellationToken,
};

pub(crate) const EXCLUDED_WALK_DIRS: &[&str] = &[".git", ".omx", "node_modules", "target", "dist"];
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkspaceWalkEntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorkspaceWalkEntry {
    path: PathBuf,
    kind: WorkspaceWalkEntryKind,
}

impl WorkspaceWalkEntry {
    #[cfg(test)]
    fn file(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::File,
        }
    }

    #[cfg(test)]
    fn directory(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::Directory,
        }
    }

    #[cfg(test)]
    fn symlink(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: WorkspaceWalkEntryKind::Symlink,
        }
    }
}

trait WorkspaceWalker {
    fn walk<'a>(
        &'a self,
        root: &'a Path,
    ) -> Result<Box<dyn Iterator<Item = Result<WorkspaceWalkEntry, String>> + 'a>, String>;
}

trait WorkspaceCanonicalizer {
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, String>;
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

struct WalkDirWorkspaceWalker;

struct FileSystemWorkspaceCanonicalizer;

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

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "Workspace entry escaped snapshot root".to_string())
}

fn entry_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .to_string()
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
        if entry.kind == WorkspaceWalkEntryKind::Symlink {
            continue;
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
                    continue;
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
mod tests {
    use std::{cell::Cell, fs};

    use tempfile::tempdir;

    use super::*;
    use crate::path_auth::FileAuthorizationSession;

    struct CountingWorkspaceWalker {
        calls: Cell<usize>,
        entries: Vec<Result<WorkspaceWalkEntry, String>>,
    }

    impl CountingWorkspaceWalker {
        fn new(entries: Vec<Result<WorkspaceWalkEntry, String>>) -> Self {
            Self {
                calls: Cell::new(0),
                entries,
            }
        }
    }

    impl WorkspaceWalker for CountingWorkspaceWalker {
        fn walk<'a>(
            &'a self,
            _root: &'a Path,
        ) -> Result<Box<dyn Iterator<Item = Result<WorkspaceWalkEntry, String>> + 'a>, String>
        {
            self.calls.set(self.calls.get() + 1);
            Ok(Box::new(self.entries.clone().into_iter()))
        }
    }

    struct RejectingCanonicalizer {
        calls: Cell<usize>,
    }

    impl WorkspaceCanonicalizer for RejectingCanonicalizer {
        fn canonicalize(&self, _path: &Path) -> Result<PathBuf, String> {
            self.calls.set(self.calls.get() + 1);
            Err("canonicalizer must not inspect symlinks".to_string())
        }
    }

    struct RemappingCanonicalizer {
        input: PathBuf,
        output: PathBuf,
    }

    impl WorkspaceCanonicalizer for RemappingCanonicalizer {
        fn canonicalize(&self, path: &Path) -> Result<PathBuf, String> {
            if path == self.input {
                Ok(self.output.clone())
            } else {
                Ok(path.to_path_buf())
            }
        }
    }

    #[test]
    fn snapshot_invokes_workspace_walker_once() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        let document = notes.join("document.md");
        fs::create_dir(&notes).unwrap();
        fs::write(&document, "# document").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();
        let canonical_notes = candidate.root.join("notes");
        let canonical_document = canonical_notes.join("document.md");
        let walker = CountingWorkspaceWalker::new(vec![
            Ok(WorkspaceWalkEntry::directory(canonical_notes)),
            Ok(WorkspaceWalkEntry::file(canonical_document)),
        ]);

        let snapshot = capture_workspace_snapshot_with(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &walker,
        )
        .unwrap();

        assert_eq!(walker.calls.get(), 1);
        assert_eq!(snapshot.root, workspace.path().canonicalize().unwrap());
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].relative_path, "notes/document.md");
        assert_eq!(snapshot.directories.len(), 1);
        assert_eq!(snapshot.directories[0].relative_path, "notes");
    }

    #[test]
    fn mid_walk_error_returns_no_partial_snapshot() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        let document = notes.join("document.md");
        fs::create_dir(&notes).unwrap();
        fs::write(&document, "# document").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();
        let walker = CountingWorkspaceWalker::new(vec![
            Ok(WorkspaceWalkEntry::directory(candidate.root.join("notes"))),
            Ok(WorkspaceWalkEntry::file(
                candidate.root.join("notes/document.md"),
            )),
            Err("injected mid-walk failure".to_string()),
        ]);

        let error = match capture_workspace_snapshot_with(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &walker,
        ) {
            Ok(_) => panic!("mid-walk failure must not return a partial snapshot"),
            Err(error) => error,
        };

        assert_eq!(error, "injected mid-walk failure");
        assert_eq!(walker.calls.get(), 1);
    }

    #[test]
    fn empty_directories_remain_present() {
        let workspace = tempdir().unwrap();
        fs::create_dir(workspace.path().join("empty")).unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();

        let snapshot =
            capture_workspace_snapshot(WorkspaceSnapshotSource::Candidate(&candidate)).unwrap();

        assert_eq!(snapshot.directories.len(), 1);
        assert_eq!(snapshot.directories[0].relative_path, "empty");
    }

    #[test]
    fn supported_entries_sort_by_normalized_relative_path() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("alpha")).unwrap();
        fs::create_dir_all(workspace.path().join("zeta")).unwrap();
        fs::write(workspace.path().join("alpha/a.html"), "<p>a</p>").unwrap();
        fs::write(workspace.path().join("zeta/z.md"), "# z").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();
        let walker = CountingWorkspaceWalker::new(vec![
            Ok(WorkspaceWalkEntry::file(candidate.root.join("zeta/z.md"))),
            Ok(WorkspaceWalkEntry::directory(candidate.root.join("zeta"))),
            Ok(WorkspaceWalkEntry::file(
                candidate.root.join("alpha/a.html"),
            )),
            Ok(WorkspaceWalkEntry::directory(candidate.root.join("alpha"))),
        ]);

        let snapshot = capture_workspace_snapshot_with(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &walker,
        )
        .unwrap();

        assert_eq!(
            snapshot
                .files
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["alpha/a.html", "zeta/z.md"]
        );
        assert_eq!(
            snapshot
                .directories
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
    }

    #[test]
    fn excluded_directories_are_not_traversed() {
        let workspace = tempdir().unwrap();
        for excluded in [".git", ".omx", "node_modules", "target", "dist"] {
            let nested = workspace.path().join(excluded).join("nested");
            fs::create_dir_all(&nested).unwrap();
            fs::write(nested.join("hidden.md"), "# hidden").unwrap();
        }
        fs::create_dir(workspace.path().join("visible")).unwrap();
        fs::write(workspace.path().join("visible/document.md"), "# visible").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();

        let snapshot =
            capture_workspace_snapshot(WorkspaceSnapshotSource::Candidate(&candidate)).unwrap();

        assert_eq!(
            snapshot
                .files
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["visible/document.md"]
        );
        assert_eq!(
            snapshot
                .directories
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["visible"]
        );
    }

    #[test]
    fn unsupported_files_are_omitted() {
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("document.md"), "# visible").unwrap();
        fs::write(workspace.path().join("notes.txt"), "not a workspace file").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();

        let snapshot =
            capture_workspace_snapshot(WorkspaceSnapshotSource::Candidate(&candidate)).unwrap();

        assert_eq!(
            snapshot
                .files
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["document.md"]
        );
    }

    #[test]
    fn symlink_entries_are_skipped_before_canonicalization() {
        let workspace = tempdir().unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();
        let walker = CountingWorkspaceWalker::new(vec![Ok(WorkspaceWalkEntry::symlink(
            candidate.root.join("linked.md"),
        ))]);
        let canonicalizer = RejectingCanonicalizer {
            calls: Cell::new(0),
        };

        let snapshot = capture_workspace_snapshot_with_canonicalizer(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &walker,
            &canonicalizer,
        )
        .unwrap();

        assert_eq!(canonicalizer.calls.get(), 0);
        assert!(snapshot.files.is_empty());
        assert!(snapshot.directories.is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let outside = tempdir().unwrap();
            fs::write(outside.path().join("outside.md"), "# outside").unwrap();
            fs::create_dir(outside.path().join("outside-directory")).unwrap();
            symlink(
                outside.path().join("outside.md"),
                workspace.path().join("linked-file.md"),
            )
            .unwrap();
            symlink(
                outside.path().join("outside-directory"),
                workspace.path().join("linked-directory"),
            )
            .unwrap();

            let snapshot =
                capture_workspace_snapshot(WorkspaceSnapshotSource::Candidate(&candidate)).unwrap();

            assert!(snapshot.files.is_empty());
            assert!(snapshot.directories.is_empty());
        }
    }

    #[test]
    fn canonical_escape_fails_the_entire_snapshot() {
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("safe.md"), "# safe").unwrap();
        fs::write(workspace.path().join("escaped.md"), "# escaped").unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("outside.md"), "# outside").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();
        let escaped_input = candidate.root.join("escaped.md");
        let walker = CountingWorkspaceWalker::new(vec![
            Ok(WorkspaceWalkEntry::file(candidate.root.join("safe.md"))),
            Ok(WorkspaceWalkEntry::file(escaped_input.clone())),
        ]);
        let canonicalizer = RemappingCanonicalizer {
            input: escaped_input,
            output: outside.path().join("outside.md").canonicalize().unwrap(),
        };

        let error = match capture_workspace_snapshot_with_canonicalizer(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &walker,
            &canonicalizer,
        ) {
            Ok(_) => panic!("a canonical escape must fail the whole snapshot"),
            Err(error) => error,
        };

        assert_eq!(error, "Workspace entry escaped snapshot root");
        assert_eq!(walker.calls.get(), 1);
    }

    #[test]
    fn canonical_type_inconsistency_fails_the_entire_snapshot() {
        let workspace = tempdir().unwrap();
        let walked_file = workspace.path().join("walked-file.md");
        let canonical_directory = workspace.path().join("canonical-directory.md");
        let walked_directory = workspace.path().join("walked-directory");
        let canonical_file = workspace.path().join("canonical-file");
        fs::write(&walked_file, "# file").unwrap();
        fs::create_dir(&canonical_directory).unwrap();
        fs::create_dir(&walked_directory).unwrap();
        fs::write(&canonical_file, "file").unwrap();
        let session = FileAuthorizationSession::default();
        let candidate = session
            .workspace_candidate_for_test(workspace.path())
            .unwrap();

        let file_walker = CountingWorkspaceWalker::new(vec![Ok(WorkspaceWalkEntry::file(
            walked_file.canonicalize().unwrap(),
        ))]);
        let file_canonicalizer = RemappingCanonicalizer {
            input: walked_file.canonicalize().unwrap(),
            output: canonical_directory.canonicalize().unwrap(),
        };
        let file_error = match capture_workspace_snapshot_with_canonicalizer(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &file_walker,
            &file_canonicalizer,
        ) {
            Ok(_) => panic!("a walked file canonicalized as a directory must fail the snapshot"),
            Err(error) => error,
        };

        assert_eq!(
            file_error,
            "Workspace entry type changed during canonicalization"
        );
        assert_eq!(file_walker.calls.get(), 1);

        let directory_walker = CountingWorkspaceWalker::new(vec![Ok(
            WorkspaceWalkEntry::directory(walked_directory.canonicalize().unwrap()),
        )]);
        let directory_canonicalizer = RemappingCanonicalizer {
            input: walked_directory.canonicalize().unwrap(),
            output: canonical_file.canonicalize().unwrap(),
        };
        let directory_error = match capture_workspace_snapshot_with_canonicalizer(
            WorkspaceSnapshotSource::Candidate(&candidate),
            &directory_walker,
            &directory_canonicalizer,
        ) {
            Ok(_) => panic!("a walked directory canonicalized as a file must fail the snapshot"),
            Err(error) => error,
        };

        assert_eq!(
            directory_error,
            "Workspace entry type changed during canonicalization"
        );
        assert_eq!(directory_walker.calls.get(), 1);
    }

    #[test]
    fn opaque_snapshot_sources_keep_root_and_token_provenance_together() {
        let workspace = tempdir().unwrap();
        fs::create_dir(workspace.path().join("notes")).unwrap();
        fs::write(workspace.path().join("notes/document.md"), "# document").unwrap();
        let canonical_root = workspace.path().canonicalize().unwrap();
        let session = FileAuthorizationSession::default();

        let (authorized, candidate_snapshot) = session
            .open_workspace(workspace.path(), capture_workspace_snapshot, |_| Ok(()))
            .unwrap();
        let authorized_snapshot =
            capture_workspace_snapshot(WorkspaceSnapshotSource::Authorized(&authorized)).unwrap();

        assert_eq!(candidate_snapshot.root, canonical_root);
        assert_eq!(candidate_snapshot.workspace_token, None);
        assert_eq!(authorized_snapshot.root, canonical_root);
        assert_eq!(
            authorized_snapshot.workspace_token,
            Some(*authorized.token())
        );
        assert_eq!(
            candidate_snapshot
                .files
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            authorized_snapshot
                .files
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            candidate_snapshot
                .directories
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            authorized_snapshot
                .directories
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>()
        );
    }
}
