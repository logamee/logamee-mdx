
#[cfg(test)]
use std::ops::{Deref, DerefMut};

#[allow(unused_imports)]
#[allow(unused_imports)]
use crate::{
    models::{OpenCommitResult, OpenCommitStatus, RecentFileSummary, RecentFilesSnapshot},
    path_auth::{FileAuthorizationSession, WorkspaceReadAuthorization},
    workspace_file_kind::WorkspaceFileKind,
};

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_RECENT_FILES: usize = 5;
const MAX_PENDING_RECEIPTS: usize = 32;
const PENDING_RECEIPT_TTL: Duration = Duration::from_secs(30);
const MAX_TERMINAL_OUTCOMES: usize = 64;
const TERMINAL_OUTCOME_TTL: Duration = Duration::from_secs(120);
const STORE_FILE_NAME: &str = "recent-files-v1.json";
const LOCK_FILE_NAME: &str = "recent-files-v1.lock";
const STAGING_ATTEMPTS: usize = 8;
const COMMIT_FAILURE_MESSAGE: &str = "The file could not be finalized. Please try again.";
// Windows reports lock contention as ERROR_LOCK_VIOLATION instead of WouldBlock.
const WINDOWS_ERROR_LOCK_VIOLATION: i32 = 33;

pub(crate) fn is_retryable_lock_contention(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && error.raw_os_error() == Some(WINDOWS_ERROR_LOCK_VIOLATION))
}

// Rust 1.89+ std 文件锁以 TryLockError 报错；WouldBlock 与底层 io 错误沿用同一重试判定。
pub(crate) fn is_retryable_try_lock_error(error: &std::fs::TryLockError) -> bool {
    match error {
        std::fs::TryLockError::WouldBlock => true,
        std::fs::TryLockError::Error(io) => is_retryable_lock_contention(io),
    }
}

pub(crate) trait MonotonicClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(crate) struct SystemMonotonicClock {
    started_at: Instant,
}

impl Default for SystemMonotonicClock {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl MonotonicClock for SystemMonotonicClock {
    fn now(&self) -> Duration {
        self.started_at.elapsed()
    }
}

pub(crate) trait OpaqueIdSource: Send + Sync {
    fn next_id(&self) -> Result<String, String>;
}

pub(crate) struct SystemOpaqueIdSource;

impl OpaqueIdSource for SystemOpaqueIdSource {
    fn next_id(&self) -> Result<String, String> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("Cannot generate a recent file identifier: {error}"))?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

pub(crate) trait RecentStoreAtomicReplacer: Send + Sync {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()>;
}

pub(crate) struct SystemRecentStoreAtomicReplacer;

impl RecentStoreAtomicReplacer for SystemRecentStoreAtomicReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        replace_file_atomically(staged, active)
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PersistFault {
    Serialize,
    CreateStagedFile,
    WriteStagedFile,
    SyncStagedFile,
    ReparseStagedFile,
}

pub(crate) struct RecentStore {
    root: PathBuf,
    store_path: PathBuf,
    lock_path: PathBuf,
    replacer: Arc<dyn RecentStoreAtomicReplacer>,
    id_source: Arc<dyn OpaqueIdSource>,
    retry_interval: Duration,
    lock_timeout: Duration,
    #[cfg(test)]
    fail_unlock: bool,
    #[cfg(test)]
    persist_fault: Option<PersistFault>,
}


mod commit;
mod fs_helpers;
mod outcomes;
mod runtime;
mod state;
mod store;
mod store_wire;
#[cfg(test)]
mod test_prelude;
#[cfg(test)]
mod group0_tests;
#[cfg(test)]
mod group1_tests;
#[cfg(test)]
mod group2_tests;
#[cfg(test)]
mod group3_tests;
#[cfg(test)]
mod group4_tests;
#[cfg(test)]
mod group5_helpers;
#[cfg(test)]
mod group5_tests;
#[cfg(test)]
mod group6_tests;

#[allow(unused_imports)]
pub(crate) use store::*;
pub(crate) use store_wire::*;
#[allow(unused_imports)]
pub(crate) use outcomes::*;
pub(crate) use runtime::*;
#[allow(unused_imports)]
pub(crate) use commit::*;
pub(crate) use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
#[allow(unused_imports)]
use crate::private_fs::replace_file_atomically;
pub(crate) use fs_helpers::*;
pub(crate) use state::*;
