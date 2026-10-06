use super::test_prelude::*;
use super::*;

#[test]
fn quarantine_delete_preserves_a_leaf_swapped_at_the_mutation_boundary() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("draft.json");
    let displaced = directory.path().join("displaced.json");
    fs::write(&destination, b"expected").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_remove_exact_with_hook(&destination, &expected, || {
        fs::rename(&destination, &displaced).unwrap();
        fs::write(&destination, b"replacement").unwrap();
    });

    assert!(matches!(outcome, DurableDeleteOutcome::Conflict { .. }));
    assert_eq!(fs::read(&destination).unwrap(), b"replacement");
    assert_eq!(fs::read(&displaced).unwrap(), b"expected");
}
#[test]
fn quarantine_delete_never_unlinks_a_replacement_installed_before_final_unlink() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("draft.json");
    let rescued = directory.path().join("rescued.json");
    fs::write(&destination, b"expected").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_remove_exact_with_hooks(
        &destination,
        &expected,
        || {},
        |quarantine| {
            fs::rename(quarantine, &rescued).unwrap();
            fs::write(quarantine, b"replacement").unwrap();
        },
    );

    assert!(matches!(outcome, DurableDeleteOutcome::Conflict { .. }));
    assert_eq!(fs::read(&rescued).unwrap(), b"expected");
    let replacement = fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.file_name().to_string_lossy().contains(".delete-"))
        .unwrap();
    assert_eq!(fs::read(replacement.path()).unwrap(), b"replacement");
}
#[test]
fn file_version_uses_strict_decimal_string_wire_contract_at_integer_maxima() {
    let version = FileVersion {
        canonical_path: "/tmp/note.md".to_string(),
        platform_identity: "1:2".to_string(),
        length: u64::MAX,
        modified_nanos: u128::MAX,
        sha256: "a".repeat(64),
        file_binding: None,
    };
    let json = serde_json::to_value(&version).unwrap();
    assert_eq!(json["length"], u64::MAX.to_string());
    assert_eq!(json["modifiedNanos"], u128::MAX.to_string());
    assert_eq!(
        serde_json::from_value::<FileVersion>(json).unwrap(),
        version
    );
}
#[test]
fn file_version_rejects_noncanonical_or_invalid_wire_fields() {
    let valid = serde_json::json!({
        "canonicalPath": "/tmp/note.md",
        "platformIdentity": "1:2",
        "length": "1",
        "modifiedNanos": "2",
        "sha256": "a".repeat(64),
    });
    let invalid_cases = [
        ("number length", serde_json::json!(1), "length"),
        ("empty length", serde_json::json!(""), "length"),
        ("signed length", serde_json::json!("+1"), "length"),
        ("spaced length", serde_json::json!(" 1"), "length"),
        ("leading-zero length", serde_json::json!("01"), "length"),
        (
            "overflow length",
            serde_json::json!("18446744073709551616"),
            "length",
        ),
        ("number nanos", serde_json::json!(2), "modifiedNanos"),
        (
            "overflow nanos",
            serde_json::json!("340282366920938463463374607431768211456"),
            "modifiedNanos",
        ),
        (
            "uppercase digest",
            serde_json::json!("A".repeat(64)),
            "sha256",
        ),
        ("short digest", serde_json::json!("a".repeat(63)), "sha256"),
        (
            "empty canonical path",
            serde_json::json!(""),
            "canonicalPath",
        ),
        ("empty identity", serde_json::json!(""), "platformIdentity"),
    ];
    for (name, replacement, field) in invalid_cases {
        let mut candidate = valid.clone();
        candidate[field] = replacement;
        assert!(
            serde_json::from_value::<FileVersion>(candidate).is_err(),
            "{name} must be rejected"
        );
    }
    let mut unknown = valid;
    unknown["extra"] = serde_json::json!(true);
    assert!(serde_json::from_value::<FileVersion>(unknown).is_err());
}
#[test]
fn creates_and_replaces_complete_synced_images() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");

    let created = durable_write(&destination, b"first", &ExpectedFileState::Absent).unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();
    assert!(expected.retained_file_binding().is_none());
    let replaced = durable_write(&destination, b"second", &exact(&expected)).unwrap();

    let DurableWriteOutcome::ConfirmedCommitted {
        version: created_version,
        ..
    } = created
    else {
        panic!("creation must commit");
    };
    let DurableWriteOutcome::ConfirmedCommitted {
        version: replaced_version,
        ..
    } = replaced
    else {
        panic!("replacement must commit");
    };
    assert!(created_version.retained_file_binding().is_some());
    assert!(replaced_version.retained_file_binding().is_some());
    assert_eq!(fs::read(&destination).unwrap(), b"second");
}
#[cfg(windows)]
#[test]
fn windows_same_bytes_staging_substitution_cannot_confirm_commit() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");
    fs::write(&destination, b"old-image").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner_with_all_hooks(
        &destination,
        b"new-image",
        &exact(&expected),
        None,
        || {},
        || {
            let staged = staged_files(directory.path());
            assert_eq!(staged.len(), 1);
            fs::remove_file(&staged[0]).unwrap();
            fs::write(&staged[0], b"new-image").unwrap();
        },
        || {},
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("a replacement with matching bytes but a different identity is not committed");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"new-image");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old-image")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"new-image")));
}
#[cfg(unix)]
#[test]
fn successful_creation_cleans_abandoned_staging_alias() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");

    let outcome = durable_write(&destination, b"complete", &ExpectedFileState::Absent).unwrap();

    assert!(matches!(
        outcome,
        DurableWriteOutcome::ConfirmedCommitted { .. }
    ));
    assert!(staged_files(directory.path()).is_empty());
}
#[cfg(unix)]
#[test]
fn cleanup_failure_after_creation_preserves_complete_bytes_and_recovery_evidence() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");

    let outcome = durable_write_inner_with_hooks(
        &destination,
        b"complete",
        &ExpectedFileState::Absent,
        None,
        || {},
        || {
            let staged = staged_files(directory.path());
            assert_eq!(staged.len(), 1);
            fs::remove_file(&staged[0]).unwrap();
            fs::create_dir(&staged[0]).unwrap();
        },
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths,
    } = outcome
    else {
        panic!("failed staging cleanup must retain explicit recovery evidence");
    };
    assert!(message.contains("staging link could not be retired"));
    assert_eq!(fs::read(&destination).unwrap(), b"complete");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"complete")));
}
