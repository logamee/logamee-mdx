use super::*;

#[test]
fn destination_substitution_fails_exact_receipt_verification() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("trashed.md");
    fs::write(&destination, "original").unwrap();
    let source_identity = capture_source_identity(&destination, TrashEntryKind::File).unwrap();
    fs::remove_file(&destination).unwrap();
    fs::write(&destination, "substitute").unwrap();
    let receipt = NativeTrashReceipt {
        destination,
        kind: TrashEntryKind::File,
        source_identity,
        #[cfg(target_os = "linux")]
        trash_info: temp.path().join("unused.trashinfo"),
        #[cfg(target_os = "linux")]
        expected_trash_info: Vec::new(),
    };

    assert_eq!(verify_receipt_identity(&receipt).unwrap(), false);
}

#[test]
#[cfg(unix)]
fn rejects_symbolic_links_before_any_platform_mutation() {
    use std::os::unix::fs::symlink; // platform-audit: allow (platform-gated trash transport)

    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target.md");
    let link = temp.path().join("link.md");
    fs::write(&target, "content").unwrap();
    symlink(&target, &link).unwrap();

    assert!(capture_source_identity(&link, TrashEntryKind::File).is_err());
    assert!(target.exists());
}

#[test]
#[cfg(windows)]
fn authoritative_windows_attributes_reject_reparse_device_and_kind_mismatch() {
    const REPARSE: u32 = 0x400;
    const DIRECTORY: u32 = 0x10;
    const DEVICE: u32 = 0x40;

    assert!(validate_windows_handle_attributes(
        REPARSE,
        TrashEntryKind::File,
        REPARSE,
        DIRECTORY,
        DEVICE,
    )
    .is_err());
    assert!(validate_windows_handle_attributes(
        DEVICE,
        TrashEntryKind::File,
        REPARSE,
        DIRECTORY,
        DEVICE,
    )
    .is_err());
    assert!(validate_windows_handle_attributes(
        DIRECTORY,
        TrashEntryKind::File,
        REPARSE,
        DIRECTORY,
        DEVICE,
    )
    .is_err());
    assert!(validate_windows_handle_attributes(
        DIRECTORY,
        TrashEntryKind::Directory,
        REPARSE,
        DIRECTORY,
        DEVICE,
    )
    .is_ok());
}

#[test]
fn injected_unavailable_and_read_only_failures_leave_source_confirmed_not_committed() {
    for message in ["Trash unavailable", "Trash is read-only"] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "content").unwrap();
        let injected_message = message.to_string();
        let mut port = NativeTrashPort {
            source_identity: None,
            injected_move: Some(Box::new(move |_, _, _| MoveToTrash::Rejected {
                error: NativeTrashError::new("injected Trash failure", injected_message),
            })),
        };

        assert!(matches!(
            crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
            crate::workspace_trash::TrashClassification::ConfirmedNotCommitted { .. }
        ));
        assert!(source.exists());
    }
}

#[test]
fn injected_post_move_error_with_receipt_is_reconciled_as_committed() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    let destination = temp.path().join("trash-note.md");
    fs::write(&source, "content").unwrap();
    let destination_for_move = destination.clone();
    let mut port = NativeTrashPort {
        source_identity: None,
        injected_move: Some(Box::new(move |source, kind, source_identity| {
            fs::rename(source, &destination_for_move).unwrap();
            #[cfg(target_os = "linux")]
            let (trash_info, expected_trash_info) = {
                let trash_info = destination_for_move.with_extension("trashinfo");
                let expected = b"injected receipt".to_vec();
                fs::write(&trash_info, &expected).unwrap();
                (trash_info, expected)
            };
            MoveToTrash::PossiblyMoved {
                recovery_receipt: Some(NativeTrashReceipt {
                    destination: destination_for_move,
                    kind,
                    source_identity,
                    #[cfg(target_os = "linux")]
                    trash_info,
                    #[cfg(target_os = "linux")]
                    expected_trash_info,
                }),
                error: NativeTrashError::new("injected post-move failure", "sync failed"),
            }
        })),
    };

    assert!(matches!(
        crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
        crate::workspace_trash::TrashClassification::ConfirmedCommitted { .. }
    ));
}

#[test]
fn injected_post_move_error_without_receipt_stays_indeterminate() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    let destination = temp.path().join("unknown-location.md");
    fs::write(&source, "content").unwrap();
    let mut port = NativeTrashPort {
        source_identity: None,
        injected_move: Some(Box::new(move |source, _, _| {
            fs::rename(source, destination).unwrap();
            MoveToTrash::PossiblyMoved {
                recovery_receipt: None,
                error: NativeTrashError::new("injected post-move failure", "receipt lost"),
            }
        })),
    };

    assert!(matches!(
        crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
        crate::workspace_trash::TrashClassification::Indeterminate {
            recovery_receipt: None,
            ..
        }
    ));
}

#[test]
#[ignore = "moves real entries through the platform Trash; opt in explicitly"]
fn real_native_trash_round_trip_for_file_and_non_empty_directory() {
    assert_eq!(
        std::env::var_os("MMD_RUN_NATIVE_TRASH_SMOKE").as_deref(),
        Some(std::ffi::OsStr::new("1")),
        "native Trash smoke requires MMD_RUN_NATIVE_TRASH_SMOKE=1",
    );
    let temp = tempfile::Builder::new()
        .prefix("mmd-native-trash-smoke-")
        .tempdir()
        .unwrap();
    #[cfg(windows)]
    crate::crash_drafts::make_directory_private(temp.path()).unwrap();
    for (name, kind) in [
        ("smoke-file.md", TrashEntryKind::File),
        ("smoke-directory", TrashEntryKind::Directory),
    ] {
        assert_native_trash_round_trip_restores_entry(temp.path(), name, kind);
    }
}

fn assert_native_trash_round_trip_restores_entry(
    temp_root: &std::path::Path,
    name: &str,
    kind: TrashEntryKind,
) {
    let source = temp_root.join(name);
    match kind {
        TrashEntryKind::File => fs::write(&source, "smoke").unwrap(),
        TrashEntryKind::Directory => {
            fs::create_dir(&source).unwrap();
            #[cfg(windows)]
            crate::crash_drafts::make_directory_private(&source).unwrap();
            fs::write(source.join("child.md"), "smoke").unwrap();
        }
    }
    #[cfg(windows)]
    let trash_source = {
        use std::path::Component;

        let canonical = fs::canonicalize(&source).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        canonical
    };
    #[cfg(not(windows))]
    let trash_source = source.clone();
    let mut port = NativeTrashPort::default();
    let receipt = match crate::workspace_trash::classify_trash(&mut port, &trash_source, kind) {
        crate::workspace_trash::TrashClassification::ConfirmedCommitted {
            recovery_receipt,
            warnings,
        } => {
            assert!(
                warnings.is_empty(),
                "native Trash smoke warnings: {warnings:?}"
            );
            recovery_receipt
        }
        other => panic!("native Trash smoke was not committed: {other:?}"),
    };
    fs::rename(&receipt.destination, &source).unwrap();
    #[cfg(target_os = "linux")]
    fs::remove_file(&receipt.trash_info).unwrap();
    assert!(source.exists());
}
