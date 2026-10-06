use super::test_prelude::*;
use super::*;

fn mismatch_setup(
    mismatch: i32,
) -> (
    tempfile::TempDir,
    PathBuf,
    PathBuf,
    FileAuthorizationSession,
    Arc<CountingWriter>,
    DocumentSaveCoordinator,
    OverwriteToken,
) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let other = dir.path().join("other.md");
    fs::write(&path, b"old").unwrap();
    fs::write(&other, b"other").unwrap();
    let authorization = FileAuthorizationSession::default();
    if mismatch == 3 {
        authorization
            .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
            .unwrap();
    }
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
    let token = coordinator
        .issue_overwrite_token(
            &authorization,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .unwrap();
    if mismatch == 7 {
        let generation = authorization.authorization_generation().unwrap();
        authorization
            .set_authorization_generation_for_test(generation + 1)
            .unwrap();
    }
    (dir, path, other, authorization, writer, coordinator, token)
}
fn mismatched_pending_retry(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    token: &OverwriteToken,
    path: &Path,
    other: &Path,
    mismatch: i32,
) -> Result<DocumentSaveDisposition, String> {
    let retry = |destination: &Path, bytes: &[u8], operation_id: &str, owner: &str| {
        coordinator.retry_with_token(
            authorization,
            token,
            destination,
            bytes,
            operation_id,
            owner,
            |_| Ok(()),
        )
    };
    match mismatch {
        0 => retry(path, b"ours", "op", "preview"),
        1 => retry(path, b"different", "op", MAIN_SAVE_OWNER),
        2 => retry(path, b"ours", "other-op", MAIN_SAVE_OWNER),
        3 | 4 => retry(other, b"ours", "op", MAIN_SAVE_OWNER),
        5 => retry(Path::new("relative.md"), b"ours", "op", MAIN_SAVE_OWNER),
        6 => coordinator.retry_with_token(
            authorization,
            token,
            path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Err("invalid editable content".into()),
        ),
        _ => retry(path, b"ours", "op", MAIN_SAVE_OWNER),
    }
}
#[test]
fn pending_token_mismatches_consume_token_invalidate_authority_and_skip_writer() {
    for mismatch in 0..8 {
        let (_dir, path, other, authorization, writer, coordinator, token) =
            mismatch_setup(mismatch);

        let result = mismatched_pending_retry(
            &coordinator,
            &authorization,
            &token,
            &path,
            &other,
            mismatch,
        );

        assert!(result.is_err(), "mismatch case {mismatch} must fail");
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .is_err());
        assert_eq!(
            authorization
                .pending_save_authority_count_for_test()
                .unwrap(),
            0
        );
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn only_one_concurrent_retry_reaches_the_writer() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = Arc::new(authorized_file(&path));
    let writer = Arc::new(CountingWriter::new());
    let coordinator = Arc::new(DocumentSaveCoordinator::with_ports(
        writer.clone(),
        Arc::new(SystemMonotonicClock),
    ));
    let token = Arc::new(
        coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap(),
    );
    let barrier = Arc::new(Barrier::new(3));
    let threads = (0..2)
        .map(|_| {
            let authorization = authorization.clone();
            let coordinator = coordinator.clone();
            let token = token.clone();
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                coordinator.retry_with_token(
                    &authorization,
                    &token,
                    path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(writer.calls.load(Ordering::SeqCst), 1);
}
fn assert_conflict_retry_invalidates_pending_authority(
    authorization: &FileAuthorizationSession,
    path: &Path,
) {
    let pending = authorization.reserve_pending_save_authority(path).unwrap();
    let coordinator = DocumentSaveCoordinator::default();
    let token = coordinator
        .issue_overwrite_token(
            authorization,
            path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .unwrap();
    fs::write(path, b"competitor").unwrap();
    let conflict = coordinator
        .retry_with_token(
            authorization,
            &token,
            path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .unwrap();
    assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
    assert!(coordinator
        .issue_overwrite_token(
            authorization,
            path,
            b"ours",
            "op-2",
            MAIN_SAVE_OWNER,
            Some(&pending)
        )
        .is_err());
    assert_eq!(
        authorization
            .pending_save_authority_count_for_test()
            .unwrap(),
        0
    );
}
fn assert_indeterminate_retry_invalidates_pending_authority(
    authorization: &FileAuthorizationSession,
    path: &Path,
) {
    let pending = authorization.reserve_pending_save_authority(path).unwrap();
    let failing = Arc::new(IndeterminateWriter {
        calls: AtomicUsize::new(0),
    });
    let coordinator =
        DocumentSaveCoordinator::with_ports(failing.clone(), Arc::new(SystemMonotonicClock));
    let token = coordinator
        .issue_overwrite_token(
            authorization,
            path,
            b"ours",
            "op-3",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .unwrap();
    let outcome = coordinator
        .retry_with_token(
            authorization,
            &token,
            path,
            b"ours",
            "op-3",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .unwrap();
    assert!(matches!(
        outcome,
        DocumentSaveDisposition::Indeterminate { .. }
    ));
    assert_eq!(failing.calls.load(Ordering::SeqCst), 1);
    assert!(coordinator
        .issue_overwrite_token(
            authorization,
            path,
            b"ours",
            "op-4",
            MAIN_SAVE_OWNER,
            Some(&pending)
        )
        .is_err());
}
#[test]
fn conflict_and_indeterminate_retries_invalidate_pending_authority() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = FileAuthorizationSession::default();

    assert_conflict_retry_invalidates_pending_authority(&authorization, &path);
    assert_indeterminate_retry_invalidates_pending_authority(&authorization, &path);
}
