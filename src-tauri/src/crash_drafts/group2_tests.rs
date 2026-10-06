use super::test_prelude::*;

#[test]
fn deterministic_eviction_persists_incoming_first_and_never_evicts_protected() {
    let (temp, store, clock, writer) = setup(100);
    for index in 1..=MAX_DRAFT_ENTRIES {
        clock.set(100 + index as u64);
        store.write(request(index, 1, "x")).unwrap();
    }
    writer.calls.lock().unwrap().clear();
    let receipt = store
        .write(request(MAX_DRAFT_ENTRIES + 1, 1, "new"))
        .unwrap();
    assert_eq!(receipt.evicted_document_ids, [id(1)]);
    let calls = writer.calls.lock().unwrap().clone();
    assert_eq!(calls, ["persist:absent", "delete:exact"]);
    let catalog = store.list().unwrap();
    let ids: HashSet<_> = supported(&catalog)
        .iter()
        .map(|draft| draft.document_id.clone())
        .collect();
    assert!(!ids.contains(&id(1)));

    let protected_path = root(&temp).join(format!("{}.json", id(99)));
    fs::write(&protected_path, b"corrupt").unwrap();
    let repaired = store.repair_startup().unwrap();
    assert!(repaired.entries.iter().any(|entry| matches!(entry, CrashDraftListEntry::Protected { document_id, .. } if *document_id == id(99))));
}
#[test]
fn protected_entries_can_fill_capacity_without_being_replaced_or_evicted() {
    let (temp, store, _clock, writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    for index in 1..=MAX_DRAFT_ENTRIES {
        fs::write(root(&temp).join(format!("{}.json", id(index))), b"corrupt").unwrap();
    }
    writer.calls.lock().unwrap().clear();
    let error = store.write(request(99, 1, "incoming")).unwrap_err();
    assert_eq!(error.code, CrashDraftErrorCode::Capacity);
    assert!(writer.calls.lock().unwrap().is_empty());
    assert_eq!(store.list().unwrap().entries.len(), MAX_DRAFT_ENTRIES);
}
#[test]
fn total_limit_uses_updated_revision_id_order() {
    let (temp, store, _clock, _writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    let mut entries = Vec::new();
    for index in 1..=6 {
        let path = root(&temp).join(format!("{}.json", id(index)));
        fs::write(&path, b"x").unwrap();
        let version = TestWriter::version(&path).unwrap();
        entries.push(ScannedEntry::Supported {
            envelope: CrashDraftEnvelope {
                schema_version: 1,
                document_id: id(index),
                file_kind: CrashDraftFileKind::Markdown,
                revision: if index < 3 { 1 } else { index as u64 },
                updated_at_ms: 10,
                path_hint: None,
                base_version_token: None,
                content: "x".into(),
                checksum: "test".into(),
            },
            path,
            size: 4 * 1024 * 1024,
            token: format!("token-{index}"),
            version,
        });
    }
    store.repair_limits(&mut entries, Some(&id(6))).unwrap();
    assert!(entries.iter().all(|entry| entry.id() != id(1)));
}
#[test]
fn conditional_discard_and_reset_do_not_delete_racing_replacements() {
    let (temp, store, _clock, writer) = setup(10);
    let summary = store.write(request(1, 1, "old")).unwrap();
    let path = root(&temp).join(format!("{}.json", id(1)));
    *writer.replace_before_delete.lock().unwrap() = Some(b"newer replacement".to_vec());
    assert_eq!(
        store
            .discard(&id(1), &summary.entry_token)
            .unwrap_err()
            .disposition,
        Some(CrashDraftPersistenceDisposition::Conflict)
    );
    assert_eq!(fs::read(&path).unwrap(), b"newer replacement");

    let catalog = store.list().unwrap();
    *writer.replace_before_delete.lock().unwrap() = Some(b"newest replacement".to_vec());
    let error = store.reset(&catalog.catalog_token).unwrap_err();
    assert_eq!(
        error.disposition,
        Some(CrashDraftPersistenceDisposition::Conflict)
    );
    assert!(path.exists());
}
#[test]
fn conditional_delete_maps_not_deleted_and_indeterminate_without_losing_evidence() {
    let recovery = PathBuf::from("recovery-copy");
    let not_deleted = map_delete_outcome::<String>(DraftDeleteOutcome::ConfirmedNotDeleted {
        current_version: Some("current".into()),
        recovery_paths: vec![recovery.clone()],
    })
    .unwrap_err();
    assert_eq!(
        not_deleted.disposition,
        Some(CrashDraftPersistenceDisposition::ConfirmedNotCommitted)
    );
    assert_eq!(not_deleted.recovery_paths, [recovery.clone()]);
    assert!(!serde_json::to_string(&not_deleted)
        .unwrap()
        .contains("recovery-copy"));

    let indeterminate = map_delete_outcome::<String>(DraftDeleteOutcome::Indeterminate {
        recovery_paths: vec![recovery.clone()],
    })
    .unwrap_err();
    assert_eq!(
        indeterminate.disposition,
        Some(CrashDraftPersistenceDisposition::Indeterminate)
    );
    assert_eq!(indeterminate.recovery_paths, [recovery]);
    assert!(!serde_json::to_string(&indeterminate)
        .unwrap()
        .contains("recovery-copy"));
}
#[test]
fn eviction_failure_reports_committed_and_restart_repairs() {
    let (temp, store, clock, writer) = setup(100);
    for index in 1..=MAX_DRAFT_ENTRIES {
        clock.set(100 + index as u64);
        store.write(request(index, 1, "x")).unwrap();
    }
    writer.fail_next_delete.store(true, Ordering::SeqCst);
    let error = store
        .write(request(MAX_DRAFT_ENTRIES + 1, 1, "incoming"))
        .unwrap_err();
    assert_eq!(error.code, CrashDraftErrorCode::CommittedNeedsRepair);
    assert_eq!(
        error.disposition,
        Some(CrashDraftPersistenceDisposition::ConfirmedCommitted)
    );
    assert_eq!(
        error.repair_required,
        Some(CrashDraftRepairRequired::LimitRepair)
    );
    assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
    let incoming = root(&temp).join(format!("{}.json", id(MAX_DRAFT_ENTRIES + 1)));
    assert!(!error.recovery_paths.contains(&incoming));
    assert_serialization_hides_paths(&error, temp.path());
    assert_eq!(
        store.list().unwrap_err().code,
        CrashDraftErrorCode::Capacity
    );
    drop(store);
    let restarted = CrashDraftStore::new(temp.path(), writer, clock);
    assert_eq!(
        restarted.repair_startup().unwrap().entries.len(),
        MAX_DRAFT_ENTRIES
    );
}
#[test]
fn backward_clock_revision_idempotency_and_token_conflicts_are_stable() {
    let (_temp, store, clock, writer) = setup(100);
    let first = store.write(request(1, 1, "a")).unwrap();
    clock.set(50);
    let second = store.write(request(2, 1, "b")).unwrap();
    assert_eq!(second.updated_at_ms, first.updated_at_ms + 1);
    writer.calls.lock().unwrap().clear();
    let mut unchanged = first.clone();
    unchanged.write_status = Some(CrashDraftWriteStatus::Unchanged);
    assert_eq!(store.write(request(1, 1, "a")).unwrap(), unchanged);
    assert!(writer.calls.lock().unwrap().is_empty());
    assert_eq!(
        store.write(request(1, 1, "changed")).unwrap_err().code,
        CrashDraftErrorCode::Conflict
    );
    let newer = store.write(request(1, 2, "new")).unwrap();
    assert_eq!(
        store.recover(&id(1), &first.entry_token).unwrap_err().code,
        CrashDraftErrorCode::Conflict
    );
    store.discard(&id(1), &newer.entry_token).unwrap();
}
#[test]
fn token_bound_reset_removes_protected_and_list_recover_never_probe_hint() {
    let (temp, store, _clock, _writer) = setup(100);
    let forbidden = temp.path().join("must-not-be-probed");
    let mut write = request(1, 1, "safe");
    write.path_hint = Some(forbidden.to_string_lossy().into_owned());
    write.base_version_token = Some("b".repeat(64));
    let summary = store.write(write).unwrap();
    assert!(!forbidden.exists());
    assert_eq!(
        store
            .recover(&id(1), &summary.entry_token)
            .unwrap()
            .envelope
            .content,
        "safe"
    );
    assert!(!forbidden.exists());
    fs::write(root(&temp).join(format!("{}.json", id(2))), b"corrupt").unwrap();
    let catalog = store.list().unwrap();
    assert_eq!(
        store.reset("stale").unwrap_err().code,
        CrashDraftErrorCode::Invalid
    );
    store.reset(&catalog.catalog_token).unwrap();
    assert!(store.list().unwrap().entries.is_empty());
}
#[cfg(unix)]
#[test]
fn storage_permissions_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, store, _clock, _writer) = setup(100);
    store.write(request(1, 1, "a")).unwrap();
    assert_eq!(
        fs::metadata(root(&temp)).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(root(&temp).join(LOCK_FILE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(root(&temp).join(format!("{}.json", id(1))))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn private_descriptor_policy_is_protected_and_principal_minimal() {
    assert!(PRIVATE_DIRECTORY_SDDL.starts_with("D:P"));
    assert!(PRIVATE_FILE_SDDL.starts_with("D:P"));
    assert_required_principals_hold_full_access();
    assert_eq!(PRIVATE_DIRECTORY_SDDL.matches(";FA;").count(), 3);
    assert_eq!(PRIVATE_FILE_SDDL.matches(";FA;").count(), 3);
    assert_eq!(PRIVATE_DIRECTORY_SDDL.matches("OICI").count(), 3);
    assert!(!PRIVATE_FILE_SDDL.contains("OICI"));
    assert_forbidden_principals_are_absent();
}
fn assert_required_principals_hold_full_access() {
    for principal in [";;;OW)", ";;;SY)", ";;;BA)"] {
        assert!(PRIVATE_DIRECTORY_SDDL.contains(principal));
        assert!(PRIVATE_FILE_SDDL.contains(principal));
    }
}
fn assert_forbidden_principals_are_absent() {
    for forbidden in [";;;WD)", ";;;BU)", ";;;AU)", ";;;AN)"] {
        assert!(!PRIVATE_DIRECTORY_SDDL.contains(forbidden));
        assert!(!PRIVATE_FILE_SDDL.contains(forbidden));
    }
}
