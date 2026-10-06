use std::{cell::Cell, fs};

use tempfile::tempdir;

use super::*;
use crate::path_auth::FileAuthorizationSession;

pub(crate) struct CountingWorkspaceWalker {
    pub(crate) calls: Cell<usize>,
    pub(crate) entries: Vec<Result<WorkspaceWalkEntry, String>>,
}

impl CountingWorkspaceWalker {
    pub(crate) fn new(entries: Vec<Result<WorkspaceWalkEntry, String>>) -> Self {
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

pub(crate) struct RejectingCanonicalizer {
    pub(crate) calls: Cell<usize>,
}

impl WorkspaceCanonicalizer for RejectingCanonicalizer {
    fn canonicalize(&self, _path: &Path) -> Result<PathBuf, String> {
        self.calls.set(self.calls.get() + 1);
        Err("canonicalizer must not inspect symlinks".to_string())
    }
}

pub(crate) struct RemappingCanonicalizer {
    pub(crate) input: PathBuf,
    pub(crate) output: PathBuf,
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
    for excluded in [".git", "node_modules", "target", "dist"] {
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
