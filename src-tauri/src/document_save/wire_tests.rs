use super::test_prelude::*;

#[test]
fn writer_runs_while_authorization_is_held_and_after_token_is_consumed() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let authorization = authorized_file(&path);
    let coordinator = DocumentSaveCoordinator::with_ports(
        Arc::new(AuthorizationAssertingWriter),
        Arc::new(SystemMonotonicClock),
    );
    let token = coordinator
        .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
        .unwrap();
    let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
        coordinator.retry_with_token(
            &authorization,
            &token,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
    });
    assert!(result.is_ok());
    assert_eq!(
        events.first(),
        Some(&crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired)
    );
    assert_eq!(
        events.last(),
        Some(&crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased)
    );
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
fn confirmed_retry_returns_prevalidated_path_without_post_commit_filesystem_checks() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, b"old").unwrap();
    let canonical_path = path.canonicalize().unwrap();
    let authorization = authorized_file(&path);
    let coordinator = DocumentSaveCoordinator::with_ports(
        Arc::new(CommitThenRemoveWriter),
        Arc::new(SystemMonotonicClock),
    );
    let token = coordinator
        .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
        .unwrap();

    let (response_path, disposition) = coordinator
        .retry_with_token_and_path(
            &authorization,
            &token,
            &path,
            b"ours",
            "op",
            MAIN_SAVE_OWNER,
            |_| Ok(()),
        )
        .unwrap();

    assert_eq!(response_path, canonical_path);
    assert!(matches!(
        disposition,
        DocumentSaveDisposition::ConfirmedCommitted { .. }
    ));
}
fn committed_outcome_pairs(
    version: &FileVersion,
    recovery: &Path,
) -> Vec<(DurableWriteOutcome, DocumentSaveDisposition)> {
    vec![
        (
            DurableWriteOutcome::ConfirmedCommitted {
                version: version.clone(),
                displaced_path: Some(PathBuf::from("displaced")),
            },
            DocumentSaveDisposition::ConfirmedCommitted {
                version: version.clone(),
                displaced_path: Some(PathBuf::from("displaced")),
            },
        ),
        (
            DurableWriteOutcome::ConfirmedNotCommitted {
                current_version: Some(version.clone()),
                recovery_paths: vec![recovery.to_path_buf()],
                message: "no".into(),
            },
            DocumentSaveDisposition::ConfirmedNotCommitted {
                current_version: Some(version.clone()),
                recovery_paths: vec![recovery.to_path_buf()],
                message: "no".into(),
            },
        ),
    ]
}
fn conflict_and_indeterminate_outcome_pairs(
    version: &FileVersion,
    recovery: &Path,
) -> Vec<(DurableWriteOutcome, DocumentSaveDisposition)> {
    vec![
        (
            DurableWriteOutcome::Conflict {
                current_version: Some(version.clone()),
                recovery_path: recovery.to_path_buf(),
            },
            DocumentSaveDisposition::Conflict {
                current_version: Some(version.clone()),
                recovery_path: recovery.to_path_buf(),
                overwrite_token: None,
            },
        ),
        (
            DurableWriteOutcome::Indeterminate {
                message: "unknown".into(),
                recovery_paths: vec![recovery.to_path_buf()],
            },
            DocumentSaveDisposition::Indeterminate {
                message: "unknown".into(),
                recovery_paths: vec![recovery.to_path_buf()],
            },
        ),
    ]
}
#[test]
fn durable_outcome_mapping_preserves_all_four_dispositions() {
    let version: FileVersion = serde_json::from_value(serde_json::json!({
        "canonicalPath": "/tmp/note.md",
        "platformIdentity": "1:2",
        "length": "1",
        "modifiedNanos": "2",
        "sha256": "a".repeat(64),
    }))
    .unwrap();
    let recovery = PathBuf::from("recovery");
    let mut outcomes = committed_outcome_pairs(&version, &recovery);
    outcomes.extend(conflict_and_indeterminate_outcome_pairs(
        &version, &recovery,
    ));
    for (outcome, expected) in outcomes {
        assert_eq!(DocumentSaveDisposition::from(outcome), expected);
    }
}
