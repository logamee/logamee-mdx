use super::test_prelude::*;
use super::*;

#[test]
fn fs2_lock_contention_waits_and_times_out_across_real_processes() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    let ready = directory.path().join("child-ready");
    let store = store_with(
        root.clone(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(5),
        Duration::from_millis(500),
    );

    let mut wait_command = recent_files_child_command("hold-lock", &root);
    let wait_child = wait_command
        .env("MMD_RECENT_FILES_CHILD_READY", &ready)
        .env("MMD_RECENT_FILES_CHILD_HOLD_MS", "120")
        .spawn()
        .unwrap();
    wait_until_created(&ready);
    let started = Instant::now();
    assert!(store.list().unwrap().entries.is_empty());
    assert!(started.elapsed() >= Duration::from_millis(80));
    assert_child_success(wait_child);

    fs::remove_file(&ready).unwrap();
    let timeout_store = store_with(
        root.clone(),
        Arc::new(SystemRecentStoreAtomicReplacer),
        Duration::from_millis(5),
        Duration::from_millis(80),
    );
    let mut timeout_command = recent_files_child_command("hold-lock", &root);
    let timeout_child = timeout_command
        .env("MMD_RECENT_FILES_CHILD_READY", &ready)
        .env("MMD_RECENT_FILES_CHILD_HOLD_MS", "250")
        .spawn()
        .unwrap();
    wait_until_created(&ready);
    let started = Instant::now();
    let error = timeout_store.list().unwrap_err();
    assert!(error.contains("busy"));
    assert!(started.elapsed() >= Duration::from_millis(75));
    assert_child_success(timeout_child);
}
#[test]
fn concurrent_process_commits_reload_under_lock_without_lost_updates() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();

    let mut first_command = recent_files_child_command("commit", &root);
    let first_child = first_command
        .env("MMD_RECENT_FILES_CHILD_TARGET", &first)
        .spawn()
        .unwrap();
    let mut second_command = recent_files_child_command("commit", &root);
    let second_child = second_command
        .env("MMD_RECENT_FILES_CHILD_TARGET", &second)
        .spawn()
        .unwrap();
    assert_child_success(first_child);
    assert_child_success(second_child);

    let store = RecentStore::new(root);
    let snapshot = store.list().unwrap();
    assert_eq!(
        snapshot
            .entries
            .iter()
            .map(|entry| entry.display_name.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from(["first.md", "second.md"]),
    );
    let persisted: RecentFileStoreV1 =
        serde_json::from_slice(&fs::read(store.store_path()).unwrap()).unwrap();
    assert_eq!(persisted.entries.len(), 2);
    assert!(serialize_complete_store(&persisted).is_ok());
}
#[test]
fn cross_process_commit_and_clear_have_only_valid_serial_outcomes() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    let seed_recent = RecentFilesState::new(root.clone());
    commit_document(
        &seed_recent,
        "seed",
        &first,
        &FileAuthorizationSession::default(),
    );

    let start = directory.path().join("race-start");
    let commit_ready = directory.path().join("commit-ready");
    let clear_ready = directory.path().join("clear-ready");
    let mut commit_command = recent_files_child_command("commit", &root);
    commit_command.env("MMD_RECENT_FILES_CHILD_TARGET", &second);
    let commit_child = spawn_gated_child(&mut commit_command, &commit_ready, &start);
    let mut clear_command = recent_files_child_command("clear", &root);
    let clear_child = spawn_gated_child(&mut clear_command, &clear_ready, &start);
    wait_until_created(&commit_ready);
    wait_until_created(&clear_ready);
    fs::write(&start, b"start").unwrap();
    assert_child_success(commit_child);
    assert_child_success(clear_child);

    let store = RecentStore::new(root);
    let snapshot = store.list().unwrap();
    let names = snapshot
        .entries
        .iter()
        .map(|entry| entry.display_name.as_str())
        .collect::<Vec<_>>();
    assert!(names.is_empty() || names == ["second.md"]);
    assert!(!names.contains(&"first.md"));
    assert_eq!(load_strict_store(&store).entries.len(), names.len());
}
#[test]
fn cross_process_commit_and_remove_reload_without_losing_either_update() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    let seed_recent = RecentFilesState::new(root.clone());
    let seeded = commit_document(
        &seed_recent,
        "seed",
        &first,
        &FileAuthorizationSession::default(),
    );
    let first_id = seeded.entries[0].id.clone();

    let start = directory.path().join("race-start");
    let commit_ready = directory.path().join("commit-ready");
    let remove_ready = directory.path().join("remove-ready");
    let mut commit_command = recent_files_child_command("commit", &root);
    commit_command.env("MMD_RECENT_FILES_CHILD_TARGET", &second);
    let commit_child = spawn_gated_child(&mut commit_command, &commit_ready, &start);
    let mut remove_command = recent_files_child_command("remove", &root);
    remove_command.env("MMD_RECENT_FILES_CHILD_ENTRY_ID", first_id);
    let remove_child = spawn_gated_child(&mut remove_command, &remove_ready, &start);
    wait_until_created(&commit_ready);
    wait_until_created(&remove_ready);
    fs::write(&start, b"start").unwrap();
    assert_child_success(commit_child);
    assert_child_success(remove_child);

    let store = RecentStore::new(root);
    let snapshot = store.list().unwrap();
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].display_name, "second.md");
    let persisted = load_strict_store(&store);
    assert_eq!(persisted.entries.len(), 1);
    assert_eq!(
        persisted.entries[0].canonical_target,
        second.canonicalize().unwrap().to_string_lossy()
    );
}
#[test]
fn cross_process_clear_and_remove_converge_to_one_complete_empty_store() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("app-data");
    let first = directory.path().join("first.md");
    let second = directory.path().join("second.md");
    fs::write(&first, "# first").unwrap();
    fs::write(&second, "# second").unwrap();
    let seed_recent = RecentFilesState::new(root.clone());
    let authorization = FileAuthorizationSession::default();
    commit_document(&seed_recent, "seed", &first, &authorization);
    let seeded = commit_document(&seed_recent, "seed", &second, &authorization);
    let first_id = seeded
        .entries
        .iter()
        .find(|entry| entry.display_name == "first.md")
        .unwrap()
        .id
        .clone();

    let start = directory.path().join("race-start");
    let clear_ready = directory.path().join("clear-ready");
    let remove_ready = directory.path().join("remove-ready");
    let mut clear_command = recent_files_child_command("clear", &root);
    let clear_child = spawn_gated_child(&mut clear_command, &clear_ready, &start);
    let mut remove_command = recent_files_child_command("remove", &root);
    remove_command.env("MMD_RECENT_FILES_CHILD_ENTRY_ID", first_id);
    let remove_child = spawn_gated_child(&mut remove_command, &remove_ready, &start);
    wait_until_created(&clear_ready);
    wait_until_created(&remove_ready);
    fs::write(&start, b"start").unwrap();
    assert_child_success(clear_child);
    assert_child_success(remove_child);

    let store = RecentStore::new(root);
    assert!(store.list().unwrap().entries.is_empty());
    assert_eq!(load_strict_store(&store), RecentFileStoreV1::empty());
}
