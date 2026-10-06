//! Degraded-mode fallback polling.
use super::native::{spawn_scheduled_reconcile};
use super::*;



pub(super) fn spawn_fallback_polling(app: AppHandle, watch_id: String, health_epoch: u64) {
    let _ = thread::Builder::new()
        .name("mmd-active-document-watch-fallback".to_string())
        .spawn(move || run_fallback_polling(app, watch_id, health_epoch));
}

fn run_fallback_polling(app: AppHandle, watch_id: String, health_epoch: u64) {
    for _ in 0..DEGRADED_POLL_ATTEMPTS {
        thread::sleep(DEGRADED_POLL_INTERVAL);
        let state = app.state::<AppState>();
        let Some(should_continue) = poll_tick_should_continue(&state, &watch_id, health_epoch)
        else {
            return;
        };
        if should_continue {
            spawn_scheduled_reconcile(
                app.clone(),
                watch_id.clone(),
                ScheduledReconcileMode::Event,
            );
        }
    }

    emit_fallback_health_failed(&app, &watch_id, health_epoch);
}

fn poll_tick_should_continue(
    state: &State<AppState>,
    watch_id: &str,
    health_epoch: u64,
) -> Option<bool> {
    let mut watch_state = state.active_document_watch().lock().ok()?;
    let entry = watch_state
        .current
        .as_mut()
        .filter(|entry| entry.watch_id == watch_id)?;
    if !entry.degraded || entry.health_epoch != health_epoch {
        return None;
    }
    if entry.reconcile_scheduled {
        entry.reconcile_again = true;
        Some(false)
    } else {
        entry.reconcile_scheduled = true;
        Some(true)
    }
}

fn emit_fallback_health_failed(app: &AppHandle, watch_id: &str, health_epoch: u64) {
    let state = app.state::<AppState>();
    let stopped_handle = {
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
        if !entry.degraded || entry.health_epoch != health_epoch {
            return;
        }
        entry.sequence =
            increment_safe(entry.sequence, "Watch sequence").unwrap_or(entry.sequence);
        let event = ActiveDocumentWatchEvent {
            protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
            watch_id: entry.watch_id.clone(),
            document_id: entry.document_id.clone(),
            document_generation: entry.document_generation,
            sequence: entry.sequence,
            event: ActiveDocumentWatchEventPayload::Health {
                status: ActiveDocumentWatchHealthStatus::Failed,
                message: "Monitoring stopped. Reopen the file to retry.".to_string(),
            },
        };
        let _ = app.emit_to("main", ACTIVE_DOCUMENT_WATCH_EVENT, event);
        entry.handle.take()
    };
    if let Some(mut handle) = stopped_handle {
        handle.stop();
    }
}
