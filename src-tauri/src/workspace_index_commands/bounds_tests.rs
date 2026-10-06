use crate::workspace_index::QueryKind;
use crate::workspace_snapshot::{capture_workspace_index_snapshot, WorkspaceIndexSnapshotCapture};
#[cfg(unix)]
use std::os::unix::fs::symlink;
#[cfg(windows)]
use std::process::Command;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::tempdir;

use crate::path_auth::resolve_authorized_workspace_root_for_token_inner;
use crate::workspace_index::{CancellationToken, IndexDocument, IndexLimits, IndexQuery};

use super::tests::open_workspace;
use super::*;

#[cfg(unix)]
fn replace_directory_with_link(link: &Path, target: &Path) {
    symlink(target, link).unwrap();
}
#[cfg(windows)]
fn replace_directory_with_link(link: &Path, target: &Path) {
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .unwrap();
    assert!(status.success(), "failed to create test junction");
}
#[test]
fn operation_cancellation_and_result_limits_are_bounded() {
    let state = AppState::default();
    assert_cancelled_rebuild_operation_cannot_be_reused(&state);
    assert_pre_cancelled_collection_and_build_report_nothing(&state);
    assert_rebuilt_results_are_capped_at_max_results(&state);
}

fn assert_cancelled_rebuild_operation_cannot_be_reused(state: &AppState) {
    let cancellation_root = tempdir().unwrap();
    fs::write(cancellation_root.path().join("cancel.md"), "needle").unwrap();
    let (cancellation_token, cancellation_root) = open_workspace(state, cancellation_root.path());
    let cancellation = state
        .workspace_index()
        .begin_rebuild(
            &cancellation_token,
            &fs::canonicalize(&cancellation_root).unwrap(),
            "cancel-me",
        )
        .unwrap();
    assert!(state
        .workspace_index()
        .cancel_operation("cancel-me")
        .unwrap());
    assert!(cancellation.cancellation.is_cancelled());
    state.workspace_index().end_operation("cancel-me");
    assert!(!state
        .workspace_index()
        .cancel_operation("cancel-me")
        .unwrap());
    assert!(state
        .workspace_index()
        .begin_rebuild(
            &cancellation_token,
            &fs::canonicalize(&cancellation_root).unwrap(),
            "",
        )
        .is_err());
}

fn assert_pre_cancelled_collection_and_build_report_nothing(state: &AppState) {
    let cancelled_directory = tempdir().unwrap();
    fs::write(cancelled_directory.path().join("cancelled.md"), "needle").unwrap();
    let (cancelled_token, cancelled_root) = open_workspace(state, cancelled_directory.path());
    let cancelled_workspace =
        resolve_authorized_workspace_root_for_token_inner(state, &cancelled_token, &cancelled_root)
            .unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let collected = collect_documents(
        state,
        &cancelled_workspace,
        &cancelled,
        IndexLimits::default(),
    )
    .unwrap();
    assert!(collected.cancelled);
    assert!(
        build_collected_documents(collected.documents, IndexLimits::default(), &cancelled)
            .is_cancelled()
    );

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let outcome = build_collected_documents(
        vec![IndexDocument {
            relative_path: "should-not-index.md".to_string(),
            content: "needle".repeat(10_000),
        }],
        IndexLimits::default(),
        &cancelled,
    );
    assert!(outcome.is_cancelled());
    assert_eq!(outcome.report().indexed_files, 0);
    assert_eq!(outcome.report().indexed_bytes, 0);
}

fn assert_rebuilt_results_are_capped_at_max_results(state: &AppState) {
    let directory = tempdir().unwrap();
    for index in 0..105 {
        fs::write(directory.path().join(format!("note-{index}.md")), "needle").unwrap();
    }
    let (token, root) = open_workspace(state, directory.path());
    let rebuilt = rebuild_workspace_index_inner(state, &token, &root, "build-1").unwrap();
    assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);
    let response = query_workspace_index_inner(
        state,
        &token,
        &root,
        "query-1",
        IndexQuery {
            kind: QueryKind::FullText,
            text: "needle".to_string(),
        },
    )
    .unwrap();
    assert_eq!(response.results.len(), IndexLimits::default().max_results);
    assert!(response.truncated);
}

#[cfg(unix)]
#[test]
fn search_result_open_rechecks_the_exact_workspace_scope() {
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let nested = directory.path().join("nested");
    fs::create_dir(&nested).unwrap();
    let document = nested.join("note.md");
    fs::write(&document, "needle").unwrap();
    let outside_document = outside.path().join("outside.md");
    fs::write(&outside_document, "outside").unwrap();
    symlink(&outside_document, directory.path().join("escaped.md")).unwrap();
    let state = AppState::default();
    let app_data = tempdir().unwrap();
    state
        .initialize_recent_files(app_data.path().to_path_buf())
        .unwrap();
    let (token, root) = open_workspace(&state, directory.path());
    let rebuilt = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
    assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);

    let prepared = open_workspace_index_result_inner(
        &state,
        "main",
        &token,
        &root,
        rebuilt.index_generation,
        "nested/note.md",
    )
    .unwrap();
    assert_eq!(
        prepared.file.path,
        fs::canonicalize(document).unwrap().to_string_lossy()
    );

    assert_search_opens_stay_within_the_authorized_workspace(
        &state,
        &token,
        &root,
        rebuilt.index_generation,
    );
}

fn assert_search_opens_stay_within_the_authorized_workspace(
    state: &AppState,
    token: &str,
    root: &str,
    index_generation: u64,
) {
    for relative_path in ["../outside.md", "/tmp/outside.md", "escaped.md"] {
        assert!(open_workspace_index_result_inner(
            state,
            "main",
            token,
            root,
            index_generation,
            relative_path,
        )
        .is_err());
    }

    let other = tempdir().unwrap();
    let (_, other_root) = open_workspace(state, other.path());
    assert!(open_workspace_index_result_inner(
        state,
        "main",
        token,
        &other_root,
        index_generation,
        "nested/note.md",
    )
    .is_err());
}

#[cfg(any(unix, windows))]
#[test]
fn collection_refuses_a_parent_link_swap_after_authorization() {
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let nested = directory.path().join("nested");
    let moved = directory.path().join("nested-original");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("note.md"), "authorized content").unwrap();
    fs::write(outside.path().join("note.md"), "external secret needle").unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
    let files =
        match capture_workspace_index_snapshot(&workspace, &CancellationToken::new()).unwrap() {
            WorkspaceIndexSnapshotCapture::Completed(snapshot) => {
                snapshot.into_index_files(&workspace).unwrap()
            }
            WorkspaceIndexSnapshotCapture::Cancelled => panic!("snapshot must complete"),
        };
    let mut swapped = false;

    let collected = collect_snapshot_files_with_before_open(
        &state,
        &workspace,
        files,
        &CancellationToken::new(),
        IndexLimits::default(),
        |_| {
            if !swapped {
                fs::rename(&nested, &moved).unwrap();
                replace_directory_with_link(&nested, outside.path());
                swapped = true;
            }
        },
    )
    .unwrap();

    assert!(swapped);
    assert_eq!(collected.read_errors, 1);
    assert!(collected.documents.is_empty());
}

#[test]
fn collection_remains_bound_to_the_authorized_root_object_after_replacement() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let displaced = directory.path().join("workspace-original");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), "authorized content").unwrap();
    let state = AppState::default();
    let (token, canonical_root) = open_workspace(&state, &root);
    let canonical_root_path = PathBuf::from(&canonical_root);
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(&state, &token, &canonical_root).unwrap();
    let files =
        match capture_workspace_index_snapshot(&workspace, &CancellationToken::new()).unwrap() {
            WorkspaceIndexSnapshotCapture::Completed(snapshot) => {
                snapshot.into_index_files(&workspace).unwrap()
            }
            WorkspaceIndexSnapshotCapture::Cancelled => panic!("snapshot must complete"),
        };
    let mut replaced = false;

    let result = collect_snapshot_files_with_before_open(
        &state,
        &workspace,
        files,
        &CancellationToken::new(),
        IndexLimits::default(),
        |_| {
            if !replaced {
                fs::rename(&canonical_root_path, &displaced).unwrap();
                fs::create_dir(&canonical_root_path).unwrap();
                fs::write(
                    canonical_root_path.join("note.md"),
                    "external secret needle",
                )
                .unwrap();
                replaced = true;
            }
        },
    );

    assert!(replaced);
    let collected = result.unwrap();
    assert_eq!(collected.documents.len(), 1);
    assert_eq!(collected.documents[0].content, "authorized content");
}
