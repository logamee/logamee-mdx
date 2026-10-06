//! Shared recent-files test imports.
#[allow(unused_imports)]
pub(crate) use std::{
    collections::{HashSet, VecDeque},
    env,
    fs::{self, OpenOptions},
    io,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
pub(crate) use serde_json::json;
pub(crate) use tempfile::tempdir;
pub(crate) use super::{
    is_retryable_lock_contention, serialize_complete_store, MonotonicClock,
    OpaqueIdSource, RecentFileStoreV1, RecentFilesState,
    RecentStore, RecentStoreAtomicReplacer, SystemRecentStoreAtomicReplacer,
};
pub(crate) use crate::{
    models::{OpenCommitResult, RecentFilesSnapshot},
    path_auth::{
        authorize_directory_root_inner, ensure_authorized_existing_file_inner,
        ensure_authorized_write_file_inner, is_authorized_image_path,
        open_authorized_existing_file_inner, FileAuthorizationSession,
    },
    state::AppState,
};
pub(crate) const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub(crate) const ID_C: &str = "cccccccccccccccccccccccccccccccc";
pub(crate) const ID_D: &str = "dddddddddddddddddddddddddddddddd";
pub(crate) const ID_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
pub(crate) const ID_F: &str = "ffffffffffffffffffffffffffffffff";
pub(crate) fn absolute_path(relative: impl AsRef<Path>) -> String {
    #[cfg(windows)]
    let root = Path::new(r"C:\");
    #[cfg(not(windows))]
    let root = Path::new("/");
    root.join(relative).to_string_lossy().into_owned()
}

pub(crate) fn load_strict_store(store: &RecentStore) -> RecentFileStoreV1 {
    let persisted: RecentFileStoreV1 =
        serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
    assert!(serialize_complete_store(&persisted).is_ok());
    persisted
}

pub(crate) fn store_with(
    root: PathBuf,
    replacer: Arc<dyn RecentStoreAtomicReplacer>,
    retry_interval: Duration,
    lock_timeout: Duration,
) -> RecentStore {
    RecentStore::with_ports(
        root,
        replacer,
        Arc::new(SequenceIdSource::new((1..=32).map(opaque_id))),
        retry_interval,
        lock_timeout,
    )
}

pub(crate) fn assert_child_success(child: Child) {
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "child failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

pub(crate) fn commit_document(
    recent: &RecentFilesState,
    owner_window: &str,
    document: &Path,
    authorization: &FileAuthorizationSession,
) -> RecentFilesSnapshot {
    let identifiers = recent.issue_open(owner_window, document).unwrap();
    match recent
        .commit_open(&identifiers.open_receipt, owner_window, authorization)
        .unwrap()
    {
        OpenCommitResult::Committed { recent_files } => recent_files,
        OpenCommitResult::NotCommitted { message } => {
            panic!("test setup commit failed: {message}")
        }
    }
}

pub(crate) fn state_with(root: PathBuf, replacer: Arc<dyn RecentStoreAtomicReplacer>) -> RecentFilesState {
    state_with_ids(root, replacer, (1..=128).map(opaque_id))
}

pub(crate) struct PausingReplacer {
    pause_next: AtomicBool,
    entered: Sender<()>,
    release: Mutex<Receiver<()>>,
}
impl PausingReplacer {
    pub(crate) fn new() -> (Arc<Self>, Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        (
            Arc::new(Self {
                pause_next: AtomicBool::new(false),
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            entered_rx,
            release_tx,
        )
    }

    pub(crate) fn pause_next_replacement(&self) {
        self.pause_next.store(true, Ordering::SeqCst);
    }
}
impl RecentStoreAtomicReplacer for PausingReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        if self.pause_next.swap(false, Ordering::SeqCst) {
            self.entered
                .send(())
                .map_err(|_| io::Error::other("replacement entry receiver dropped"))?;
            self.release
                .lock()
                .map_err(|_| io::Error::other("replacement release gate poisoned"))?
                .recv()
                .map_err(|_| io::Error::other("replacement release sender dropped"))?;
        }
        SystemRecentStoreAtomicReplacer.replace_complete_image(staged, active)
    }
}

pub(crate) fn state_with_ids(
    root: PathBuf,
    replacer: Arc<dyn RecentStoreAtomicReplacer>,
    ids: impl IntoIterator<Item = String>,
) -> RecentFilesState {
    let ids: Arc<dyn OpaqueIdSource> = Arc::new(SequenceIdSource::new(ids));
    let store = RecentStore::with_ports(
        root,
        replacer,
        Arc::clone(&ids),
        Duration::from_millis(1),
        Duration::from_millis(100),
    );
    RecentFilesState::with_ports(store, ids, Arc::new(TestClock::default()))
}

pub(crate) fn wait_for_optional_child_start_gate() {
    let Some(start_path) = env::var_os("MMD_RECENT_FILES_CHILD_START") else {
        return;
    };
    let ready_path = PathBuf::from(env::var_os("MMD_RECENT_FILES_CHILD_READY").unwrap());
    fs::write(ready_path, b"ready").unwrap();
    wait_until_created(Path::new(&start_path));
}

pub(crate) fn wait_until_created(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "child process did not become ready"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn spawn_gated_child(command: &mut Command, ready_path: &Path, start_path: &Path) -> Child {
    command
        .env("MMD_RECENT_FILES_CHILD_READY", ready_path)
        .env("MMD_RECENT_FILES_CHILD_START", start_path)
        .spawn()
        .unwrap()
}

pub(crate) struct PausingRollbackFailingReplacer {
    calls: AtomicUsize,
    entered: Sender<()>,
    release: Mutex<Receiver<()>>,
}
impl PausingRollbackFailingReplacer {
    pub(crate) fn new() -> (Arc<Self>, Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        (
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            entered_rx,
            release_tx,
        )
    }
}
impl RecentStoreAtomicReplacer for PausingRollbackFailingReplacer {
    fn replace_complete_image(&self, staged: &Path, active: &Path) -> io::Result<()> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                self.entered
                    .send(())
                    .map_err(|_| io::Error::other("replacement entry receiver dropped"))?;
                self.release
                    .lock()
                    .map_err(|_| io::Error::other("replacement release gate poisoned"))?
                    .recv()
                    .map_err(|_| io::Error::other("replacement release sender dropped"))?;
                SystemRecentStoreAtomicReplacer.replace_complete_image(staged, active)
            }
            _ => Err(io::Error::other("injected rollback replacement failure")),
        }
    }
}

pub(crate) fn opaque_id(value: usize) -> String {
    format!("{value:032x}")
}

pub(crate) fn recent_files_child_command(action: &str, root: &Path) -> Command {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .arg("--exact")
        .arg("recent_files::group2_tests::recent_files_child_process_harness")
        .arg("--nocapture")
        .env("MMD_RECENT_FILES_CHILD_ACTION", action)
        .env("MMD_RECENT_FILES_CHILD_ROOT", root);
    command
}

pub(crate) struct SequenceIdSource {
    ids: Mutex<VecDeque<String>>,
}
impl SequenceIdSource {
    pub(crate) fn new(ids: impl IntoIterator<Item = String>) -> Self {
        Self {
            ids: Mutex::new(ids.into_iter().collect()),
        }
    }
}
impl OpaqueIdSource for SequenceIdSource {
    fn next_id(&self) -> Result<String, String> {
        self.ids
            .lock()
            .map_err(|_| "test ID source is poisoned".to_string())?
            .pop_front()
            .ok_or_else(|| "test ID source is exhausted".to_string())
    }
}

#[derive(Default)]
struct TestClock {
    now: Mutex<Duration>,
}
impl MonotonicClock for TestClock {
    fn now(&self) -> Duration {
        *self.now.lock().unwrap()
    }
}

pub(crate) struct FailingReplacer;
impl RecentStoreAtomicReplacer for FailingReplacer {
    fn replace_complete_image(&self, _staged: &Path, _active: &Path) -> io::Result<()> {
        Err(io::Error::other("injected replacement failure"))
    }
}
