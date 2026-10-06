//! Native watcher, debouncer and scheduled reconcile plumbing.
use super::disk::{finalize_authorization_transition, resolve_disk_state};
use super::*;


pub(super) fn create_native_debouncer<F: DebounceEventHandler>(
    parent: &Path,
    event_handler: F,
) -> Result<NativeWatchHandle, String> {
    let mut debouncer = new_debouncer(DEBOUNCE_DURATION, None, event_handler)
        .map_err(|_| "Could not start monitoring this file".to_string())?;
    debouncer
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|_| "Could not start monitoring this file".to_string())?;
    Ok(NativeWatchHandle {
        debouncer: Some(debouncer),
    })
}

pub(super) fn create_native_handle(
    app: AppHandle,
    watch_id: String,
    parent: &Path,
) -> Result<Box<dyn WatchHandlePort>, String> {
    let callback_watch_id = watch_id.clone();
    let handle = create_native_debouncer(parent, move |result: DebounceEventResult| {
        handle_native_watch_result(app.clone(), callback_watch_id.clone(), result);
    })?;
    Ok(Box::new(handle))
}

pub(super) fn handle_native_watch_result(app: AppHandle, watch_id: String, result: DebounceEventResult) {
    let state = app.state::<AppState>();
    match result {
        Ok(events) => {
            let mut paths = Vec::new();
            let mut rename_candidates = Vec::new();
            let mut force_reconcile = false;
            for event in events {
                force_reconcile |= event.need_rescan();
                paths.extend(event.paths.iter().cloned());
                if matches!(
                    event.kind,
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both))
                ) && event.paths.len() >= 2
                {
                    rename_candidates.push((
                        event.paths[0].clone(),
                        event.paths[event.paths.len() - 1].clone(),
                    ));
                }
            }
            if state
                .active_document_watch()
                .note_native_hint(&watch_id, &paths, rename_candidates, force_reconcile)
                .unwrap_or(false)
            {
                spawn_scheduled_reconcile(app.clone(), watch_id, ScheduledReconcileMode::Event);
            }
        }
        Err(_) => {
            let _ = state
                .active_document_watch()
                .note_native_error(&app, &watch_id);
        }
    }
}

pub(super) fn spawn_scheduled_reconcile(app: AppHandle, watch_id: String, mode: ScheduledReconcileMode) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-reconcile".to_string())
        .spawn(move || run_scheduled_reconcile(app, watch_id, mode));
}

pub(super) fn schedule_missing_confirmation(app: AppHandle, watch_id: String, token: u64) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-missing-grace".to_string())
        .spawn(move || {
            thread::sleep(MISSING_GRACE);
            let state = app.state::<AppState>();
            let should_run = {
                let Ok(mut watch_state) = state.active_document_watch().lock() else {
                    return;
                };
                let Some(entry) = watch_state
                    .current
                    .as_mut()
                    .filter(|entry| entry.watch_id == watch_id)
                else {
                    return;
                };
                if !entry.missing_pending || entry.missing_token != token {
                    return;
                }
                if entry.reconcile_scheduled {
                    entry.reconcile_again = true;
                    false
                } else {
                    entry.reconcile_scheduled = true;
                    true
                }
            };
            if should_run {
                spawn_scheduled_reconcile(
                    app,
                    watch_id,
                    ScheduledReconcileMode::MissingConfirmation { token },
                );
            }
        });
}

pub(super) fn run_scheduled_reconcile(app: AppHandle, watch_id: String, mode: ScheduledReconcileMode) {
    let state = app.state::<AppState>();
    let service = state.active_document_watch();
    let Ok(lane) = service.lock_lane() else {
        return;
    };
    let Ok(Some(context)) = service.capture_scheduled_context(&watch_id, mode) else {
        return;
    };
    let resolved = resolve_disk_state(&state, &context);
    let follow_up;
    let mut missing_timer = None;
    {
        let Ok(mut watch_state) = service.lock() else {
            return;
        };
        let Some(entry) = watch_state.current.as_mut().filter(|entry| {
            entry.watch_id == context.watch_id
                && entry.document_id == context.document_id
                && entry.document_generation == context.document_generation
        }) else {
            return;
        };
        if entry.write_epoch != context.write_epoch
            || matches!(entry.write_expectation, AppWriteExpectation::Writing { .. })
        {
            follow_up = ActiveDocumentWatchState::mark_scheduled_stale(entry);
        } else {
            match resolved {
                Err(_) => {
                    follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                }
                Ok(ResolvedDisk::Missing) if matches!(mode, ScheduledReconcileMode::Event) => {
                    if let Ok(token) = ActiveDocumentWatchState::begin_missing_grace(entry) {
                        missing_timer = Some(token);
                    }
                    follow_up = ActiveDocumentWatchState::finish_scheduled(entry);
                }
                Ok(mut resolved) => {
                    follow_up = apply_resolved_disk(&state, &app, entry, &mut resolved);
                }
            }
        }
    }
    drop(lane);
    schedule_reconcile_follow_up(app, watch_id, missing_timer, follow_up);
}

fn schedule_reconcile_follow_up(
    app: AppHandle,
    watch_id: String,
    missing_timer: Option<u64>,
    follow_up: bool,
) {
    if let Some(token) = missing_timer {
        schedule_missing_confirmation(app.clone(), watch_id.clone(), token);
    }
    if follow_up {
        spawn_scheduled_reconcile(app, watch_id, ScheduledReconcileMode::Event);
    }
}

fn apply_resolved_disk(
    state: &State<AppState>,
    app: &AppHandle,
    entry: &mut WatchEntry,
    resolved: &mut ResolvedDisk,
) -> bool {
    if matches!(resolved, ResolvedDisk::Present { .. }) {
        let _ = ActiveDocumentWatchState::cancel_missing_grace(entry);
    }
    if finalize_authorization_transition(state, entry, resolved).is_err() {
        return ActiveDocumentWatchState::finish_scheduled(entry);
    }
    let suppression_match = ActiveDocumentWatchState::committed_write_matches(entry, resolved);
    let settled = ActiveDocumentWatchState::settle_snapshot(entry, resolved);
    if let Ok((snapshot, reason, previous_path)) = settled {
        let duplicate = entry.last_snapshot.as_ref().is_some_and(|last| {
            ActiveDocumentWatchState::snapshot_content_matches(last, &snapshot)
        }) && !matches!(
            entry.file_kind,
            WorkspaceFileKind::Image
                | WorkspaceFileKind::Video
                | WorkspaceFileKind::Audio
        );
        let _ = ActiveDocumentWatchState::clear_committed_expectation(entry);
        if suppression_match || duplicate {
            if let ActiveDocumentDiskSnapshot::Present {
                preview_revision,
                ..
            } = &snapshot
            {
                entry.preview_revision = *preview_revision;
            }
            entry.last_snapshot = Some(snapshot);
        } else {
            record_emitted_state_snapshot(app, entry, snapshot, reason, previous_path);
        }
    }
    ActiveDocumentWatchState::finish_scheduled(entry)
}

fn record_emitted_state_snapshot(
    app: &AppHandle,
    entry: &mut WatchEntry,
    snapshot: ActiveDocumentDiskSnapshot,
    reason: ActiveDocumentWatchReason,
    previous_path: Option<String>,
) {
    if let ActiveDocumentDiskSnapshot::Present {
        preview_revision,
        ..
    } = &snapshot
    {
        entry.preview_revision = *preview_revision;
    }
    entry.sequence =
        increment_safe(entry.sequence, "Watch sequence").unwrap_or(entry.sequence);
    entry.last_snapshot = Some(snapshot.clone());
    let event = ActiveDocumentWatchEvent {
        protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
        watch_id: entry.watch_id.clone(),
        document_id: entry.document_id.clone(),
        document_generation: entry.document_generation,
        sequence: entry.sequence,
        event: ActiveDocumentWatchEventPayload::State {
            reason,
            previous_path,
            snapshot,
        },
    };
    let _ = app.emit_to("main", ACTIVE_DOCUMENT_WATCH_EVENT, event);
}
