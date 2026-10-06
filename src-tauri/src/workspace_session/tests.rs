use std::{
    fs,
    fs::OpenOptions,
    io,
    path::Path,
    time::{Duration, Instant},
};

use serde_json::json;
use tempfile::tempdir;

use super::{
    WorkspaceSessionAtomicReplacer, WorkspaceSessionRecord, WorkspaceSessionStore,
    MAX_STORE_BYTES, STORE_FILE_NAME,
};

struct FailingReplacer;

impl WorkspaceSessionAtomicReplacer for FailingReplacer {
    fn replace_complete_image(&self, _staged: &Path, _active: &Path) -> io::Result<()> {
        Err(io::Error::other("injected replacement failure"))
    }
}

fn absolute_path(relative: impl AsRef<Path>) -> String {
    #[cfg(windows)]
    let root = Path::new(r"C:\");
    #[cfg(not(windows))]
    let root = Path::new("/");

    root.join(relative).to_string_lossy().into_owned()
}


#[test]
fn save_and_recreate_store_preserves_the_versioned_canonical_paths() {
    let directory = tempdir().unwrap();
    let store = WorkspaceSessionStore::new(directory.path().to_path_buf());
    let workspace_root = absolute_path("workspace");
    let active_path = absolute_path("workspace/notes.md");
    let record = WorkspaceSessionRecord::new(workspace_root.clone(), Some(active_path.clone()));

    store.save(&record).unwrap();

    let recreated = WorkspaceSessionStore::new(directory.path().to_path_buf());
    assert_eq!(recreated.load().unwrap(), Some(record));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(directory.path().join(STORE_FILE_NAME)).unwrap()
        )
        .unwrap(),
        json!({
            "version": 1,
            "workspace_root": workspace_root,
            "active_path": active_path,
        })
    );
}

#[test]
fn corrupt_oversized_and_unknown_version_records_are_cleared() {
    let mut valid_record_with_padding = serde_json::to_vec(&WorkspaceSessionRecord::new(
        absolute_path("workspace"),
        None,
    ))
    .unwrap();
    let padding = MAX_STORE_BYTES + 1 - valid_record_with_padding.len();
    valid_record_with_padding.extend(vec![b' '; padding]);
    let records = vec![
        br#"not json"#.to_vec(),
        br#"{\"version\":2,\"workspace_root\":\"/workspace\",\"active_path\":null}"#.to_vec(),
        br#"{\"version\":1,\"workspace_root\":\"relative\",\"active_path\":null}"#.to_vec(),
        br#"{\"version\":1,\"workspace_root\":\"/workspace\",\"active_path\":null,\"extra\":true}"#.to_vec(),
        vec![b'x'; MAX_STORE_BYTES + 1],
        valid_record_with_padding,
    ];
    for bytes in records {
        let directory = tempdir().unwrap();
        let store = WorkspaceSessionStore::new(directory.path().to_path_buf());
        fs::write(store.store_path(), bytes).unwrap();

        assert_eq!(store.load().unwrap(), None);
        assert!(!store.store_path().exists());
    }
}

#[test]
fn failed_persistence_keeps_the_last_complete_session_image() {
    let directory = tempdir().unwrap();
    let original = WorkspaceSessionRecord::new(
        absolute_path("workspace"),
        Some(absolute_path("workspace/notes.md")),
    );
    let replacement = WorkspaceSessionRecord::new(
        absolute_path("other-workspace"),
        Some(absolute_path("other-workspace/next.md")),
    );
    let healthy = WorkspaceSessionStore::new(directory.path().to_path_buf());
    healthy.save(&original).unwrap();

    let failing = WorkspaceSessionStore::with_test_replacer(
        directory.path().to_path_buf(),
        Box::new(FailingReplacer),
    );
    assert!(failing.save(&replacement).is_err());

    assert_eq!(healthy.load().unwrap(), Some(original));
}

#[test]
fn lock_contention_retries_until_the_workspace_session_store_is_busy() {
    let directory = tempdir().unwrap();
    let store = WorkspaceSessionStore::with_replacer(
        directory.path().to_path_buf(),
        Box::new(super::SystemWorkspaceSessionAtomicReplacer),
        Duration::from_millis(5),
        Duration::from_millis(50),
    );
    store.ensure_storage().unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&store.lock_path)
        .unwrap();
    lock.lock().unwrap();
    let started = Instant::now();

    let error = store.load().unwrap_err();

    assert_eq!(error, "Workspace session store is busy");
    assert!(started.elapsed() >= Duration::from_millis(45));
    lock.unlock().unwrap();
}
