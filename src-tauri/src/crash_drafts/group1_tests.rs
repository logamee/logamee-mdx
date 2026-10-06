use super::test_prelude::*;

#[test]
fn total_size_accounting_rejects_integer_overflow() {
    let entries = vec![
        ScannedEntry::Protected {
            document_id: id(1),
            path: PathBuf::from("one"),
            size: u64::MAX,
            token: "one".into(),
            version: "one".to_string(),
            reason: ProtectedDraftReason::Oversized,
            future_schema_version: None,
        },
        ScannedEntry::Protected {
            document_id: id(2),
            path: PathBuf::from("two"),
            size: 1,
            token: "two".into(),
            version: "two".to_string(),
            reason: ProtectedDraftReason::Oversized,
            future_schema_version: None,
        },
    ];
    assert_eq!(
        checked_total_size(&entries).unwrap_err().code,
        CrashDraftErrorCode::Capacity
    );
    assert_eq!(
        ensure_protected_capacity(&entries[..1], &id(3), 1)
            .unwrap_err()
            .code,
        CrashDraftErrorCode::Capacity
    );
}
#[test]
fn checksum_binds_all_metadata_and_content() {
    let (_temp, store, _clock, _writer) = setup(10);
    let summary = store.write(request(1, 1, "text")).unwrap();
    let original = store
        .recover(&id(1), &summary.entry_token)
        .unwrap()
        .envelope;
    let checksum = envelope_checksum(&original);
    let mut variants = Vec::new();
    let mut value = original.clone();
    value.schema_version += 1;
    variants.push(value);
    let mut value = original.clone();
    value.document_id = id(2);
    variants.push(value);
    let mut value = original.clone();
    value.file_kind = CrashDraftFileKind::Html;
    variants.push(value);
    let mut value = original.clone();
    value.revision += 1;
    variants.push(value);
    let mut value = original.clone();
    value.updated_at_ms += 1;
    variants.push(value);
    let mut value = original.clone();
    value.path_hint = Some("/p".into());
    variants.push(value);
    let mut value = original.clone();
    value.base_version_token = Some("v".into());
    variants.push(value);
    let mut value = original;
    value.content.push('!');
    variants.push(value);
    assert!(variants
        .into_iter()
        .all(|value| envelope_checksum(&value) != checksum));
}
#[test]
fn write_uses_expected_absent_then_exact_and_revision_is_not_the_cas() {
    let (_temp, store, _clock, writer) = setup(10);
    let first = store.write(request(1, 1, "a")).unwrap();
    let second = store.write(request(1, 2, "b")).unwrap();
    assert_eq!(first.write_status, Some(CrashDraftWriteStatus::Stored));
    assert_eq!(second.write_status, Some(CrashDraftWriteStatus::Stored));
    assert_eq!(
        writer.calls.lock().unwrap().as_slice(),
        ["persist:absent", "persist:exact"]
    );
}
#[derive(Clone)]
struct OutcomeWriter {
    inner: TestWriter,
    outcome: Arc<Mutex<Option<&'static str>>>,
}
impl DraftWritePort for OutcomeWriter {
    type Version = String;

    fn observe(&self, path: &Path, max: usize) -> Result<DraftObservation<String>, String> {
        self.inner.observe(path, max)
    }

    fn persist(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: ExpectedDraftState<String>,
    ) -> DraftWriteOutcome<String> {
        match self.outcome.lock().unwrap().take() {
            Some("not_committed") => DraftWriteOutcome::ConfirmedNotCommitted {
                current_version: TestWriter::version(destination),
                recovery_paths: vec![destination.with_extension("recovery")],
            },
            Some("conflict") => DraftWriteOutcome::Conflict {
                current_version: TestWriter::version(destination),
                recovery_paths: vec![destination.with_extension("conflict")],
            },
            Some("indeterminate") => {
                TestWriter::overwrite(destination, bytes);
                DraftWriteOutcome::Indeterminate {
                    recovery_paths: vec![destination.to_path_buf()],
                }
            }
            Some("committed_recovery") => {
                match self.inner.persist(destination, bytes, expected) {
                    DraftWriteOutcome::ConfirmedCommitted {
                        version,
                        version_token,
                        ..
                    } => DraftWriteOutcome::ConfirmedCommitted {
                        version,
                        version_token,
                        recovery_paths: vec![destination.with_extension("displaced")],
                    },
                    outcome => outcome,
                }
            }
            _ => self.inner.persist(destination, bytes, expected),
        }
    }

    fn remove_exact(&self, path: &Path, expected: &String) -> DraftDeleteOutcome<String> {
        self.inner.remove_exact(path, expected)
    }
}
#[test]
fn maps_not_committed_conflict_and_post_mutation_indeterminate_with_evidence() {
    for (outcome, disposition) in [
        (
            "not_committed",
            CrashDraftPersistenceDisposition::ConfirmedNotCommitted,
        ),
        ("conflict", CrashDraftPersistenceDisposition::Conflict),
        (
            "indeterminate",
            CrashDraftPersistenceDisposition::Indeterminate,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let writer = OutcomeWriter {
            inner: TestWriter::default(),
            outcome: Arc::new(Mutex::new(None)),
        };
        let control = writer.outcome.clone();
        let store = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
        store.write(request(1, 1, "old material")).unwrap();
        *control.lock().unwrap() = Some(outcome);
        let error = store.write(request(1, 2, "new material")).unwrap_err();
        assert_eq!(error.disposition, Some(disposition));
        assert!(!error.recovery_paths.is_empty());
        assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
        assert_serialization_hides_paths(&error, temp.path());
        if outcome == "indeterminate" {
            let bytes = fs::read(root(&temp).join(format!("{}.json", id(1)))).unwrap();
            assert!(String::from_utf8(bytes).unwrap().contains("new material"));
        } else {
            let catalog = store.list().unwrap();
            let draft = supported(&catalog)[0];
            assert_eq!(
                store
                    .recover(&id(1), &draft.entry_token)
                    .unwrap()
                    .envelope
                    .content,
                "old material"
            );
        }
    }
}
#[test]
fn confirmed_commit_preserves_recovery_evidence_in_the_write_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let writer = OutcomeWriter {
        inner: TestWriter::default(),
        outcome: Arc::new(Mutex::new(Some("committed_recovery"))),
    };
    let store = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
    let receipt = store.write(request(1, 1, "material")).unwrap();
    assert_eq!(
        receipt.recovery_paths,
        [root(&temp)
            .join(format!("{}.json", id(1)))
            .with_extension("displaced")]
    );
    assert_eq!(
        receipt.repair_required,
        Some(CrashDraftRepairRequired::CleanupRepair)
    );
    assert_opaque_receipt(receipt.repair_receipt.as_deref().unwrap());
    assert_serialization_hides_paths(&receipt, temp.path());
}
#[test]
fn padded_oversized_corrupt_and_future_entries_are_protected_without_leaks() {
    let (temp, store, _clock, _writer) = setup(10);
    seed_protected_entry_candidates(&temp);
    let valid = store.write(request(4, 1, "valid")).unwrap();
    let strict_path = root(&temp).join(format!("{}.json", id(4)));
    let mut strict_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&strict_path).unwrap()).unwrap();
    strict_value["unknownField"] = serde_json::Value::Bool(true);
    fs::write(&strict_path, serde_json::to_vec(&strict_value).unwrap()).unwrap();
    let catalog = store.list().unwrap();
    assert_future_protected_entry(&catalog, &id(3));
    let json = serde_json::to_string(&catalog).unwrap();
    assert!(!json.contains("secret"));
    assert!(!json.contains("rawSizeBytes"));
    assert!(!json.contains("futureSchemaVersion"));
    assert!(json.contains("oversized"));
    assert!(json.contains("corrupt"));
    assert!(json.contains("unsupported_schema"));
    assert!(catalog.entries.iter().any(|entry| matches!(
        entry,
        CrashDraftListEntry::Protected { document_id, reason: ProtectedDraftReason::Corrupt, .. }
            if *document_id == valid.document_id
    )));
}
fn seed_protected_entry_candidates(temp: &TempDir) {
    fs::create_dir_all(root(temp)).unwrap();
    fs::write(
        root(temp).join(format!("{}.json", id(1))),
        vec![b' '; MAX_DRAFT_ENVELOPE_BYTES + 1],
    )
    .unwrap();
    fs::write(
        root(temp).join(format!("{}.json", id(2))),
        br#"{"pathHint":"secret","content":"secret"}"#,
    )
    .unwrap();
    fs::write(
        root(temp).join(format!("{}.json", id(3))),
        br#"{"schemaVersion":2,"pathHint":"future-secret"}"#,
    )
    .unwrap();
}
fn assert_future_protected_entry(catalog: &CrashDraftCatalog, expected: &str) {
    let future = catalog
        .entries
        .iter()
        .find(|entry| {
            matches!(
                entry,
                CrashDraftListEntry::Protected { document_id, .. } if *document_id == expected
            )
        })
        .unwrap();
    match future {
        CrashDraftListEntry::Protected {
            raw_size_bytes,
            future_schema_version,
            ..
        } => {
            assert!(*raw_size_bytes > 0);
            assert_eq!(*future_schema_version, Some(2));
        }
        CrashDraftListEntry::Supported { .. } => unreachable!(),
    }
}
