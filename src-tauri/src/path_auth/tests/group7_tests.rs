use super::prelude::*;

#[test]
fn expired_workspace_receipt_cannot_publish_authorization() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();
    session
        .expire_workspace_authority_for_test(&prepared.receipt)
        .unwrap();

    assert_eq!(
        session
            .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
                panic!("expired receipt must not invoke transport")
            })
            .unwrap(),
        PreparedWorkspaceSettlement::Expired
    );
    assert!(session
        .authorized_workspace_root_for_token(
            &prepared.workspace.wire_token(),
            prepared.workspace.root(),
        )
        .is_err());
}
#[test]
fn workspace_receipt_is_owner_bound_without_consuming_the_valid_owner_claim() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();

    assert!(session
        .settle_workspace_authorization("child", &prepared.receipt, false, |_| Ok(()))
        .is_err());
    assert_eq!(
        session
            .settle_workspace_authorization("main", &prepared.receipt, false, |_| Ok(()))
            .unwrap(),
        PreparedWorkspaceSettlement::Discarded
    );
}
#[test]
fn workspace_transport_failure_revokes_exactly_the_prepared_workspace_origin() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let existing = session.authorize_directory_root(directory.path()).unwrap();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();

    assert_eq!(
        session
            .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
                Err("asset scope unavailable".to_string())
            })
            .unwrap_err(),
        "asset scope unavailable"
    );
    assert!(session
        .authorized_workspace_root_for_token(&existing.wire_token(), existing.root(),)
        .is_ok());
    assert!(session
        .authorized_workspace_root_for_token(
            &prepared.workspace.wire_token(),
            prepared.workspace.root(),
        )
        .is_err());
}
#[test]
fn workspace_root_is_reobserved_before_prepared_authorization_is_published() {
    let directory = tempdir().unwrap();
    let session = FileAuthorizationSession::default();
    let prepared = session
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();
    fs::remove_dir(directory.path()).unwrap();

    assert!(session
        .settle_workspace_authorization("main", &prepared.receipt, true, |_| {
            panic!("stale workspace must not invoke transport")
        })
        .is_err());
    assert!(session
        .authorized_workspace_root_for_token(
            &prepared.workspace.wire_token(),
            prepared.workspace.root(),
        )
        .is_err());
    assert_eq!(
        session
            .pending_workspace_authority_count_for_test()
            .unwrap(),
        0
    );
}
