use std::sync::mpsc;

use super::*;

#[test]
fn packaged_evidence_transition_lock_is_exclusive() {
    let state = std::sync::Arc::new(AppState::default());
    let first = state.packaged_evidence_lock().unwrap();
    let (acquired_sender, acquired_receiver) = mpsc::channel();
    let other_state = std::sync::Arc::clone(&state);
    let worker = std::thread::spawn(move || {
        let _guard = other_state.packaged_evidence_lock().unwrap();
        acquired_sender.send(()).unwrap();
    });

    assert!(
        acquired_receiver
            .recv_timeout(Duration::from_millis(50))
            .is_err(),
        "a second packaged evidence transition entered while the first was active"
    );
    drop(first);
    acquired_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("the second packaged evidence transition should proceed after release");
    worker.join().unwrap();
}

#[test]
fn matches_only_the_equivalent_windows_verbatim_drive_root() {
    let dos = r"C:\Users\runneradmin\AppData\Local\Temp\challenge";
    let verbatim = r"\\?\C:\Users\runneradmin\AppData\Local\Temp\challenge";

    assert!(windows_verbatim_drive_root_matches(
        &dos.encode_utf16().collect::<Vec<_>>(),
        &verbatim.encode_utf16().collect::<Vec<_>>(),
    ));
    assert!(!windows_verbatim_drive_root_matches(
        &dos.encode_utf16().collect::<Vec<_>>(),
        &r"\\?\c:\Users\runneradmin\AppData\Local\Temp\challenge"
            .encode_utf16()
            .collect::<Vec<_>>(),
    ));
    assert!(!windows_verbatim_drive_root_matches(
        &r"\\server\share\challenge"
            .encode_utf16()
            .collect::<Vec<_>>(),
        &r"\\?\UNC\server\share\challenge"
            .encode_utf16()
            .collect::<Vec<_>>(),
    ));
    assert!(!windows_verbatim_drive_root_matches(
        &dos.encode_utf16().collect::<Vec<_>>(),
        &r"\\?\C:\Users\runneradmin\AppData\Local\Temp\other"
            .encode_utf16()
            .collect::<Vec<_>>(),
    ));
}

#[cfg(windows)]
#[test]
fn accepts_a_canonical_windows_temp_root_without_the_verbatim_prefix() {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let directory = tempfile::tempdir().unwrap();
    let canonical = fs::canonicalize(directory.path()).unwrap();
    let canonical_wide = canonical.as_os_str().encode_wide().collect::<Vec<_>>();
    let dos_wide = canonical_wide
        .strip_prefix(&WINDOWS_VERBATIM_PREFIX)
        .expect("Windows canonicalization must return a verbatim drive path");
    let dos = PathBuf::from(OsString::from_wide(dos_wide));

    assert_ne!(canonical, dos);
    assert_eq!(canonical_challenge_root(&dos).unwrap(), dos);
}

pub(super) fn test_observer(root: &Path, package_variant: &str, profile: &str) -> PackagedOpenObserver {
    let fixtures = root.join("fixtures with spaces");
    PackagedOpenObserver {
        receipt_path: root.join("receipt.json"),
        control_path: root.join("control.json"),
        target: "target".to_string(),
        platform: "linux".to_string(),
        run_id: "run".to_string(),
        run_attempt: "1".to_string(),
        commit: "commit".to_string(),
        package_variant: package_variant.to_string(),
        profile: profile.to_string(),
        nonce_digest: "0".repeat(64),
        primary_pid: 7,
        primary_file: fixtures.join("primary.md"),
        unicode_file: fixtures.join("文档 space.md"),
        renamed_unicode_file: fixtures.join("文档 renamed.md"),
        association_file: fixtures.join("association.md"),
        workspace_directory: fixtures.join("工作区 space"),
        stale_file: fixtures.join("removed stale.md"),
        state: Mutex::new(ObserverState::default()),
    }
}

pub(super) fn empty_authorization() -> EvidenceAuthorizationState {
    EvidenceAuthorizationState {
        generation: 0,
        pending_file_receipts: 0,
        pending_workspace_receipts: 0,
        grants: Vec::new(),
    }
}

#[test]
fn config_reports_when_the_unicode_target_has_been_renamed() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "deb", "apply-reobserve");
    fs::create_dir_all(observer.unicode_file.parent().unwrap()).unwrap();
    fs::write(&observer.unicode_file, "# unicode\n").unwrap();

    assert!(!observer.config().unicode_rename_ready);

    fs::rename(&observer.unicode_file, &observer.renamed_unicode_file).unwrap();

    assert!(observer.config().unicode_rename_ready);
}

#[test]
fn records_native_events_with_one_rust_owned_monotonic_sequence() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "deb", "apply-reobserve");
    let coordinator = OpenIntentCoordinator::default();
    let primary = coordinator.enqueue_path(
        observer.primary_file.clone(),
        OpenIntentSource::StartupArguments,
    );
    observer.record_enqueue(&coordinator, &primary);
    observer.record_enqueue(&coordinator, &coordinator.enqueue_session_restore());

    let state = observer.state.lock().unwrap();
    assert_eq!(state.events[0]["seq"], 1);
    assert_eq!(state.events[0]["type"], "native_delivery");
    assert_eq!(state.events[1]["seq"], 2);
    assert_eq!(state.events[1]["type"], "session_restore_queued");
    assert_eq!(state.events[1]["opaque"], true);
    assert!(state.events[1].get("target").is_none());
}
