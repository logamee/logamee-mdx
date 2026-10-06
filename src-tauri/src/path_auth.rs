use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use crate::{
    commands::{
        open_directory_without_following_links, open_regular_file_beneath_directory,
        open_regular_file_without_following_links, opened_file_platform_identity,
    },
    state::AppState,
    workspace_copy::derive_copy_name,
};

const MAX_PENDING_SAVE_AUTHORITIES: usize = 1;
const MAX_PENDING_WORKSPACE_AUTHORITIES: usize = 32;
const PENDING_WORKSPACE_AUTHORITY_TTL: Duration = Duration::from_secs(5 * 60);

pub(crate) mod workspace_snapshot;

#[cfg(test)]
use std::ops::{Deref, DerefMut};

pub(crate) mod mutation;
pub(crate) use mutation::{
    copy_authorized_workspace_entry_inner, move_authorized_workspace_entry_inner,
    rename_authorized_workspace_entry_inner, reveal_authorized_workspace_entry_inner,
    trash_authorized_workspace_entry_inner, invalidate_preview_leases_after_authorization,
};
#[cfg(test)]
pub(crate) use mutation::{
    delete_authorized_workspace_entry_inner, rename_authorized_workspace_entry_with_preview_inner,
    save_document_as_inner, write_authorized_document_inner,
};

pub(crate) mod authorization;
pub(crate) use authorization::{
    authorize_resource_directory_inner,
    ensure_authorized_directory_inner,
    ensure_authorized_existing_file_inner,
    ensure_authorized_watch_file_inner,
    is_authorized_preview_asset_path,
    open_authorized_existing_file_inner,
    open_authorized_existing_file_with_before_open_inner,
    open_exact_workspace_file_for_read_inner,
    preview_lease_support_statuses_inner,
    preview_scope_for_anchored_file_with_root_inner,
    preview_scope_for_file_inner,
    resolve_authorized_workspace_directory_for_token_inner,
    resolve_authorized_workspace_result_file_inner,
    resolve_authorized_workspace_root_for_token_inner,
};
#[cfg(test)]
pub(crate) use authorization::{
    authorize_directory_root_inner,
    authorize_file_inner,
    authorize_saved_file_inner,
    authorize_workspace_file_inner,
    ensure_authorized_write_file_inner,
    is_authorized_image_path,
    preview_scope_for_anchored_file_inner,
};

pub(crate) mod fs_paths;
pub(crate) use fs_paths::{
    canonicalize_existing_path, normalize_existing_path, normalize_file_for_write, path_is_under,
};
#[cfg(test)]
pub(crate) use fs_paths::normalize_parent_for_new_path;

#[derive(Default)]
pub(crate) struct FileAuthorizationSession {
    inner: Mutex<AuthorizationState>,
    #[cfg(test)]
    next_save_publish_error: Mutex<Option<String>>,
    #[cfg(test)]
    next_preview_retirement_error: Mutex<Option<String>>,
    #[cfg(test)]
    next_preview_retirement_unavailable_error: Mutex<Option<String>>,
}

#[cfg(test)]
pub(crate) struct AuthorizationGuard<'a> {
    inner: Option<MutexGuard<'a, AuthorizationState>>,
}

#[cfg(not(test))]
type AuthorizationGuard<'a> = MutexGuard<'a, AuthorizationState>;

#[cfg(test)]
impl<'a> AuthorizationGuard<'a> {
    fn new(inner: MutexGuard<'a, AuthorizationState>) -> Self {
        lock_order_test_probe::authorization_acquired();
        Self { inner: Some(inner) }
    }
}

#[cfg(test)]
impl Deref for AuthorizationGuard<'_> {
    type Target = AuthorizationState;

    fn deref(&self) -> &Self::Target {
        self.inner
            .as_deref()
            .expect("authorization guard is active")
    }
}

#[cfg(test)]
impl DerefMut for AuthorizationGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_deref_mut()
            .expect("authorization guard is active")
    }
}

#[cfg(test)]
impl Drop for AuthorizationGuard<'_> {
    fn drop(&mut self) {
        self.inner.take();
        lock_order_test_probe::authorization_released();
    }
}


#[cfg(test)]
pub(crate) mod lock_probe;
#[cfg(test)]
pub(crate) use lock_probe as lock_order_test_probe;
mod grant_types;
mod outcome_types;
mod prepared;
mod state_impl;
mod session_a;
mod session_b;
mod session_c;
mod session_d;
mod session_e;
mod session_f;
mod session_g;
mod session_h;
mod state_late;
mod state_final;
mod binding_predicates;
mod reservations;
mod workspace_type_impls;
mod grant_ledger_types;
mod grant_mutations;
mod tail_api;
mod workspace_binding;
mod workspace_impls;

pub(crate) use grant_types::*;
pub(crate) use outcome_types::*;
pub(crate) use prepared::*;
pub(crate) use binding_predicates::*;
pub(crate) use reservations::*;
pub(crate) use grant_ledger_types::*;
pub(crate) use grant_mutations::*;
pub(crate) use tail_api::*;
pub(crate) use workspace_binding::*;
pub(crate) use workspace_impls::*;

#[cfg(test)]
mod tests;
