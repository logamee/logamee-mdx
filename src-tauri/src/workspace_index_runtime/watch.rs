#[allow(unused_imports)]
use std::{ path::{Path },
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use notify::{ RecursiveMode, Watcher };

#[allow(unused_imports)]
use crate::{ commands::{
        open_directory_without_following_links },
    workspace_index::{build_index, CancellationToken, IndexDocument, WorkspaceIndex},
    workspace_snapshot::{is_excluded_walk_dir, MAX_WORKSPACE_INDEX_WALK_ENTRIES},
};

use super::events::{ event_paths_are_benign_directory_metadata, event_paths_are_relevant_before_publication, event_paths_match_published_index };
use super::{ invalidate_exact_binding, NativeWatchHandle, RuntimeState, WatchHandlePort, WorkspaceIndexScope };

pub(super) fn create_native_watch(
    workspace_root: &Path,
    state: Weak<Mutex<RuntimeState>>,
    scope: WorkspaceIndexScope,
) -> Result<NativeWatchHandle, String> {
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            handle_native_watch_result(&state, &scope, result);
        })
        .map_err(|error| format!("Could not monitor the workspace index: {error}"))?;
    watcher
        .watch(workspace_root, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not monitor the workspace index: {error}"))?;
    Ok(NativeWatchHandle {
        watcher: Some(watcher),
    })
}

pub(super) fn handle_native_watch_result(
    state: &Weak<Mutex<RuntimeState>>,
    scope: &WorkspaceIndexScope,
    result: Result<notify::Event, notify::Error>,
) {
    if invalidate_on_watch_rescan(state, scope, &result) {
        return;
    }
    if watch_result_is_ignorable(scope, &result) {
        return;
    }
    let Some(state) = state.upgrade() else {
        return;
    };
    if let Ok(event) = result {
        if matches!(
            watch_event_verdict(&state, scope, &event),
            WatchVerdict::Ignore
        ) {
            return;
        }
    }
    invalidate_exact_binding(&state, scope, false);
}

fn invalidate_on_watch_rescan(
    state: &Weak<Mutex<RuntimeState>>,
    scope: &WorkspaceIndexScope,
    result: &Result<notify::Event, notify::Error>,
) -> bool {
    if matches!(result, Ok(event) if event.need_rescan()) {
        if let Some(state) = state.upgrade() {
            invalidate_exact_binding(&state, scope, false);
        }
        return true;
    }
    false
}

fn watch_result_is_ignorable(
    scope: &WorkspaceIndexScope,
    result: &Result<notify::Event, notify::Error>,
) -> bool {
    if matches!(result, Ok(event) if event.kind.is_access()) {
        return true;
    }
    matches!(
        result,
        Ok(event) if event_paths_are_benign_directory_metadata(scope, event)
    )
}

enum WatchVerdict {
    Ignore,
    Invalidate,
}

fn watch_event_verdict(
    state: &Mutex<RuntimeState>,
    scope: &WorkspaceIndexScope,
    event: &notify::Event,
) -> WatchVerdict {
    let published_index = {
        let Ok(mut state) = state.lock() else {
            return WatchVerdict::Ignore;
        };
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.scope == *scope)
        else {
            return WatchVerdict::Ignore;
        };
        if let Some(stored) = &active.index {
            Some(Arc::clone(&stored.index))
        } else if event_paths_are_relevant_before_publication(scope, &event.paths) {
            active.dirty_during_build = true;
            return WatchVerdict::Ignore;
        } else {
            None
        }
    };
    if let Some(index) = published_index {
        if event_paths_match_published_index(scope, &index, event) {
            return WatchVerdict::Ignore;
        }
    }
    WatchVerdict::Invalidate
}

pub(super) fn stop_watch(watcher: Option<Box<dyn WatchHandlePort>>) {
    if let Some(mut watcher) = watcher {
        watcher.stop();
    }
}
