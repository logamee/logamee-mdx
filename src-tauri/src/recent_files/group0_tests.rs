use super::test_prelude::*;
use super::*;

#[test]
fn classifies_retryable_lock_contention_errors() {
    assert!(is_retryable_lock_contention(&io::Error::from(
        io::ErrorKind::WouldBlock
    )));

    #[cfg(windows)]
    assert!(is_retryable_lock_contention(&io::Error::from_raw_os_error(
        super::WINDOWS_ERROR_LOCK_VIOLATION
    )));

    assert!(!is_retryable_lock_contention(&io::Error::from(
        io::ErrorKind::PermissionDenied
    )));
}
fn canonical_target(path: &str) -> Option<String> {
    let canonical_a = absolute_path("docs/a.md");
    if path == canonical_a || path == absolute_path("alias/a.md") {
        return Some(canonical_a);
    }
    [
        "docs/b.md",
        "docs/c.html",
        "docs/d.md",
        "docs/e.md",
        "docs/f.md",
    ]
    .into_iter()
    .map(absolute_path)
    .find(|candidate| candidate == path)
}
#[test]
fn repairs_untrusted_v1_entries_in_order_and_serializes_the_exact_schema() {
    let canonical_a = absolute_path("docs/a.md");
    let alias_a = absolute_path("alias/a.md");
    let canonical_b = absolute_path("docs/b.md");
    let canonical_c = absolute_path("docs/c.html");
    let missing = absolute_path("missing.md");
    let canonical_d = absolute_path("docs/d.md");
    let canonical_e = absolute_path("docs/e.md");
    let canonical_f = absolute_path("docs/f.md");
    let bytes = serde_json::to_vec(&json!({
        "version": 1,
        "entries": [
            { "id": ID_A, "canonicalTarget": &canonical_a },
            { "id": ID_B, "canonicalTarget": &alias_a },
            { "id": ID_A, "canonicalTarget": &canonical_b },
            { "id": "not-random", "canonicalTarget": &canonical_c },
            { "id": ID_C, "canonicalTarget": &missing },
            { "id": ID_D, "canonicalTarget": &canonical_d },
            { "id": ID_E, "canonicalTarget": &canonical_e },
            { "id": ID_F, "canonicalTarget": &canonical_f }
        ]
    }))
    .unwrap();

    let (store, repaired) = repair_store_bytes(&bytes, canonical_target);

    assert!(repaired);
    assert_eq!(
        store.entries,
        vec![
            RecentFileEntryV1::new(ID_A, &canonical_a),
            RecentFileEntryV1::new(ID_D, &canonical_d),
            RecentFileEntryV1::new(ID_E, &canonical_e),
            RecentFileEntryV1::new(ID_F, &canonical_f),
        ]
    );
    assert_eq!(
        serde_json::to_value(store).unwrap(),
        json!({
            "version": 1,
            "entries": [
                { "id": ID_A, "canonicalTarget": &canonical_a },
                { "id": ID_D, "canonicalTarget": &canonical_d },
                { "id": ID_E, "canonicalTarget": &canonical_e },
                { "id": ID_F, "canonicalTarget": &canonical_f }
            ]
        })
    );
}
#[test]
fn invalid_envelopes_and_oversized_documents_repair_to_empty_v1() {
    for bytes in [
        br#"{"version":2,"entries":[]}"#.as_slice(),
        br#"{"version":1,"entries":[],"extra":true}"#.as_slice(),
        br#"{"version":1,"entries":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonicalTarget":"/docs/a.md","extra":true}]}"#.as_slice(),
        b"not json".as_slice(),
        vec![b' '; 64 * 1024 + 1].as_slice(),
    ] {
        let (store, repaired) = repair_store_bytes(bytes, canonical_target);
        assert!(repaired);
        assert_eq!(store, RecentFileStoreV1::empty());
    }
}
#[test]
fn promotion_deduplicates_by_canonical_target_and_evicts_after_five() {
    let mut store = RecentFileStoreV1::empty();
    let mut ids = VecDeque::from([ID_A, ID_B, ID_C, ID_D, ID_E, ID_F]);
    let mut next_id = || Ok(ids.pop_front().unwrap().to_string());

    for target in ["a.md", "b.md", "c.html", "d.md", "e.md", "f.md"] {
        store
            .promote(absolute_path(Path::new("docs").join(target)), &mut next_id)
            .unwrap();
    }

    assert_eq!(
        store
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec![ID_F, ID_E, ID_D, ID_C, ID_B]
    );

    store
        .promote(
            absolute_path(Path::new("docs").join("c.html")),
            &mut next_id,
        )
        .unwrap();
    assert_eq!(
        store
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec![ID_C, ID_F, ID_E, ID_D, ID_B]
    );
}
#[test]
fn complete_store_serialization_rejects_duplicate_ids_and_targets() {
    let duplicate_id = RecentFileStoreV1 {
        version: 1,
        entries: vec![
            RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md")),
            RecentFileEntryV1::new(ID_A, absolute_path("docs/b.md")),
        ],
    };
    let duplicate_target = RecentFileStoreV1 {
        version: 1,
        entries: vec![
            RecentFileEntryV1::new(ID_A, absolute_path("docs/a.md")),
            RecentFileEntryV1::new(ID_B, absolute_path("docs/a.md")),
        ],
    };

    assert!(serialize_complete_store(&duplicate_id).is_err());
    assert!(serialize_complete_store(&duplicate_target).is_err());
}
#[test]
fn pending_receipts_expire_at_thirty_seconds_and_evict_the_oldest_at_thirty_two() {
    let mut runtime = RecentRuntime::default();
    let issued_at = Duration::from_secs(4);

    for index in 0..33 {
        runtime
            .issue(
                "main",
                absolute_path(format!("docs/{index}.md")),
                None,
                issued_at,
                opaque_id(index * 2 + 1),
                opaque_id(index * 2 + 2),
            )
            .unwrap();
    }

    assert_eq!(runtime.pending_len(), 32);
    assert!(runtime
        .take_receipt(&opaque_id(1), "main", issued_at)
        .is_none());
    let newest = runtime
        .take_receipt(&opaque_id(65), "main", issued_at)
        .expect("newest receipt remains live");
    assert_eq!(newest.commit_operation_id, opaque_id(66));

    runtime.prune(Duration::from_secs(34));
    assert_eq!(runtime.pending_len(), 0);
}
fn issue_owner_documents(runtime: &mut RecentRuntime, now: Duration) {
    for (owner, target, open_id, commit_id) in [
        ("main", "docs/a.md", 1, 2),
        ("editor", "docs/b.md", 3, 4),
        ("main", "docs/c.md", 5, 6),
    ] {
        runtime
            .issue(
                owner,
                absolute_path(target),
                None,
                now,
                opaque_id(open_id),
                opaque_id(commit_id),
            )
            .unwrap();
    }
}
#[test]
fn receipt_discard_owner_close_shutdown_and_replay_never_cross_owner_boundaries() {
    let mut runtime = RecentRuntime::default();
    let now = Duration::from_secs(1);
    issue_owner_documents(&mut runtime, now);

    assert!(!runtime.discard_receipt(&opaque_id(1), "editor", now));
    assert!(runtime.discard_receipt(&opaque_id(1), "main", now));
    assert!(!runtime.discard_receipt(&opaque_id(1), "main", now));

    runtime.remove_owner("main", now);
    assert_eq!(runtime.pending_len(), 1);
    assert!(runtime.take_receipt(&opaque_id(3), "editor", now).is_some());
    assert!(runtime.take_receipt(&opaque_id(5), "main", now).is_none());

    runtime
        .issue(
            "editor",
            absolute_path("docs/d.md"),
            None,
            now,
            opaque_id(7),
            opaque_id(8),
        )
        .unwrap();
    runtime.shutdown(now);
    assert_eq!(runtime.pending_len(), 0);
    assert!(runtime.take_receipt(&opaque_id(7), "editor", now).is_none());
}
