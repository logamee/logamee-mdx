//! Preview request workers spawned for a started preview site.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use tiny_http::Server;

use super::http::route_request;
use super::{HtmlPreviewContent, PREVIEW_WORKERS};

pub(super) fn spawn_preview_workers(
    server: &Arc<Server>,
    root: &Path,
    document: &Path,
    content: &HtmlPreviewContent,
    stop: &Arc<AtomicBool>,
    authority: &str,
    media_access_token: Option<&str>,
) -> Result<(), String> {
    for worker_index in 0..PREVIEW_WORKERS {
        let worker_server = Arc::clone(server);
        let worker_root = root.to_path_buf();
        let worker_document = document.to_path_buf();
        let worker_content = content.clone();
        let worker_stop = Arc::clone(stop);
        let worker_authority = authority.to_string();
        let worker_media_access_token = media_access_token.map(str::to_string);
        let worker_builder =
            thread::Builder::new().name(format!("mmd-html-preview-{worker_index}"));
        #[cfg(test)]
        super::site_start_test_probe::worker_spawn_attempted();
        let spawn_result = worker_builder.spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match worker_server.recv_timeout(Duration::from_millis(250)) {
                    Ok(Some(request)) => route_request(
                        request,
                        &worker_authority,
                        &worker_root,
                        &worker_document,
                        &worker_content,
                        worker_media_access_token.as_deref(),
                    ),
                    Ok(None) => {}
                    Err(_) if worker_stop.load(Ordering::Acquire) => break,
                    Err(_) => {}
                }
            }
        });
        if let Err(err) = spawn_result {
            stop.store(true, Ordering::Release);
            for _ in 0..PREVIEW_WORKERS {
                server.unblock();
            }
            return Err(format!("Failed to run HTML preview server: {err}"));
        }
    }
    Ok(())
}
