use super::test_prelude::*;
use super::*;

#[test]
fn failed_replace_with_unchanged_destination_is_confirmed_not_committed() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"intended",
        &exact(&expected),
        Some(DurableWriteFault::Replace),
    )
    .unwrap();

    let DurableWriteOutcome::ConfirmedNotCommitted {
        current_version,
        recovery_paths,
        ..
    } = outcome
    else {
        panic!("unchanged destination must be confirmed not committed");
    };
    assert_eq!(current_version, Some(expected));
    assert_eq!(fs::read(&destination).unwrap(), b"old");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[test]
fn backup_succeeded_then_replace_failed_has_unambiguous_not_committed_evidence() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"intended",
        &exact(&expected),
        Some(DurableWriteFault::BackupSucceededReplaceFailed),
    )
    .unwrap();

    let DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } = outcome else {
        panic!("failed replacement with unchanged destination is not committed");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"old");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[test]
fn replacement_succeeded_with_unknown_backup_disposition_is_indeterminate() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"intended",
        &exact(&expected),
        Some(DurableWriteFault::ReplacementSucceededBackupUnknown),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("unknown backup disposition must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"intended");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[test]
fn committed_binding_observation_failure_retains_new_and_old_recovery_images() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"intended",
        &exact(&expected),
        Some(DurableWriteFault::CommittedBindingObserve),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths,
    } = outcome
    else {
        panic!("a missing committed binding must remain indeterminate");
    };
    assert!(message.contains("disappeared before its retained binding"));
    assert!(!destination.exists());
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[test]
fn staged_path_substitution_is_detected_before_mutation() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner_with_hook(
        &destination,
        b"intended",
        &exact(&expected),
        None,
        || {
            let staged = staged_files(directory.path());
            assert_eq!(staged.len(), 1);
            fs::remove_file(&staged[0]).unwrap();
            fs::write(&staged[0], b"substitute").unwrap();
        },
    )
    .unwrap();

    let DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } = outcome else {
        panic!("staging substitution must block before mutation");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"old");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[test]
fn staged_path_substitution_at_native_boundary_preserves_all_complete_images() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner_with_all_hooks(
        &destination,
        b"intended",
        &exact(&expected),
        None,
        || {},
        || {
            let staged = staged_files(directory.path());
            assert_eq!(staged.len(), 1);
            fs::remove_file(&staged[0]).unwrap();
            fs::write(&staged[0], b"competitor").unwrap();
        },
        || {},
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("a final staged-name race cannot be confirmed committed");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"competitor");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
}
#[test]
fn post_replace_parent_change_with_failed_recovery_creation_is_indeterminate() {
    let directory = tempdir().unwrap();
    let ancestor = directory.path().join("workspace");
    fs::create_dir(&ancestor).unwrap();
    let destination = ancestor.join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();
    let moved = directory.path().join("moved-workspace");

    let outcome = durable_write_inner_with_all_hooks(
        &destination,
        b"intended",
        &exact(&expected),
        None,
        || {},
        || {},
        || {
            fs::rename(&ancestor, &moved).unwrap();
            fs::write(&ancestor, b"not-a-directory").unwrap();
        },
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("post-mutation parent change must remain indeterminate");
    };
    assert_eq!(fs::read(moved.join("document.md")).unwrap(), b"intended");
    assert!(recovery_paths.iter().all(|path| path.exists()));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
}
#[cfg(unix)]
#[test]
fn post_create_parent_change_with_failed_recovery_creation_is_indeterminate() {
    let directory = tempdir().unwrap();
    let ancestor = directory.path().join("workspace");
    fs::create_dir(&ancestor).unwrap();
    let destination = ancestor.join("document.md");
    let moved = directory.path().join("moved-workspace");

    let outcome = durable_write_inner_with_all_hooks(
        &destination,
        b"intended",
        &ExpectedFileState::Absent,
        None,
        || {},
        || {},
        || {
            fs::rename(&ancestor, &moved).unwrap();
            fs::write(&ancestor, b"not-a-directory").unwrap();
        },
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("post-create parent change must remain indeterminate");
    };
    assert_eq!(fs::read(moved.join("document.md")).unwrap(), b"intended");
    assert!(recovery_paths.iter().all(|path| path.exists()));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    assert!(recovery_paths.iter().all(|path| {
        !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(".tmp-"))
    }));
}
