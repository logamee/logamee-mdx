use std::{cell::Cell, fs};

use tempfile::tempdir;

use super::*;
use super::tests::*;
use crate::path_auth::{FileAuthorizationSession, WorkspaceCandidate};

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

fn assert_walked_type_change_fails_snapshot(
    candidate: &WorkspaceCandidate,
    walked_entry: WorkspaceWalkEntry,
    walked_input: PathBuf,
    canonical_output: PathBuf,
    failure_message: &str,
) {
    let walker = CountingWorkspaceWalker::new(vec![Ok(walked_entry)]);
    let canonicalizer = RemappingCanonicalizer {
        input: walked_input,
        output: canonical_output,
    };
    let error = match capture_workspace_snapshot_with_canonicalizer(
        WorkspaceSnapshotSource::Candidate(candidate),
        &walker,
        &canonicalizer,
    ) {
        Ok(_) => panic!("{}", failure_message),
        Err(error) => error,
    };

    assert_eq!(
        error,
        "Workspace entry type changed during canonicalization"
    );
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

    assert_walked_type_change_fails_snapshot(
        &candidate,
        WorkspaceWalkEntry::file(walked_file.canonicalize().unwrap()),
        walked_file.canonicalize().unwrap(),
        canonical_directory.canonicalize().unwrap(),
        "a walked file canonicalized as a directory must fail the snapshot",
    );

    assert_walked_type_change_fails_snapshot(
        &candidate,
        WorkspaceWalkEntry::directory(walked_directory.canonicalize().unwrap()),
        walked_directory.canonicalize().unwrap(),
        canonical_file.canonicalize().unwrap(),
        "a walked directory canonicalized as a file must fail the snapshot",
    );
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
