#[allow(unused_imports)]
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use walkdir::WalkDir;

use crate::{
    commands::{
        open_directory_without_following_links, open_regular_file_without_following_links,
        opened_file_platform_identity,
    },
    workspace_file_kind::WorkspaceFileKind,
    workspace_index::{build_index, CancellationToken, IndexDocument, IndexLimits, WorkspaceIndex},
    workspace_snapshot::{is_excluded_walk_dir, MAX_WORKSPACE_INDEX_WALK_ENTRIES},
};

use super::new_deadline_bound_cancellation;
use super::{ WorkspaceIndexScope, WorkspaceIndexLease };

pub(super) fn event_paths_are_benign_directory_metadata(
    scope: &WorkspaceIndexScope,
    event: &notify::Event,
) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
    ) && workspace_root_matches_scope(scope)
        && !event.paths.is_empty()
        && event.paths.iter().all(|path| {
            path.strip_prefix(&scope.workspace_root).is_ok()
                && std::fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        })
}

pub(super) fn event_paths_match_published_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    event: &notify::Event,
) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Create(notify::event::CreateKind::File)
            | notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
            | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
    ) && !event.paths.is_empty()
        && event
            .paths
            .iter()
            .all(|path| event_path_matches_published_index(scope, index, path))
}

pub(super) fn lease_scope(lease: &WorkspaceIndexLease) -> WorkspaceIndexScope {
    WorkspaceIndexScope {
        workspace_token: lease.workspace_token.clone(),
        workspace_root: lease.workspace_root.clone(),
        workspace_root_identity: lease.workspace_root_identity.clone(),
        _workspace_root_handle: Arc::clone(&lease.workspace_root_handle),
        generation: lease.generation,
    }
}

pub(super) fn event_paths_are_relevant_before_publication(
    scope: &WorkspaceIndexScope,
    paths: &[PathBuf],
) -> bool {
    !paths.is_empty()
        && paths.iter().all(|path| {
            path.strip_prefix(&scope.workspace_root).is_ok()
                && match std::fs::symlink_metadata(path) {
                    Ok(metadata) => !metadata.file_type().is_symlink(),
                    Err(_) => true,
                }
        })
}

pub(super) fn workspace_matches_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    lease: Option<&WorkspaceIndexLease>,
) -> bool {
    if !workspace_root_matches_scope(scope) {
        return false;
    }
    let cancellation = lease
        .map(|lease| lease.cancellation.clone())
        .unwrap_or_else(|| new_deadline_bound_cancellation().0);
    let limits = index.limits();
    let Some(markdown_paths) = collect_workspace_markdown_paths(scope, &cancellation) else {
        return false;
    };
    let Some(documents) = collect_workspace_documents(markdown_paths, &limits, &cancellation)
    else {
        return false;
    };

    workspace_root_matches_scope(scope)
        && build_index(documents, limits, &cancellation)
            .completed()
            .is_some_and(|(rebuilt, _)| index.has_same_exact_documents(&rebuilt))
}

fn collect_workspace_markdown_paths(
    scope: &WorkspaceIndexScope,
    cancellation: &CancellationToken,
) -> Option<Vec<(String, PathBuf)>> {
    let mut markdown_paths = Vec::new();
    let entries = WalkDir::new(&scope.workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_excluded_walk_dir(entry.path()));
    let mut walked_entries = 0usize;
    for entry in entries {
        if cancellation.is_cancelled() {
            return None;
        }
        let Ok(entry) = entry else {
            return None;
        };
        if entry.depth() == 0 {
            continue;
        }
        walked_entries = walked_entries.saturating_add(1);
        if walked_entries > MAX_WORKSPACE_INDEX_WALK_ENTRIES {
            return None;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&scope.workspace_root) else {
            return None;
        };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if WorkspaceFileKind::classify(Path::new(&relative_path))
            != Some(WorkspaceFileKind::Markdown)
        {
            continue;
        }
        markdown_paths.push((relative_path, entry.into_path()));
    }
    markdown_paths.sort_by(|left, right| left.0.cmp(&right.0));
    Some(markdown_paths)
}

enum WorkspaceDocumentRead {
    Skip,
    Document(IndexDocument),
}

fn read_workspace_document(
    path: &Path,
    relative_path: &str,
    limits: &IndexLimits,
    aggregate_bytes: usize,
) -> WorkspaceDocumentRead {
    let Ok(file) = open_regular_file_without_following_links(path) else {
        return WorkspaceDocumentRead::Skip;
    };
    let Ok(metadata) = file.metadata() else {
        return WorkspaceDocumentRead::Skip;
    };
    let file_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if file_bytes > limits.max_file_bytes
        || aggregate_bytes.saturating_add(file_bytes) > limits.max_aggregate_bytes
    {
        return WorkspaceDocumentRead::Skip;
    }
    let mut bytes = Vec::with_capacity(file_bytes.min(limits.max_file_bytes));
    let mut bounded = file.take((limits.max_file_bytes as u64).saturating_add(1));
    if bounded.read_to_end(&mut bytes).is_err() || bytes.len() > limits.max_file_bytes {
        return WorkspaceDocumentRead::Skip;
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return WorkspaceDocumentRead::Skip;
    };
    if aggregate_bytes.saturating_add(content.len()) > limits.max_aggregate_bytes {
        return WorkspaceDocumentRead::Skip;
    }
    WorkspaceDocumentRead::Document(IndexDocument {
        relative_path: relative_path.to_owned(),
        content,
    })
}

fn collect_workspace_documents(
    markdown_paths: Vec<(String, PathBuf)>,
    limits: &IndexLimits,
    cancellation: &CancellationToken,
) -> Option<Vec<IndexDocument>> {
    let mut documents = Vec::new();
    let mut eligible_files = 0usize;
    let mut aggregate_bytes = 0usize;
    for (relative_path, path) in markdown_paths {
        if cancellation.is_cancelled() {
            return None;
        }
        if eligible_files >= limits.max_files {
            continue;
        }
        eligible_files = eligible_files.saturating_add(1);
        match read_workspace_document(&path, &relative_path, limits, aggregate_bytes) {
            WorkspaceDocumentRead::Document(document) => {
                aggregate_bytes = aggregate_bytes.saturating_add(document.content.len());
                documents.push(document);
            }
            WorkspaceDocumentRead::Skip => {}
        }
    }
    Some(documents)
}

pub(super) fn event_path_matches_published_index(
    scope: &WorkspaceIndexScope,
    index: &WorkspaceIndex,
    path: &Path,
) -> bool {
    let Ok(relative) = path.strip_prefix(&scope.workspace_root) else {
        return false;
    };
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    if relative.components().any(|component| match component {
        std::path::Component::Normal(name) => is_excluded_walk_dir(Path::new(name)),
        _ => false,
    }) {
        return true;
    }
    if metadata.is_dir() {
        return false;
    }
    if !metadata.is_file() {
        return false;
    }
    let relative_path = relative.to_string_lossy().replace('\\', "/");
    if WorkspaceFileKind::classify(Path::new(&relative_path)) != Some(WorkspaceFileKind::Markdown) {
        return metadata.is_file();
    }
    let Some(expected) = index.exact_content_for_relative_path(&relative_path) else {
        return false;
    };
    file_matches_expected_content(path, expected, index.max_file_bytes())
}

pub(super) fn file_matches_expected_content(path: &Path, expected: &str, max_file_bytes: usize) -> bool {
    let Ok(file) = open_regular_file_without_following_links(path) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(expected.len().min(max_file_bytes));
    let mut bounded = file.take((max_file_bytes as u64).saturating_add(1));
    bounded.read_to_end(&mut bytes).is_ok() && bytes == expected.as_bytes()
}

pub(super) fn workspace_root_matches_scope(scope: &WorkspaceIndexScope) -> bool {
    open_directory_without_following_links(&scope.workspace_root)
        .and_then(|directory| opened_file_platform_identity(&directory))
        .is_ok_and(|identity| identity == scope.workspace_root_identity)
}
