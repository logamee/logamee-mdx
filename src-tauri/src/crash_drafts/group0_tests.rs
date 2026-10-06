use super::test_prelude::*;

fn uppercase_id_request() -> CrashDraftWriteRequest {
    let mut invalid = request(1, 1, "text");
    invalid.document_id = "ABC/path-derived".into();
    invalid
}

fn unpaired_hint_request() -> CrashDraftWriteRequest {
    let mut unpaired = request(3, 1, "x");
    unpaired.path_hint = Some("/hint".into());
    unpaired
}

fn oversized_path_request() -> CrashDraftWriteRequest {
    let mut long_path = request(3, 1, "x");
    long_path.path_hint = Some("p".repeat(MAX_PATH_HINT_BYTES + 1));
    long_path.base_version_token = Some("b".repeat(64));
    long_path
}

#[test]
fn validates_opaque_untitled_pair_unicode_and_size_contracts() {
    let (_temp, store, _clock, _writer) = setup(10);
    assert_eq!(
        store.write(uppercase_id_request()).unwrap_err().code,
        CrashDraftErrorCode::Invalid
    );
    assert_eq!(
        store.write(request(1, 0, "")).unwrap_err().code,
        CrashDraftErrorCode::Invalid
    );
    let empty = store.write(request(1, 1, "")).unwrap();
    assert_eq!(empty.path_hint, None);
    let unicode = store.write(request(2, 1, "你好\n🙂\nمرحبا")).unwrap();
    assert_eq!(
        store
            .recover(&id(2), &unicode.entry_token)
            .unwrap()
            .envelope
            .content,
        "你好\n🙂\nمرحبا"
    );
    assert_eq!(
        store.write(unpaired_hint_request()).unwrap_err().code,
        CrashDraftErrorCode::Invalid
    );
    assert_eq!(
        store.write(oversized_path_request()).unwrap_err().code,
        CrashDraftErrorCode::Oversized
    );
    assert_eq!(
        store
            .write(request(3, 1, "x".repeat(MAX_DRAFT_CONTENT_BYTES + 1)))
            .unwrap_err()
            .code,
        CrashDraftErrorCode::Oversized
    );
    assert_eq!(
        store
            .write(request(3, JS_SAFE_INTEGER + 1, "x"))
            .unwrap_err()
            .code,
        CrashDraftErrorCode::Invalid
    );
    store
        .write(request(4, JS_SAFE_INTEGER, "max revision"))
        .unwrap();
}
#[test]
fn validates_path_hint_controls_and_exact_base_token_format() {
    let (_temp, store, _clock, _writer) = setup(10);
    let mut valid = request(1, 1, "x");
    valid.path_hint = Some("C:\\notes\\文档.md".into());
    valid.base_version_token = Some("a".repeat(64));
    store.write(valid).unwrap();

    for (index, path) in [
        "/notes/bad\nname.md",
        "/notes/bad\0name.md",
        "/notes/\u{200b}name.md",
        "/notes/\u{202e}name.md",
    ]
    .into_iter()
    .enumerate()
    {
        let mut invalid = request(index + 2, 1, "x");
        invalid.path_hint = Some(path.into());
        invalid.base_version_token = Some("b".repeat(64));
        assert_eq!(
            store.write(invalid).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
    }

    for (index, token) in [
        "a".repeat(63),
        "A".repeat(64),
        format!("{}\n", "a".repeat(63)),
    ]
    .into_iter()
    .enumerate()
    {
        let mut invalid = request(index + 10, 1, "x");
        invalid.path_hint = Some("/notes/file.md".into());
        invalid.base_version_token = Some(token);
        assert_eq!(
            store.write(invalid).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
    }
}
fn drain_overflow_in_bounded_batches(
    store: &CrashDraftStore<TestWriter, TestClock>,
    initial_receipt: &str,
) -> (usize, String) {
    let mut receipt = initial_receipt.to_owned();
    let mut total_removed = 0usize;
    for _ in 0..8 {
        let progress = store.reset_overflow_batch(&receipt).unwrap();
        assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
        total_removed += progress.removed_entries;
        if !progress.more_work_remaining {
            break;
        }
        receipt = progress.repair_receipt.unwrap();
    }
    (total_removed, receipt)
}
#[test]
fn directory_scan_is_bounded_before_candidate_processing() {
    let (temp, store, _clock, writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    for index in 0..MAX_CRASH_DRAFT_DIRECTORY_ENTRIES {
        fs::write(root(&temp).join(format!("unrelated-{index}.tmp")), b"x").unwrap();
    }
    let error = store.list().unwrap_err();
    assert_eq!(error.code, CrashDraftErrorCode::Capacity);
    let receipt = error.repair_receipt.unwrap();
    assert_opaque_receipt(&receipt);
    assert!(writer.calls.lock().unwrap().is_empty());
    assert_eq!(
        store.reset_overflow_batch("stale").unwrap_err().code,
        CrashDraftErrorCode::Invalid
    );
    let (total_removed, receipt) = drain_overflow_in_bounded_batches(&store, &receipt);
    assert_eq!(total_removed, MAX_CRASH_DRAFT_DIRECTORY_ENTRIES);
    assert!(store.list().unwrap().entries.is_empty());
    assert_eq!(
        store.reset_overflow_batch(&receipt).unwrap_err().code,
        CrashDraftErrorCode::Conflict
    );
    assert!(writer
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|call| call == "delete:exact"));
}
#[test]
fn protected_logical_count_overflow_issues_restartable_bounded_reset_receipts() {
    let (temp, store, clock, writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    for index in 0..(MAX_DRAFT_ENTRIES + 1) {
        fs::write(root(&temp).join(format!("{}.json", id(index))), b"invalid").unwrap();
    }
    let first = store.list().unwrap_err().repair_receipt.unwrap();
    assert_opaque_receipt(&first);
    drop(store);

    let restarted = CrashDraftStore::new(temp.path(), writer, clock);
    let mut receipt = restarted.list().unwrap_err().repair_receipt.unwrap();
    assert_ne!(first, receipt);
    let mut removed = 0;
    loop {
        let progress = restarted.reset_overflow_batch(&receipt).unwrap();
        assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
        removed += progress.removed_entries;
        if !progress.more_work_remaining {
            break;
        }
        receipt = progress.repair_receipt.unwrap();
    }
    assert_eq!(removed, MAX_DRAFT_ENTRIES + 1);
    assert!(restarted.list().unwrap().entries.is_empty());
}
#[test]
fn protected_logical_byte_overflow_issues_a_bounded_reset_receipt() {
    let (temp, store, _clock, _writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    let oversized = vec![b'x'; MAX_DRAFT_ENVELOPE_BYTES + 1];
    for index in 0..4 {
        fs::write(root(&temp).join(format!("{}.json", id(index))), &oversized).unwrap();
    }
    let error = store.list().unwrap_err();
    assert_eq!(error.code, CrashDraftErrorCode::Capacity);
    let receipt = error.repair_receipt.unwrap();
    let progress = store.reset_overflow_batch(&receipt).unwrap();
    assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
}
#[test]
fn malformed_boundary_tokens_are_rejected_before_lock_or_scan() {
    let (temp, store, _clock, writer) = setup(10);
    for malformed in ["", "a", &"A".repeat(64), &"a".repeat(65)] {
        assert_eq!(
            store.recover(&id(1), malformed).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        assert_eq!(
            store.discard(&id(1), malformed).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        assert_eq!(
            store.reset(malformed).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
        assert_eq!(
            store.reset_overflow_batch(malformed).unwrap_err().code,
            CrashDraftErrorCode::Invalid
        );
    }
    assert!(!root(&temp).exists());
    assert!(writer.calls.lock().unwrap().is_empty());
}
#[test]
fn retained_artifact_blocks_healthy_list_and_write_until_receipted_cleanup() {
    let (temp, store, _clock, _writer) = setup(10);
    store.write(request(1, 1, "safe")).unwrap();
    fs::write(
        root(&temp).join(".draft.json.recovery-retained"),
        b"private",
    )
    .unwrap();

    let error = store.list().unwrap_err();
    let receipt = error.repair_receipt.unwrap();
    assert_eq!(error.code, CrashDraftErrorCode::Capacity);
    assert_eq!(
        store.write(request(2, 1, "blocked")).unwrap_err().code,
        CrashDraftErrorCode::Capacity
    );
    let replacement_receipt = store.list().unwrap_err().repair_receipt.unwrap();
    assert_ne!(receipt, replacement_receipt);
    let progress = store.reset_overflow_batch(&replacement_receipt).unwrap();
    assert!(progress.removed_entries <= OVERFLOW_RESET_DELETE_BATCH);
    assert!(store.list().unwrap().entries.len() <= 1);
}
#[test]
fn repair_receipt_is_bound_to_the_scanned_physical_store_fingerprint() {
    let (temp, store, _clock, writer) = setup(10);
    fs::create_dir_all(root(&temp)).unwrap();
    let artifact = root(&temp).join(".draft.json.recovery-retained");
    fs::write(&artifact, b"first").unwrap();
    let receipt = store.list().unwrap_err().repair_receipt.unwrap();
    fs::write(&artifact, b"other").unwrap();

    assert_eq!(
        store.reset_overflow_batch(&receipt).unwrap_err().code,
        CrashDraftErrorCode::Conflict
    );
    assert_eq!(fs::read(&artifact).unwrap(), b"other");
    assert!(writer.calls.lock().unwrap().is_empty());
    assert_eq!(
        store.reset_overflow_batch(&receipt).unwrap_err().code,
        CrashDraftErrorCode::Conflict
    );
}
