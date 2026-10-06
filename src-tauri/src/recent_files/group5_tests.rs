use super::group5_helpers::*;
use super::test_prelude::*;
use super::*;

#[test]
fn pre_commit_promotion_id_exhaustion_is_not_committed_and_grants_nothing() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with_ids(
        directory.path().join("app-data"),
        Arc::new(SystemRecentStoreAtomicReplacer),
        (1..=2).map(opaque_id),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &document).unwrap();

    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::NotCommitted { .. }
    ));
    assert!(!recent.store.store_path().exists());
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
}
#[test]
fn pre_commit_staging_name_exhaustion_is_not_committed_and_grants_nothing() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    fs::create_dir_all(&root).unwrap();
    for id in (4..=11).map(opaque_id) {
        fs::write(
            root.join(format!("{}.tmp-{id}", super::STORE_FILE_NAME)),
            b"collision",
        )
        .unwrap();
    }
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let recent = state_with_ids(
        root,
        Arc::new(SystemRecentStoreAtomicReplacer),
        (1..=11).map(opaque_id),
    );
    let authorization = FileAuthorizationSession::default();
    let identifiers = recent.issue_open("main", &document).unwrap();

    assert!(matches!(
        recent
            .commit_open(&identifiers.open_receipt, "main", &authorization)
            .unwrap(),
        OpenCommitResult::NotCommitted { .. }
    ));
    assert!(matches!(
        recent
            .status("main", &identifiers.commit_operation_id)
            .unwrap(),
        OpenCommitStatus::NotCommitted { .. }
    ));
    assert!(!recent.store.store_path().exists());
    assert!(authorization
        .exact_write_grant_snapshot_for_test(&canonical_document)
        .unwrap()
        .is_none());
}
#[test]
fn pre_commit_persistence_faults_preserve_prior_store_and_publish_no_new_grant() {
    for fault in [
        PersistFault::Serialize,
        PersistFault::CreateStagedFile,
        PersistFault::WriteStagedFile,
        PersistFault::SyncStagedFile,
        PersistFault::ReparseStagedFile,
    ] {
        let directory = tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        let first = directory.path().join("first.md");
        let second = directory.path().join("second.md");
        fs::write(&first, "# first").unwrap();
        fs::write(&second, "# second").unwrap();
        let canonical_first = first.canonicalize().unwrap();
        let canonical_second = second.canonicalize().unwrap();
        let mut recent =
            state_with(app_data.clone(), Arc::new(SystemRecentStoreAtomicReplacer));
        let authorization = FileAuthorizationSession::default();
        let prior = commit_document(&recent, "main", &first, &authorization);
        let prior_bytes = fs::read(recent.store.store_path()).unwrap();
        recent.store.persist_fault = Some(fault);
        let identifiers = recent.issue_open("main", &second).unwrap();

        assert_prior_store_and_grants_survive_fault(
            &recent,
            &authorization,
            &identifiers,
            &prior,
            &prior_bytes,
            &canonical_first,
            &canonical_second,
            &app_data,
            fault,
        );
    }
}
#[test]
fn listing_repairs_stale_entries_to_a_private_complete_v1_image() {
    let directory = tempdir().unwrap();
    let app_data = directory.path().join("app-data");
    fs::create_dir_all(&app_data).unwrap();
    let document = directory.path().join("notes.md");
    fs::write(&document, "# Notes").unwrap();
    let canonical = document.canonicalize().unwrap();
    let store = store_with(
        app_data.clone(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(1),
        Duration::from_millis(100),
    );
    fs::write(
        store.store_path(),
        serde_json::to_vec(&json!({
            "version": 1,
            "entries": [
                { "id": ID_A, "canonicalTarget": canonical },
                { "id": ID_B, "canonicalTarget": directory.path().join("missing.md") }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let snapshot = store.list().unwrap();

    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].id, ID_A);
    assert_eq!(snapshot.entries[0].display_name, "notes.md");
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
    assert_eq!(persisted["version"], 1);
    assert_eq!(persisted["entries"].as_array().unwrap().len(), 1);

    #[cfg(unix)]
    assert_private_store_permissions(&app_data, &store);
}
#[test]
fn replacement_failure_preserves_the_complete_prior_image_and_removes_staging() {
    let directory = tempdir().unwrap();
    let active_store = store_with(
        directory.path().to_path_buf(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(1),
        Duration::from_millis(100),
    );
    let prior = RecentFileStoreV1 {
        version: 1,
        entries: vec![RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md"))],
    };
    active_store.persist(&prior).unwrap();
    let prior_bytes = fs::read(active_store.store_path()).unwrap();

    let failing_store = store_with(
        directory.path().to_path_buf(),
        Arc::new(FailingReplacer),
        Duration::from_millis(1),
        Duration::from_millis(100),
    );
    let next = RecentFileStoreV1 {
        version: 1,
        entries: vec![RecentFileEntryV1::new(ID_B, absolute_path("docs/b.md"))],
    };

    assert!(failing_store.persist(&next).is_err());
    assert_eq!(fs::read(failing_store.store_path()).unwrap(), prior_bytes);
    assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".tmp-")));
}
#[test]
fn fs2_lock_waits_for_release_and_times_out_without_mutating_the_store() {
    let directory = tempdir().unwrap();
    let store = store_with(
        directory.path().to_path_buf(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(5),
        Duration::from_millis(80),
    );
    store.ensure_storage().unwrap();
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(store.lock_path())
        .unwrap();
    lock.lock().unwrap();
    let started = Instant::now();

    let error = store.list().unwrap_err();

    assert!(error.contains("busy"));
    assert!(started.elapsed() >= Duration::from_millis(75));
    assert!(!store.store_path().exists());
    lock.unlock().unwrap();

    let waiting_store = store_with(
        directory.path().to_path_buf(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(5),
        Duration::from_secs(2),
    );
    let lock = Arc::new(lock);
    lock.lock().unwrap();
    let releasing_lock = Arc::clone(&lock);
    let (release_started_tx, release_started_rx) = mpsc::channel();
    let release = thread::spawn(move || {
        release_started_tx.send(()).unwrap();
        thread::sleep(Duration::from_millis(30));
        releasing_lock.unlock().unwrap();
    });
    release_started_rx.recv().unwrap();
    let snapshot = waiting_store.list().unwrap();
    release.join().unwrap();
    assert!(snapshot.entries.is_empty());
}
