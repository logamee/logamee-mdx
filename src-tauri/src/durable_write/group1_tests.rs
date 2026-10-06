use super::test_prelude::*;
use super::*;

#[test]
fn process_termination_before_replacement_preserves_only_complete_images() {
    const CHILD_PATH: &str = "MMD_DURABLE_WRITE_TERMINATION_PATH";
    if let Some(destination) = std::env::var_os(CHILD_PATH) {
        let destination = std::path::PathBuf::from(destination);
        let expected = capture_file_version(&destination).unwrap().unwrap();
        let _ = durable_write_inner_with_all_hooks(
            &destination,
            b"complete-new-image",
            &exact(&expected),
            None,
            || {},
            || std::process::exit(86),
            || {},
        );
        panic!("termination hook must exit before replacement");
    }

    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"complete-old-image").unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("durable_write::group1_tests::process_termination_before_replacement_preserves_only_complete_images")
        .arg("--nocapture")
        .env(CHILD_PATH, &destination)
        .status()
        .unwrap();

    assert_eq!(status.code(), Some(86));
    assert_eq!(fs::read(&destination).unwrap(), b"complete-old-image");
    let retained = fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path != &destination && path.is_file())
        .collect::<Vec<_>>();
    assert!(!retained.is_empty());
    assert!(retained
        .iter()
        .all(|path| fs::read(path).unwrap() == b"complete-new-image"));
}
#[test]
fn writes_empty_and_large_documents_exactly_and_returns_observed_version() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"stale trailing bytes").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let empty = durable_write(&destination, b"", &exact(&expected)).unwrap();
    let DurableWriteOutcome::ConfirmedCommitted { version, .. } = empty else {
        panic!("empty write must commit, got: {empty:?}");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"");
    assert_eq!(Some(version), capture_file_version(&destination).unwrap());

    let expected = capture_file_version(&destination).unwrap().unwrap();
    let large = (0..(4 * 1024 * 1024 + 31))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let outcome = durable_write(&destination, &large, &exact(&expected)).unwrap();
    let DurableWriteOutcome::ConfirmedCommitted { version, .. } = outcome else {
        panic!("large write must commit");
    };
    assert_eq!(fs::read(&destination).unwrap(), large);
    assert_eq!(Some(version), capture_file_version(&destination).unwrap());
}
#[test]
fn stages_in_destination_directory() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"new",
        &exact(&expected),
        Some(DurableWriteFault::Replace),
    );

    assert!(matches!(
        outcome,
        Ok(DurableWriteOutcome::ConfirmedNotCommitted { .. })
    ));
    let staged = staged_files(directory.path());
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].parent(), destination.parent());
    assert_eq!(fs::read(&staged[0]).unwrap(), b"new");
}
#[cfg(unix)]
#[test]
fn preserves_supported_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write(&destination, b"new", &exact(&expected)).unwrap();

    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedCommitted { .. }
    ));
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o640
    );
}
#[cfg(unix)]
#[test]
fn replaces_read_only_destination_with_complete_bytes() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"complete-old-image").unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o444)).unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome =
        durable_write(&destination, b"complete-new-image", &exact(&expected)).unwrap();

    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(&destination).unwrap(), b"complete-new-image");
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o444
    );
}
#[test]
fn final_compare_race_retains_complete_competing_bytes() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"expected").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome =
        durable_write_inner_with_hook(&destination, b"ours", &exact(&expected), None, || {
            fs::write(&destination, b"competitor").unwrap()
        })
        .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("replacement-boundary race must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"ours");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"competitor")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"ours")));
}
#[test]
fn parent_directory_sync_failure_after_replace_is_indeterminate() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"new",
        &exact(&expected),
        Some(DurableWriteFault::ParentSync),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("directory sync failure must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"new");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
}
#[test]
fn unsupported_atomic_replace_blocks_before_overwrite() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"new",
        &exact(&expected),
        Some(DurableWriteFault::UnsupportedReplace),
    )
    .unwrap();

    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedNotCommitted { .. }
    ));
    assert_eq!(fs::read(&destination).unwrap(), b"old");
    let staged = staged_files(directory.path());
    assert_eq!(staged.len(), 1);
    assert_eq!(fs::read(&staged[0]).unwrap(), b"new");
}
#[test]
fn displaced_original_observation_failure_has_explicit_recovery_disposition() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"new",
        &exact(&expected),
        Some(DurableWriteFault::DisplacedObserve),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("unknown displaced observation must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"new");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
}
#[test]
fn expected_absent_install_race_retains_independent_intended_bytes() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");

    let outcome = durable_write_inner_with_hooks(
        &destination,
        b"intended",
        &ExpectedFileState::Absent,
        None,
        || {},
        || fs::write(&destination, b"competitor").unwrap(),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("post-install competing write must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"competitor");
    let intended = recovery_paths
        .iter()
        .find(|path| fs::read(path).ok().as_deref() == Some(b"intended"))
        .expect("independent intended bytes must be retained");
    fs::write(&destination, b"changed-again").unwrap();
    assert_eq!(fs::read(intended).unwrap(), b"intended");
}
