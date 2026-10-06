use super::test_prelude::*;
use super::*;

fn mismatched_retry(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    token: &OverwriteToken,
    path: &Path,
    other: &Path,
    mismatch: i32,
) -> Result<DocumentSaveDisposition, String> {
    let retry = |destination, bytes, operation_id, owner| {
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
        0 => retry(path, b"different", "op", MAIN_SAVE_OWNER),
        1 => retry(path, b"ours", "other-op", MAIN_SAVE_OWNER),
        2 => retry(path, b"ours", "op", "preview"),
        _ => retry(other, b"ours", "op", MAIN_SAVE_OWNER),
    }
}
#[test]
fn digest_operation_owner_and_path_mismatches_each_consume_token() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let other = dir.path().join("other.md");
    fs::write(&path, b"v1").unwrap();
    fs::write(&other, b"v1").unwrap();
    let authorization = FileAuthorizationSession::default();
    authorization
        .open_standalone_file(&path, |_| Ok(()), |_| Ok(()))
        .unwrap();
    authorization
        .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
        .unwrap();
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
    for mismatch in 0..4 {
        let token = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();
        let result = mismatched_retry(
            &coordinator,
            &authorization,
            &token,
            &path,
            &other,
            mismatch,
        );
        assert!(result.is_err());
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
    }
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn missing_destination_cannot_issue_overwrite_token() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("new.md");
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    assert!(DocumentSaveCoordinator::default()
        .issue_overwrite_token(
            &authorization,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            Some(&pending)
        )
        .is_err());
}
#[test]
fn cancellation_consumes_token_and_invalidates_pending_save_as() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    let coordinator = DocumentSaveCoordinator::default();
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
    coordinator
        .cancel_overwrite_token(&authorization, &token, &path, MAIN_SAVE_OWNER)
        .unwrap();
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
    assert!(coordinator
        .issue_overwrite_token(
            &authorization,
            &path,
            b"ours",
            "op-2",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .is_err());
}
#[test]
fn overwrite_token_store_is_capped_and_evicts_the_oldest_token() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = authorized_file(&path);
    let clock = Arc::new(FakeClock::new());
    let writer = Arc::new(CountingWriter::new());
    let coordinator = DocumentSaveCoordinator::with_ports(writer.clone(), clock.clone());
    let mut issued = Vec::new();
    for index in 0..=MAX_OVERWRITE_TOKENS {
        issued.push(
            coordinator
                .issue_overwrite_token(
                    &authorization,
                    &path,
                    b"ours",
                    &format!("op-{index}"),
                    MAIN_SAVE_OWNER,
                    None,
                )
                .unwrap(),
        );
        clock.advance(Duration::from_millis(1));
    }
    assert_eq!(
        coordinator.tokens.lock().unwrap().len(),
        MAX_OVERWRITE_TOKENS
    );
    assert!(coordinator
        .retry_with_token(
            &authorization,
            &issued[0],
            &path,
            b"ours",
            "op-0",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .is_err());
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn invalid_operation_ids_are_rejected_before_token_insertion() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = authorized_file(&path);
    let coordinator = DocumentSaveCoordinator::default();
    for operation_id in ["", "contains space", &"x".repeat(129)] {
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                operation_id,
                MAIN_SAVE_OWNER,
                None,
            )
            .is_err());
    }
    assert!(coordinator.tokens.lock().unwrap().is_empty());
}
