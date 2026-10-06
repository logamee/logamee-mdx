use super::test_prelude::*;
use super::*;

fn issue_pending_token(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    path: &Path,
    bytes: &[u8],
    operation_id: &str,
    pending: &PendingSaveAuthority,
) -> OverwriteToken {
    coordinator
        .issue_overwrite_token(
            authorization,
            path,
            bytes,
            operation_id,
            MAIN_SAVE_OWNER,
            Some(pending),
        )
        .unwrap()
}
fn issue_file_token(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    path: &Path,
    bytes: &[u8],
    operation_id: &str,
) -> OverwriteToken {
    coordinator
        .issue_overwrite_token(
            authorization,
            path,
            bytes,
            operation_id,
            MAIN_SAVE_OWNER,
            None,
        )
        .unwrap()
}
fn retry_token(
    coordinator: &DocumentSaveCoordinator,
    authorization: &FileAuthorizationSession,
    token: &OverwriteToken,
    path: &Path,
    bytes: &[u8],
    operation_id: &str,
) -> Result<DocumentSaveDisposition, String> {
    coordinator.retry_with_token(
        authorization,
        token,
        path,
        bytes,
        operation_id,
        MAIN_SAVE_OWNER,
        |_| Ok(()),
    )
}

#[test]
fn confirmed_not_committed_invalidates_pending_authority() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(&path).unwrap();
    let coordinator = DocumentSaveCoordinator::with_ports(
        Arc::new(NotCommittedWriter),
        Arc::new(SystemMonotonicClock),
    );
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
    let outcome = coordinator
        .retry_with_token(
            &authorization,
            &token,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .unwrap();
    assert!(matches!(
        outcome,
        DocumentSaveDisposition::ConfirmedNotCommitted { .. }
    ));
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
    assert_eq!(
        authorization
            .pending_save_authority_count_for_test()
            .unwrap(),
        0
    );
}
#[test]
fn terminal_pending_transitions_are_infallible_at_generation_limit() {
    for indeterminate in [false, true] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = FileAuthorizationSession::default();
        authorization
            .set_authorization_generation_for_test(u64::MAX - 2)
            .unwrap();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let writer: Arc<dyn DocumentWriter> = if indeterminate {
            Arc::new(IndeterminateWriter {
                calls: AtomicUsize::new(0),
            })
        } else {
            Arc::new(CountingWriter::new())
        };
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer, Arc::new(SystemMonotonicClock));
        let token =
            issue_pending_token(&coordinator, &authorization, &path, b"ours", "op", &pending);
        let outcome =
            retry_token(&coordinator, &authorization, &token, &path, b"ours", "op").unwrap();
        if indeterminate {
            assert!(matches!(
                outcome,
                DocumentSaveDisposition::Indeterminate { .. }
            ));
        } else {
            assert!(matches!(
                outcome,
                DocumentSaveDisposition::ConfirmedCommitted { .. }
            ));
        }
        assert_eq!(authorization.authorization_generation().unwrap(), u64::MAX);
    }
}
#[test]
fn overwrite_token_observes_fresh_version_and_is_single_use() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"v1").unwrap();
    let authorization = authorized_file(&path);
    let coordinator = DocumentSaveCoordinator::default();
    let token = coordinator
        .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
        .unwrap();
    fs::write(&path, b"v2").unwrap();
    let conflict = coordinator
        .retry_with_token(
            &authorization,
            &token,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .unwrap();
    assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
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
#[test]
fn token_expires_at_exactly_sixty_seconds_and_mismatch_consumes_without_writer() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"v1").unwrap();
    let authorization = authorized_file(&path);
    let clock = Arc::new(FakeClock::new());
    let writer = Arc::new(CountingWriter::new());
    let coordinator = DocumentSaveCoordinator::with_ports(writer.clone(), clock.clone());
    let token_before_boundary =
        issue_file_token(&coordinator, &authorization, &path, b"ours", "op");
    clock.advance(Duration::from_secs(59));
    assert!(retry_token(
        &coordinator,
        &authorization,
        &token_before_boundary,
        &path,
        b"ours",
        "op"
    )
    .is_ok(),);
    let token = issue_file_token(&coordinator, &authorization, &path, b"next", "op-2");
    clock.advance(Duration::from_secs(60));
    assert!(retry_token(&coordinator, &authorization, &token, &path, b"next", "op-2").is_err());
    assert_eq!(writer.calls.load(Ordering::SeqCst), 1);
    assert!(retry_token(&coordinator, &authorization, &token, &path, b"ours", "op").is_err());
}
