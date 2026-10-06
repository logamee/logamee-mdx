use super::test_prelude::*;

#[test]
#[ignore = "requires MMD_RUN_NATIVE_WATCH_TESTS=1 and a native filesystem watcher"]
fn native_parent_watcher_reports_same_path_changes_and_stops() {
    assert_eq!(
        std::env::var("MMD_RUN_NATIVE_WATCH_TESTS").as_deref(),
        Ok("1"),
        "set MMD_RUN_NATIVE_WATCH_TESTS=1 before running ignored native watcher tests",
    );
    let workspace = tempdir().unwrap();
    let canonical_workspace = fs::canonicalize(workspace.path()).unwrap();
    let active = canonical_workspace.join("notes.md");
    fs::write(&active, "before").unwrap();
    let active = fs::canonicalize(active).unwrap();
    let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
    let mut handle = create_native_debouncer(&canonical_workspace, sender).unwrap();

    fs::write(&active, "after").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let observed = loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "native watcher did not report the active path"
        );
        match receiver.recv_timeout(remaining) {
            Ok(Ok(events)) => {
                if events
                    .iter()
                    .any(|event| event.paths.iter().any(|path| path == &active))
                {
                    break true;
                }
            }
            Ok(Err(errors)) => panic!("native watcher returned errors: {errors:?}"),
            Err(error) => panic!("native watcher timed out: {error}"),
        }
    };

    assert!(observed);
    handle.stop();
}
#[test]
fn command_identity_limits_match_the_frontend_decoder() {
    assert!(protocol_id_is_valid("watch-1"));
    assert!(!protocol_id_is_valid(""));
    assert!(!protocol_id_is_valid(&"x".repeat(129)));
    assert!(!protocol_id_is_valid("watch id"));
    assert_eq!(MAX_SAFE_INTEGER, 9_007_199_254_740_991);
}
#[test]
fn non_main_owner_is_rejected_before_watch_work() {
    assert!(validate_main_owner("main").is_ok());
    assert!(validate_main_owner("preview-popout").is_err());
}
