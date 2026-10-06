use std::{
    collections::{HashMap, HashSet},
    ops::{Deref, DerefMut},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tiny_http::Server;

pub(crate) mod http;
pub(crate) mod prepare;
pub(crate) use prepare::{
    prepare_html_preview, prepare_markdown_html_embed, prepare_media_preview_inner,
    release_markdown_html_embed,
    release_markdown_html_embed_window_inner, release_media_preview_inner,
    prepare_media_preview_with_scope_inner, MediaPreviewHandle,
};
#[cfg(test)]
pub(crate) use prepare::{
    acquire_markdown_html_embed_inner, prepare_html_preview_inner,
    prepare_markdown_html_embed_in_workspace_inner, prepare_markdown_html_embed_inner,
    release_markdown_html_embed_inner,
};

#[cfg(test)]
pub(crate) use http::open_authorized_file_with;

#[cfg(test)]
use crate::path_auth::normalize_existing_path;
use crate::{
    path_auth::{
        retire_preview_leases_inner, AuthorizedPreviewScope, PreviewLeaseId,
        PreviewRetirementError,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
};

const PREVIEW_WORKERS: usize = 4;
const MAX_PREVIEW_SITES: usize = 8;
const MAX_EMBED_OWNER_ID: u64 = 9_007_199_254_740_991;
const MEDIA_ACCESS_TOKEN_QUERY: &str = "mmdMediaToken";
const POISONED_PREVIEW_SITES_ERROR: &str =
    "HTML preview server state was poisoned; all preview sites were stopped";
const PREVIEW_AUTHORIZATION_CHANGED_ERROR: &str =
    "HTML preview authorization changed before the site was committed";

#[cfg(test)]
mod site_start_test_probe {
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum Event {
        LoopbackBindAttempted,
        WorkerSpawnAttempted,
    }

    thread_local! {
        static TRACE: RefCell<Option<Vec<Event>>> = const { RefCell::new(None) };
    }

    pub(super) fn trace<T>(operation: impl FnOnce() -> T) -> (T, Vec<Event>) {
        TRACE.with(|trace| {
            assert!(
                trace.borrow().is_none(),
                "site-start traces cannot be nested"
            );
            *trace.borrow_mut() = Some(Vec::new());
        });
        let result = operation();
        let events = TRACE.with(|trace| {
            trace
                .borrow_mut()
                .take()
                .expect("site-start trace is active")
        });
        (result, events)
    }

    fn record(event: Event) {
        TRACE.with(|trace| {
            if let Some(events) = trace.borrow_mut().as_mut() {
                events.push(event);
            }
        });
    }

    pub(super) fn loopback_bind_attempted() {
        record(Event::LoopbackBindAttempted);
    }

    pub(super) fn worker_spawn_attempted() {
        record(Event::WorkerSpawnAttempted);
    }
}

#[cfg(test)]
pub(crate) mod preview_commit_test_probe {
    use std::cell::RefCell;

    use crate::path_auth::PreviewLeaseId;
    use crate::state::AppState;

    type BeforeCommitOperation = Box<dyn FnOnce(&AppState, &PreviewLeaseId)>;

    thread_local! {
        static BEFORE_COMMIT: RefCell<Option<BeforeCommitOperation>> = RefCell::new(None);
    }

    pub(super) fn before_next_commit(operation: impl FnOnce(&AppState, &PreviewLeaseId) + 'static) {
        BEFORE_COMMIT.with(|pending| {
            assert!(
                pending.borrow().is_none(),
                "preview pre-commit operations cannot be nested"
            );
            *pending.borrow_mut() = Some(Box::new(operation));
        });
    }

    pub(super) fn run(state: &AppState, lease: &PreviewLeaseId) {
        let operation = BEFORE_COMMIT.with(|pending| pending.borrow_mut().take());
        if let Some(operation) = operation {
            operation(state, lease);
        }
    }
}


mod sites;
mod workers;
pub(crate) use sites::*;
pub(crate) use state::*;
mod state;

impl HtmlPreviewSite {
    fn start(scope: AuthorizedPreviewScope, content: HtmlPreviewContent) -> Result<Self, String> {
        let (document, root, lease) = scope.into_parts();
        Self::start_parts(document, root, lease, content)
    }

    fn start_parts(
        document: PathBuf,
        root: PathBuf,
        lease: PreviewLeaseId,
        content: HtmlPreviewContent,
    ) -> Result<Self, String> {
        let media_access_token = new_media_access_token(&document)?;
        let encoded_path = encoded_relative_path(&root, &document)?;
        #[cfg(test)]
        site_start_test_probe::loopback_bind_attempted();
        let server = Arc::new(
            Server::http("127.0.0.1:0")
                .map_err(|err| format!("Failed to start HTML preview server: {err}"))?,
        );
        let address = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "HTML preview server did not bind to an IP address".to_string())?;
        let authority = address.to_string();
        let stop = Arc::new(AtomicBool::new(false));

        workers::spawn_preview_workers(
            &server,
            &root,
            &document,
            &content,
            &stop,
            &authority,
            media_access_token.as_deref(),
        )?;

        Ok(Self {
            url: match media_access_token.as_deref() {
                Some(token) => {
                    format!("http://{address}/{encoded_path}?{MEDIA_ACCESS_TOKEN_QUERY}={token}")
                }
                None => format!("http://{address}/{encoded_path}"),
            },
            root,
            content,
            server,
            stop,
            lease,
        })
    }

    fn update(
        &mut self,
        content: &str,
        lease: PreviewLeaseId,
    ) -> Result<(String, PreviewLeaseId), String> {
        let HtmlPreviewContent::LiveDraft(live_content) = &self.content else {
            return Err("Disk-backed HTML preview cannot be updated in memory".to_string());
        };
        *live_content
            .lock()
            .map_err(|_| "HTML preview state is poisoned".to_string())? = content.to_string();
        Ok(self.replace_lease(lease))
    }

    fn replace_lease(&mut self, lease: PreviewLeaseId) -> (String, PreviewLeaseId) {
        let retired_lease = std::mem::replace(&mut self.lease, lease);
        (self.url.clone(), retired_lease)
    }
}

impl Drop for HtmlPreviewSite {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for _ in 0..PREVIEW_WORKERS {
            self.server.unblock();
        }
    }
}


pub(crate) fn retire_rollback_leases(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    match retire_preview_leases_inner(state, leases) {
        Ok(()) => Ok(()),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            retire_preview_leases_inner(state, leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}



#[cfg(test)]
mod tests {
    mod prelude;
    mod group0_tests;
    mod group1_tests;
    mod group2_tests;
    mod group3_tests;
    mod group4_tests;
    mod group4_helpers;
    mod group5_tests;
    mod group5_helpers;
    mod group6_tests;
    mod group6_helpers;
    mod group7_tests;
}
