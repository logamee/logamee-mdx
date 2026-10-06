use std::{cell::Cell, fs};
use tempfile::tempdir;
use crate::open_intent::OpenIntentCoordinator;
use crate::path_auth::resolve_authorized_workspace_root_for_token_inner;
use crate::workspace_session::WorkspaceSessionRecord;
#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::commands::{open_authorized_file_response, prepare_standalone_file_with_ports_inner};
#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::packaged_open_e2e::authorization_state;

use super::*;
use super::tests::enqueue;

#[test]
fn popout_resolution_is_rejected_without_consuming_the_head() {
    let directory = tempdir().unwrap();
    let file = directory.path().join("draft.md");
    fs::write(&file, "draft").unwrap();
    let coordinator = OpenIntentCoordinator::default();
    let id = enqueue(&coordinator, &file);

    let result = resolve_open_intent_with_ports_inner(
        &coordinator,
        "mmd-editor-popout",
        &id,
        |_| Ok("file"),
        |_| Ok("directory"),
    );
    assert!(result.is_err());
    assert_eq!(peek_open_intent_inner(&coordinator).unwrap().id, id);
}

#[test]
fn resolve_consumes_the_head_and_reobserves_the_target_kind() {
    let directory = tempdir().unwrap();
    let file = directory.path().join("draft.md");
    fs::write(&file, "draft").unwrap();
    let coordinator = OpenIntentCoordinator::default();
    let id = enqueue(&coordinator, &file);

    let resolved = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &id,
        |path| Ok(path.to_path_buf()),
        |_| Err::<(), _>("unexpected directory callback".to_string()),
    )
    .unwrap();
    assert_eq!(
        resolved,
        ResolvedOpenIntentInner::File(fs::canonicalize(file).unwrap())
    );
    assert!(peek_open_intent_inner(&coordinator).is_none());
}

#[test]
fn target_mutation_before_acceptance_fails_without_invoking_open_ports() {
    let directory = tempdir().unwrap();
    let file = directory.path().join("draft.md");
    fs::write(&file, "draft").unwrap();
    let coordinator = OpenIntentCoordinator::default();
    let id = enqueue(&coordinator, &file);
    fs::remove_file(&file).unwrap();
    let invoked = Cell::new(false);

    let result = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &id,
        |_| {
            invoked.set(true);
            Ok(())
        },
        |_| {
            invoked.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(!invoked.get());
    assert!(peek_open_intent_inner(&coordinator).is_none());
}

#[cfg(unix)]
#[test]
fn symbolic_link_target_is_rejected_before_any_open_port_runs() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let target = directory.path().join("target.md");
    let link = directory.path().join("link.md");
    fs::write(&target, "draft").unwrap();
    symlink(&target, &link).unwrap();
    let coordinator = OpenIntentCoordinator::default();
    let id = enqueue(&coordinator, &link);
    let invoked = Cell::new(false);

    let result = resolve_open_intent_with_ports_inner(
        &coordinator,
        "main",
        &id,
        |_| {
            invoked.set(true);
            Ok(())
        },
        |_| {
            invoked.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(!invoked.get());
}

#[test]
fn session_restore_workspace_stays_provisional_until_applied() {
    let storage = tempdir().unwrap();
    let directory = tempdir().unwrap();
    let canonical_root = directory.path().canonicalize().unwrap();
    let state = AppState::default();
    state
        .initialize_workspace_session(storage.path().to_path_buf())
        .unwrap();
    state
        .workspace_session()
        .unwrap()
        .save(&WorkspaceSessionRecord::new(
            canonical_root.to_string_lossy().into_owned(),
            None,
        ))
        .unwrap();

    let (restore, receipt) = prepare_session_restore_inner(&state, "main").unwrap();
    let restore = restore.unwrap();
    let receipt = receipt.unwrap();
    assert!(resolve_authorized_workspace_root_for_token_inner(
        &state,
        &restore.workspace.workspace_token,
        &canonical_root,
    )
    .is_err());

    assert_eq!(
        state
            .file_authorization()
            .settle_workspace_authorization("main", &receipt, true, |_| Ok(()))
            .unwrap(),
        PreparedWorkspaceSettlement::Applied
    );
    assert!(resolve_authorized_workspace_root_for_token_inner(
        &state,
        &restore.workspace.workspace_token,
        &canonical_root,
    )
    .is_ok());
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[test]
fn prepared_resolution_evidence_binds_exact_targets_kinds_and_receipts() {
    let storage = tempdir().unwrap();
    let directory = tempdir().unwrap();
    let file = directory.path().join("prepared.md");
    fs::write(&file, "prepared").unwrap();
    let state = AppState::default();
    state
        .initialize_recent_files(storage.path().to_path_buf())
        .unwrap();
    let prepared = prepare_standalone_file_with_ports_inner(&state, "main", &file, |path| {
        open_authorized_file_response(path.to_path_buf())
    })
    .unwrap();
    let expected_path = prepared.file.path.clone();
    let expected_receipt = prepared.open_receipt.clone();
    let response = ResolvedOpenIntentResponse::File {
        prepared: prepared.clone(),
    };

    let evidence = prepared_resolution_evidence(&response);
    assert_eq!(evidence.target, expected_path);
    assert_eq!(evidence.target_kind, "file");
    assert_eq!(
        evidence.receipts,
        vec![("file", expected_receipt.as_str(), expected_path.as_str(),)]
    );

    let (workspace, workspace_receipt) =
        prepare_directory_open_inner(&state, "main", directory.path(), None).unwrap();
    let workspace_root = workspace.root.clone();
    let response = ResolvedOpenIntentResponse::SessionRestore {
        restore: Some(WorkspaceSessionRestore {
            workspace,
            active_file: Some(prepared),
        }),
        workspace_open_receipt: Some(workspace_receipt.clone()),
    };
    let evidence = prepared_resolution_evidence(&response);
    assert_eq!(evidence.target, workspace_root);
    assert_eq!(evidence.target_kind, "session_restore");
    assert_eq!(
        evidence.receipts,
        vec![
            (
                "workspace",
                workspace_receipt.as_str(),
                workspace_root.as_str(),
            ),
            ("file", expected_receipt.as_str(), expected_path.as_str()),
        ]
    );

    let response = ResolvedOpenIntentResponse::SessionRestore {
        restore: None,
        workspace_open_receipt: None,
    };
    let evidence = prepared_resolution_evidence(&response);
    assert_eq!(evidence.target, "session_restore");
    assert_eq!(evidence.target_kind, "session_restore");
    assert!(evidence.receipts.is_empty());
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[test]
fn session_restore_snapshot_contains_workspace_and_file_receipts() {
    let storage = tempdir().unwrap();
    let directory = tempdir().unwrap();
    let canonical_root = directory.path().canonicalize().unwrap();
    let active_file = canonical_root.join("active.md");
    fs::write(&active_file, "active").unwrap();
    let state = AppState::default();
    state
        .initialize_recent_files(storage.path().to_path_buf())
        .unwrap();
    state
        .initialize_workspace_session(storage.path().to_path_buf())
        .unwrap();
    state
        .workspace_session()
        .unwrap()
        .save(&WorkspaceSessionRecord::new(
            canonical_root.to_string_lossy().into_owned(),
            Some(active_file.to_string_lossy().into_owned()),
        ))
        .unwrap();

    let (restore, workspace_receipt) = prepare_session_restore_inner(&state, "main").unwrap();
    let restore = restore.expect("the saved workspace should be restored");
    let workspace_receipt = workspace_receipt.expect("workspace receipt should be prepared");
    let active_file_receipt = restore
        .active_file
        .as_ref()
        .expect("the saved active file should be prepared")
        .open_receipt
        .clone();
    let evidence = authorization_state(&state).unwrap();

    assert_eq!(evidence.pending_workspace_receipts, 1);
    assert_eq!(evidence.pending_file_receipts, 1);
    assert_ne!(workspace_receipt, active_file_receipt);
}
