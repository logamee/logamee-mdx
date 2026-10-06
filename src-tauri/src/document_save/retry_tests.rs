use super::test_prelude::*;
use super::*;

#[test]
fn invalid_operation_ids_are_rejected_by_direct_saves_before_writer_or_auth_mutation() {
    let dir = tempdir().unwrap();
    let existing = dir.path().join("existing.md");
    let new_path = dir.path().join("new.md");
    fs::write(&existing, b"old").unwrap();
    let authorization = authorized_file(&existing);
    let pending = authorization
        .reserve_pending_save_authority(&new_path)
        .unwrap();
    let generation = authorization.authorization_generation().unwrap();
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
    let expected = capture_file_version(&existing).unwrap().unwrap();

    assert!(coordinator
        .save_expected(
            &authorization,
            &existing,
            b"ours",
            expected,
            "contains space",
            MAIN_SAVE_OWNER,
        )
        .is_err());
    assert!(coordinator
        .save_as_expected(
            &authorization,
            &pending,
            &new_path,
            b"ours",
            "",
            MAIN_SAVE_OWNER,
        )
        .is_err());
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        authorization.authorization_generation().unwrap(),
        generation
    );
    assert!(authorization
        .with_save_authorization_scope(&new_path, |scope| Ok(scope.matches_pending(&pending)))
        .unwrap());
}
#[test]
fn abandoned_pending_save_authorities_are_bounded_and_cancellable_before_token_issue() {
    let dir = tempdir().unwrap();
    let authorization = FileAuthorizationSession::default();
    let mut previous = None;
    for index in 0..256 {
        let pending = authorization
            .reserve_pending_save_authority(dir.path().join(format!("note-{index}.md")))
            .unwrap();
        assert_eq!(
            authorization
                .pending_save_authority_count_for_test()
                .unwrap(),
            1
        );
        if let Some(previous) = previous.replace(pending) {
            assert!(!authorization
                .cancel_pending_save_authority(&previous)
                .unwrap());
        }
    }
    let active = previous.unwrap();
    assert!(authorization
        .cancel_pending_save_authority(&active)
        .unwrap());
    assert_eq!(
        authorization
            .pending_save_authority_count_for_test()
            .unwrap(),
        0
    );
    assert!(!authorization
        .cancel_pending_save_authority(&active)
        .unwrap());
}
#[test]
fn overwrite_token_wire_parser_accepts_only_canonical_random_id_shape() {
    let valid = "a".repeat(64);
    assert_eq!(OverwriteToken::from_wire(&valid).unwrap().as_str(), valid);
    for invalid in ["", "a", &"A".repeat(64), &"g".repeat(64), &"a".repeat(65)] {
        assert!(OverwriteToken::from_wire(invalid).is_err());
    }
}
fn assert_expiry_invalidates_pending_authority(path: &Path) {
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(path).unwrap();
    let clock = Arc::new(FakeClock::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(Arc::new(CountingWriter::new()), clock.clone());
    let expired = coordinator
        .issue_overwrite_token(
            &authorization,
            path,
            b"ours",
            "expired",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .unwrap();
    clock.advance(OVERWRITE_TOKEN_TTL);
    assert!(coordinator
        .retry_with_token(
            &authorization,
            &expired,
            path,
            b"ours",
            "expired",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .is_err());
    assert!(coordinator
        .issue_overwrite_token(
            &authorization,
            path,
            b"ours",
            "after-expiry",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .is_err());
}
fn assert_capacity_eviction_invalidates_pending_authority(path: &Path) {
    let authorization = FileAuthorizationSession::default();
    let pending = authorization.reserve_pending_save_authority(path).unwrap();
    let coordinator = DocumentSaveCoordinator::default();
    for index in 0..MAX_OVERWRITE_TOKENS {
        coordinator
            .issue_overwrite_token(
                &authorization,
                path,
                b"ours",
                &format!("op-{index}"),
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
    }
    assert!(coordinator
        .issue_overwrite_token(
            &authorization,
            path,
            b"ours",
            "evict",
            MAIN_SAVE_OWNER,
            Some(&pending),
        )
        .is_err());
    assert_eq!(
        coordinator.tokens.lock().unwrap().len(),
        MAX_OVERWRITE_TOKENS - 1
    );
    assert!(authorization
        .with_save_authorization_scope(path, |scope| Ok(scope.matches_pending(&pending)))
        .is_ok_and(|active| !active));
}
#[test]
fn expiry_and_capacity_eviction_invalidate_pending_authority() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();

    assert_expiry_invalidates_pending_authority(&path);
    assert_capacity_eviction_invalidates_pending_authority(&path);
}
#[test]
fn authorization_generation_mismatch_consumes_token_without_writer() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let other = dir.path().join("other.md");
    fs::write(&path, b"old").unwrap();
    fs::write(&other, b"other").unwrap();
    let authorization = authorized_file(&path);
    let writer = Arc::new(CountingWriter::new());
    let coordinator =
        DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
    let token = coordinator
        .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
        .unwrap();
    authorization
        .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
        .unwrap();
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
    assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
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
