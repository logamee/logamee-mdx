use super::test_prelude::*;
use super::*;

#[cfg(unix)]
#[test]
fn ancestor_swap_is_detected_without_mutating_the_replacement_tree() {
    let directory = tempdir().unwrap();
    let ancestor = directory.path().join("workspace");
    let parent = ancestor.join("nested");
    fs::create_dir_all(&parent).unwrap();
    let destination = parent.join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();
    let moved = directory.path().join("moved-workspace");

    let outcome = durable_write_inner_with_hook(
        &destination,
        b"intended",
        &exact(&expected),
        None,
        || {
            fs::rename(&ancestor, &moved).unwrap();
            fs::create_dir_all(&parent).unwrap();
        },
    )
    .unwrap();

    assert!(matches!(outcome, DurableWriteOutcome::Indeterminate { .. }));
    assert!(!destination.exists());
    assert_eq!(fs::read(moved.join("nested/document.md")).unwrap(), b"old");
    assert!(recovery_files(&parent)
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
}
#[cfg(windows)]
#[test]
fn windows_live_staging_handle_prevents_ancestor_swap_before_replacement() {
    use std::cell::Cell;

    let directory = tempdir().unwrap();
    let ancestor = directory.path().join("workspace");
    let parent = ancestor.join("nested");
    fs::create_dir_all(&parent).unwrap();
    let destination = parent.join("document.md");
    fs::write(&destination, b"old").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();
    let moved = directory.path().join("moved-workspace");
    let rename_error = Cell::new(None);

    let outcome = durable_write_inner_with_hook(
        &destination,
        b"intended",
        &exact(&expected),
        None,
        || {
            rename_error.set(
                fs::rename(&ancestor, &moved)
                    .err()
                    .and_then(|error| error.raw_os_error()),
            )
        },
    )
    .unwrap();

    assert_eq!(rename_error.get(), Some(5));
    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(destination).unwrap(), b"intended");
    assert!(!moved.exists());
}
#[cfg(windows)]
#[test]
fn windows_live_installed_handle_prevents_post_create_parent_swap() {
    use std::cell::Cell;

    let directory = tempdir().unwrap();
    let ancestor = directory.path().join("workspace");
    fs::create_dir(&ancestor).unwrap();
    let destination = ancestor.join("document.md");
    let moved = directory.path().join("moved-workspace");
    let rename_error = Cell::new(None);

    let outcome = durable_write_inner_with_all_hooks(
        &destination,
        b"intended",
        &ExpectedFileState::Absent,
        None,
        || {},
        || {},
        || {
            rename_error.set(
                fs::rename(&ancestor, &moved)
                    .err()
                    .and_then(|error| error.raw_os_error()),
            )
        },
    )
    .unwrap();

    assert_eq!(rename_error.get(), Some(5));
    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read(destination).unwrap(), b"intended");
    assert!(!moved.exists());
}
#[test]
fn creation_observation_failure_retains_independent_intended_image() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");

    let outcome = durable_write_inner(
        &destination,
        b"intended",
        &ExpectedFileState::Absent,
        Some(DurableWriteFault::CreationObserve),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("creation observation failure must be indeterminate");
    };
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
#[test]
fn versioned_read_rejects_replacement_between_stable_observations() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("settings.json");
    fs::write(&path, b"first").unwrap();

    let error = read_versioned_file_with_hook(&path, 1024, || {
        let replacement = directory.path().join("replacement");
        fs::write(&replacement, b"second").unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(replacement, &path).unwrap();
    })
    .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    assert_eq!(fs::read(path).unwrap(), b"second");
}
#[test]
fn unbounded_platform_limit_does_not_overflow_bounded_read_sentinel() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("document.md");
    fs::write(&path, b"content").unwrap();

    let observed = super::read_versioned_file(&path, usize::MAX)
        .unwrap()
        .unwrap();

    assert_eq!(observed.bytes, b"content");
}
#[test]
fn parent_sync_policy_never_silently_claims_unsupported_platform_evidence() {
    #[cfg(unix)]
    assert!(super::parent_directory_sync_required());
    #[cfg(not(unix))]
    assert!(!super::parent_directory_sync_required());
}
#[test]
fn documented_windows_partial_replace_errors_require_indeterminate() {
    assert!(super::windows_replace_error_requires_indeterminate(Some(
        1176
    )));
    assert!(super::windows_replace_error_requires_indeterminate(Some(
        1177
    )));
    assert!(!super::windows_replace_error_requires_indeterminate(Some(
        1175
    )));
}
#[test]
fn collision_safe_windows_backup_name_preserves_random_staging_suffix() {
    let first = std::path::Path::new("/tmp/.document.md.tmp-001122");
    let second = std::path::Path::new("/tmp/.document.md.tmp-aabbcc");

    let first_backup = collision_safe_displaced_path(first);
    let second_backup = collision_safe_displaced_path(second);

    assert_ne!(first_backup, second_backup);
    assert_eq!(
        first_backup.file_name().unwrap(),
        ".document.md.tmp-001122.displaced"
    );
    assert_eq!(
        second_backup.file_name().unwrap(),
        ".document.md.tmp-aabbcc.displaced"
    );
}
#[test]
fn version_conflict_never_replaces_destination_and_retains_staged_bytes() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");
    fs::write(&destination, b"expected").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();
    fs::write(&destination, b"external").unwrap();

    let outcome = durable_write(&destination, b"ours", &exact(&expected)).unwrap();

    let DurableWriteOutcome::Conflict { recovery_path, .. } = outcome else {
        panic!("expected a conflict");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"external");
    assert_eq!(fs::read(recovery_path).unwrap(), b"ours");
}
#[test]
fn absent_precondition_conflicts_if_destination_appears() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");
    fs::write(&destination, b"external").unwrap();

    let outcome = durable_write(&destination, b"ours", &ExpectedFileState::Absent).unwrap();

    assert!(matches!(outcome, DurableWriteOutcome::Conflict { .. }));
    assert_eq!(fs::read(&destination).unwrap(), b"external");
}
#[test]
fn precommit_write_sync_and_replace_failures_preserve_destination_and_recovery_bytes() {
    for (fault, expected_staged) in [
        (DurableWriteFault::Write, b"".as_slice()),
        (DurableWriteFault::PartialWrite, b"new-".as_slice()),
        (DurableWriteFault::Flush, b"new-image".as_slice()),
        (DurableWriteFault::Metadata, b"new-image".as_slice()),
        (DurableWriteFault::Sync, b"new-image".as_slice()),
    ] {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"old-image").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let result =
            durable_write_inner(&destination, b"new-image", &exact(&expected), Some(fault));

        assert!(result.is_err(), "{fault:?} must report failure");
        assert_eq!(fs::read(&destination).unwrap(), b"old-image");
        let staged = staged_files(directory.path());
        assert_eq!(staged.len(), 1);
        assert_eq!(fs::read(&staged[0]).unwrap(), expected_staged);
    }
}
