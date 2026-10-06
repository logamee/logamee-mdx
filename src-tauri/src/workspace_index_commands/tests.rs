use std::{fs, path::Path};
#[cfg(unix)]
use std::os::unix::fs::symlink;
#[cfg(windows)]
use std::process::Command;
use tempfile::tempdir;

use super::operations::rebuild_authorized_workspace_index;
use crate::path_auth::resolve_authorized_workspace_root_for_token_inner;
use crate::workspace_index::{IndexLimits, IndexQuery};

use super::*;
use crate::{commands::open_directory_inner, path_auth::revoke_authorized_path_prefix_inner};
pub(crate) fn open_workspace(state: &AppState, root: &Path) -> (String, String) {
    let snapshot = open_directory_inner(state, root).unwrap();
    (snapshot.workspace_token, snapshot.root)
}
pub(crate) fn rebuild_without_watch(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
) -> WorkspaceIndexRebuildResponse {
    let workspace = resolve_authorized_workspace_root_for_token_inner(
        state,
        workspace_token,
        workspace_root,
    )
    .unwrap();
    let canonical_root = fs::canonicalize(workspace_root).unwrap();
    let lease = state
        .workspace_index()
        .begin_rebuild_without_watch_for_test(workspace_token, &canonical_root, "build-1")
        .unwrap();
    let _guard = OperationGuard {
        state,
        operation_id: "build-1",
    };
    rebuild_authorized_workspace_index(state, &workspace, &lease).unwrap()
}


#[test]
fn rebuild_and_query_are_bound_to_the_authorized_token_and_root() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("alpha.md"), "search needle").unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());

    let rebuilt = rebuild_without_watch(&state, &token, &root);
    assert_eq!(rebuilt.status, WorkspaceIndexStatus::Ready);
    let response = query_workspace_index_inner(
        &state,
        &token,
        &root,
        "query-1",
        IndexQuery::full_text("needle"),
    )
    .unwrap();
    assert_eq!(response.status, WorkspaceIndexStatus::Ready);
    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].relative_path, "alpha.md");
    assert!(!Path::new(&response.results[0].relative_path).is_absolute());

    let other = tempdir().unwrap();
    let (_, other_root) = open_workspace(&state, other.path());
    assert!(query_workspace_index_inner(
        &state,
        &token,
        &other_root,
        "query-2",
        IndexQuery::filename("alpha"),
    )
    .is_err());
}

#[test]
fn replacement_workspace_token_cannot_read_an_existing_index() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("alpha.md"), "needle").unwrap();
    let state = AppState::default();
    let (first_token, root) = open_workspace(&state, directory.path());
    rebuild_workspace_index_inner(&state, &first_token, &root, "build-1").unwrap();
    let (replacement_token, replacement_root) = open_workspace(&state, directory.path());

    assert!(query_workspace_index_inner(
        &state,
        &replacement_token,
        &replacement_root,
        "query-1",
        IndexQuery::filename("alpha"),
    )
    .is_err());
}

#[test]
fn revoked_workspace_authority_rejects_queries_without_using_stale_paths() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("alpha.md"), "needle").unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());
    rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
    revoke_authorized_path_prefix_inner(&state, Path::new(&root)).unwrap();

    assert!(query_workspace_index_inner(
        &state,
        &token,
        &root,
        "query-1",
        IndexQuery::filename("alpha"),
    )
    .is_err());
    assert!(discard_workspace_index_inner(&state, &token, &root).is_err());
}

#[test]
fn discard_removes_all_results_and_rebuild_is_equivalent() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("alpha.md"), "needle").unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());
    let first = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
    assert!(
        discard_workspace_index_inner(&state, &token, &root)
            .unwrap()
            .discarded
    );
    assert!(query_workspace_index_inner(
        &state,
        &token,
        &root,
        "query-1",
        IndexQuery::filename("alpha"),
    )
    .is_err());
    let second = rebuild_workspace_index_inner(&state, &token, &root, "build-2").unwrap();
    assert_eq!(first.report.corpus_digest, second.report.corpus_digest);
    assert_eq!(first.report.indexed_files, second.report.indexed_files);
}

#[test]
fn cancelled_rebuild_leaves_the_new_generation_without_a_cache() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("alpha.md"), "old needle").unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());
    rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
    fs::write(directory.path().join("alpha.md"), "new content").unwrap();
    let workspace =
        resolve_authorized_workspace_root_for_token_inner(&state, &token, &root).unwrap();
    let canonical_root = fs::canonicalize(&root).unwrap();
    let lease = state
        .workspace_index()
        .begin_rebuild(&token, &canonical_root, "build-2")
        .unwrap();
    lease.cancellation.cancel();
    let cancelled = rebuild_authorized_workspace_index(&state, &workspace, &lease).unwrap();
    assert_eq!(cancelled.status, WorkspaceIndexStatus::Cancelled);
    state.workspace_index().end_operation("build-2");

    assert!(query_workspace_index_inner(
        &state,
        &token,
        &root,
        "query-1",
        IndexQuery::full_text("old needle"),
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn rebuild_skips_unsupported_oversized_and_symlink_sources() {
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(directory.path().join("valid.md"), "needle").unwrap();
    fs::write(directory.path().join("unsupported.html"), "needle").unwrap();
    fs::write(
        directory.path().join("oversized.md"),
        vec![b'x'; IndexLimits::default().max_file_bytes + 1],
    )
    .unwrap();
    fs::write(outside.path().join("escaped.md"), "secret needle").unwrap();
    symlink(
        outside.path().join("escaped.md"),
        directory.path().join("linked.md"),
    )
    .unwrap();
    let state = AppState::default();
    let (token, root) = open_workspace(&state, directory.path());

    let response = rebuild_workspace_index_inner(&state, &token, &root, "build-1").unwrap();
    assert_eq!(response.report.indexed_files, 1);
    assert_eq!(response.report.skipped.unsupported, 1);
    assert_eq!(response.report.skipped.oversized, 1);
    assert_eq!(response.report.input_files, 3);
}
