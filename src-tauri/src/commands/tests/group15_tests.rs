use super::fixtures2::*;
use super::fixtures3::*;
#[test]
fn workspace_mutations_reject_traversal_and_outside_paths() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    assert_confirmed_not_committed(create_workspace_file_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "../escape.md",
    ));
    assert_confirmed_not_committed(create_workspace_directory_inner(
        &state,
        &opened.workspace_token,
        outside.path(),
        "notes",
    ));

    let outside_doc = outside.path().join("outside.md");
    fs::write(&outside_doc, "# outside").unwrap();
    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &outside_doc,
        "renamed.md",
    ));
    assert_confirmed_not_committed(delete_workspace_entry_legacy_inner(
        &state,
        &opened.workspace_token,
        outside.path(),
    ));
}
#[test]
fn workspace_root_cannot_be_renamed_or_deleted() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, &root).unwrap();

    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &root,
        "renamed",
    ));
    assert_confirmed_not_committed(delete_workspace_entry_legacy_inner(
        &state,
        &opened.workspace_token,
        &root,
    ));
    assert!(root.is_dir());
}
#[test]
fn workspace_directory_listing_includes_empty_directories() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("empty")).unwrap();
    fs::create_dir(dir.path().join("notes")).unwrap();
    fs::write(dir.path().join("notes/doc.md"), "# doc").unwrap();
    let state = AppState::default();

    let opened = open_directory_inner(&state, dir.path()).unwrap();
    let directories: Vec<_> = opened
        .directories
        .iter()
        .map(|entry| entry.relative_path.as_str())
        .collect();
    assert!(directories.contains(&"empty"));
    assert!(directories.contains(&"notes"));
}
#[test]
fn directory_open_deep_intent_owns_snapshot_transport_and_publication_order() {
    use std::cell::RefCell;

    let workspace = tempdir().unwrap();
    fs::write(workspace.path().join("doc.md"), "# doc").unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let state = AppState::default();
    let events = RefCell::new(Vec::new());

    let response = open_directory_with_ports_inner(
        &state,
        workspace.path(),
        |source| {
            assert!(matches!(source, WorkspaceSnapshotSource::Candidate(_)));
            events.borrow_mut().push("candidate");
            let snapshot = capture_workspace_snapshot(source)?;
            events.borrow_mut().push("snapshot");
            Ok(snapshot)
        },
        |root: &Path| {
            assert_eq!(*events.borrow(), ["candidate", "snapshot"]);
            assert_eq!(root, canonical_root);
            events.borrow_mut().push("transport");
            Ok(())
        },
    )
    .unwrap();
    events.borrow_mut().push("response");

    assert_eq!(
        *events.borrow(),
        ["candidate", "snapshot", "transport", "response"]
    );
    assert_eq!(response.root, canonical_root.to_string_lossy());
    assert_eq!(response.files.len(), 1);
    assert!(ensure_authorized_directory_inner(&state, &canonical_root).is_ok());
}
#[test]
fn authorized_directory_refresh_is_allowed() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("doc.md"), "# doc").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();
    assert_eq!(opened.files.len(), 1);

    let refreshed = refresh_directory_inner(&state, &opened.workspace_token, &opened.root).unwrap();
    assert_eq!(refreshed.root, opened.root);
    assert_eq!(refreshed.files.len(), 1);
    assert_eq!(refreshed.files[0].relative_path, "doc.md");
}
#[test]
fn nested_workspace_refresh_keeps_the_exact_opened_root() {
    let outer = tempdir().unwrap();
    let inner = outer.path().join("inner");
    fs::create_dir(&inner).unwrap();
    fs::write(outer.path().join("outer.md"), "# outer").unwrap();
    fs::write(inner.join("inner.md"), "# inner").unwrap();
    let state = AppState::default();

    open_directory_inner(&state, outer.path()).unwrap();
    let opened_inner = open_directory_inner(&state, &inner).unwrap();
    let refreshed_inner =
        refresh_directory_inner(&state, &opened_inner.workspace_token, &opened_inner.root).unwrap();

    assert_eq!(refreshed_inner.root, opened_inner.root);
    assert_eq!(refreshed_inner.files.len(), 1);
    assert_eq!(refreshed_inner.files[0].relative_path, "inner.md");
}
#[test]
fn snapshot_api_rejects_raw_command_paths_by_construction() {
    struct CandidatePathIsOpaque;
    struct SnapshotSourcePartsAreOpaque;

    trait CandidateHasNoRawRootAccessor {
        fn root(&self) -> CandidatePathIsOpaque;
    }

    trait SnapshotSourceHasNoRawPartsAccessor {
        fn into_parts(self) -> SnapshotSourcePartsAreOpaque;
    }

    impl CandidateHasNoRawRootAccessor for WorkspaceCandidate {
        fn root(&self) -> CandidatePathIsOpaque {
            CandidatePathIsOpaque
        }
    }

    impl SnapshotSourceHasNoRawPartsAccessor for WorkspaceSnapshotSource<'_> {
        fn into_parts(self) -> SnapshotSourcePartsAreOpaque {
            SnapshotSourcePartsAreOpaque
        }
    }

    // Inherent methods outrank trait methods, so this compiles only when
    // command-facing opaque values have no raw path accessors.
    let assert_candidate_is_opaque = |candidate: &WorkspaceCandidate| {
        let _: CandidatePathIsOpaque = candidate.root();
    };
    let assert_source_is_opaque = |source: WorkspaceSnapshotSource<'_>| {
        let _: SnapshotSourcePartsAreOpaque = source.into_parts();
    };
    let _ = assert_candidate_is_opaque;
    let _ = assert_source_is_opaque;

    let _: for<'a> fn(WorkspaceSnapshotSource<'a>) -> Result<CapturedWorkspaceSnapshot, String> =
        capture_workspace_snapshot;

    let workspace = tempdir().unwrap();
    fs::write(workspace.path().join("document.md"), "# document").unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let state = AppState::default();

    let response = open_directory_with_ports_inner(
        &state,
        workspace.path(),
        capture_workspace_snapshot,
        |_| Ok(()),
    )
    .unwrap();

    assert_eq!(response.root, canonical_root.to_string_lossy());
    assert_eq!(response.files.len(), 1);
}
