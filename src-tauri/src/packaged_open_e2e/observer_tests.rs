use super::tests::{empty_authorization, test_observer};
use super::*;

#[test]
fn backend_preparation_maps_opaque_receipt_to_exact_settlement_delta() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "deb", "apply-reobserve");
    let coordinator = OpenIntentCoordinator::default();
    let result = coordinator.enqueue_path(
        observer.primary_file.clone(),
        OpenIntentSource::StartupArguments,
    );
    let intent_id = result.as_ref().unwrap().head().id().to_wire();
    observer.record_enqueue(&coordinator, &result);
    let before = empty_authorization();
    let mut after = before.clone();
    after.pending_file_receipts = 1;
    observer.record_backend_prepared(
        &intent_id,
        &observer.primary_file.to_string_lossy(),
        "file",
        &[("file", "aabbcc", &observer.primary_file.to_string_lossy())],
        &before,
        &after,
    );
    observer.record_receipt_settlement("aabbcc", "discarded", &after, &before);

    let state = observer.state.lock().unwrap();
    let prepared = state
        .events
        .iter()
        .find(|event| event["type"] == "backend_prepared")
        .unwrap();
    assert_eq!(
        prepared["target"],
        observer.primary_file.to_string_lossy().as_ref()
    );
    let settled = state.events.last().unwrap();
    assert_eq!(settled["type"], "backend_receipt_settled");
    assert_eq!(settled["receiptKind"], "file");
    assert_eq!(
        settled["target"],
        observer.primary_file.to_string_lossy().as_ref()
    );
    assert_eq!(settled["settlement"], "discarded");
    assert_eq!(settled["authorizationDelta"]["pendingFileBefore"], 1);
    assert_eq!(settled["authorizationDelta"]["pendingFileAfter"], 0);
    assert_ne!(settled["receiptDigest"], "aabbcc");
}

#[test]
fn workspace_publication_records_generation_and_grants_delta_for_a_file_intent() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "deb", "apply-reobserve");
    let coordinator = OpenIntentCoordinator::default();
    let result = coordinator.enqueue_path(
        observer.primary_file.clone(),
        OpenIntentSource::StartupArguments,
    );
    let intent_id = result.as_ref().unwrap().head().id().to_wire();
    observer.record_enqueue(&coordinator, &result);
    let parent = observer
        .primary_file
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let before = empty_authorization();
    let mut after = before.clone();
    after.generation = 2;
    after.grants = vec![
        AuthorizationEvidenceGrant {
            kind: "directory_read",
            path: parent.clone(),
            origin: "workspace",
            status: "active",
            count: 1,
        },
        AuthorizationEvidenceGrant {
            kind: "internal_asset",
            path: parent.clone(),
            origin: "workspace",
            status: "active",
            count: 1,
        },
    ];
    observer.record_workspace_published(&intent_id, &parent, &before, &after);

    let state = observer.state.lock().unwrap();
    let published = state
        .events
        .iter()
        .find(|event| event["type"] == "backend_workspace_published")
        .unwrap();
    assert_eq!(published["intentId"], intent_id.as_str());
    assert_eq!(published["step"], "cli-primary");
    assert_eq!(published["target"], parent.as_str());
    assert_eq!(published["authorizationDelta"]["generationBefore"], 0);
    assert_eq!(published["authorizationDelta"]["generationAfter"], 2);
    assert_eq!(published["authorizationDelta"]["pendingFileBefore"], 0);
    assert_eq!(published["authorizationDelta"]["pendingFileAfter"], 0);
    assert_eq!(published["authorizationDelta"]["added"].as_array().unwrap().len(), 2);
    assert!(published["authorizationDelta"]["removed"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn authorization_delta_preserves_aggregated_shared_parent_count() {
    let directory = tempfile::tempdir().unwrap();
    let first_document = directory.path().join("first.md");
    let second_document = directory.path().join("second.md");
    fs::write(&first_document, "# first").unwrap();
    fs::write(&second_document, "# second").unwrap();
    let state = AppState::default();

    state
        .file_authorization()
        .with_prepared_open_document_grant(&first_document, |grant| {
            grant.apply()?;
            Ok(())
        })
        .unwrap();
    let first_snapshot = state.file_authorization().evidence_snapshot().unwrap();
    let first = EvidenceAuthorizationState {
        generation: first_snapshot.generation,
        pending_file_receipts: 0,
        pending_workspace_receipts: first_snapshot.pending_workspace_receipts,
        grants: first_snapshot.grants,
    };
    state
        .file_authorization()
        .with_prepared_open_document_grant(&second_document, |grant| {
            grant.apply()?;
            Ok(())
        })
        .unwrap();
    let second_snapshot = state.file_authorization().evidence_snapshot().unwrap();
    let second = EvidenceAuthorizationState {
        generation: second_snapshot.generation,
        pending_file_receipts: 0,
        pending_workspace_receipts: second_snapshot.pending_workspace_receipts,
        grants: second_snapshot.grants,
    };
    let delta = AuthorizationDelta::between(&first, &second);

    assert_eq!((first.generation, second.generation), (1, 2));
    assert_eq!((delta.generation_before, delta.generation_after), (1, 2));
    let shared_parent = second
        .grants
        .iter()
        .find(|grant| grant.kind == "internal_asset" && grant.origin == "open_document")
        .unwrap();
    assert_eq!(
        second
            .grants
            .iter()
            .filter(|grant| {
                grant.kind == "internal_asset" && grant.origin == "open_document"
            })
            .count(),
        1
    );
    assert_eq!(shared_parent.count, 2);
    assert!(delta.removed.iter().any(|grant| {
        grant.kind == "internal_asset" && grant.origin == "open_document" && grant.count == 1
    }));
    assert!(delta.added.iter().any(|grant| {
        grant.kind == "internal_asset" && grant.origin == "open_document" && grant.count == 2
    }));
    assert!(delta.added.iter().any(|grant| {
        grant.kind == "exact_rw"
            && grant.path
                == fs::canonicalize(&second_document)
                    .unwrap()
                    .to_string_lossy()
            && grant.count == 1
    }));
}

#[test]
fn app_settlement_uses_rust_queue_and_authorization_for_final_state() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "deb", "restore-cancel");
    let authorization = empty_authorization();
    observer
        .record_app_event(
            PackagedOpenAppEventRequest {
                event_type: "app_settled".to_string(),
                intent_id: "open-intent-1".to_string(),
                step: "session-restore".to_string(),
                fields: json!({
                    "status": "cancelled",
                    "app": {
                        "activeFile": null,
                        "workspaceRoot": null,
                        "workspaceToken": null,
                        "authorityStatus": "committed",
                        "dirty": false,
                    },
                    "spellcheck": {
                        "realEditorCount": 1,
                        "enabledRealEditorCount": 1,
                        "enabledNonEditorCount": 0,
                        "dictionaryConsistency": "not_claimed",
                    },
                }),
            },
            true,
            &authorization,
        )
        .unwrap();

    let state = observer.state.lock().unwrap();
    assert!(state.queue_empty);
    assert_eq!(
        state.final_authorization.as_ref().unwrap()["pendingFileReceipts"],
        0
    );
    assert_eq!(
        state.final_app.as_ref().unwrap()["authorityStatus"],
        "committed"
    );
}

#[test]
fn unresolved_internal_receipt_binding_prevents_finalization() {
    let directory = tempfile::tempdir().unwrap();
    let observer = test_observer(directory.path(), "appimage", "apply-reobserve");
    let mut state = observer.state.lock().unwrap();
    for index in 0..observer.expected_delivery_count() {
        state.events.push(json!({
            "seq": index + 1,
            "type": "native_delivery",
        }));
    }
    let restore_sequence = state.events.len() + 1;
    state.events.push(json!({
        "seq": restore_sequence,
        "type": "session_restore_queued",
    }));
    state.receipts.insert(
        "opaque-receipt".to_string(),
        ReceiptBinding {
            intent_id: "open-intent-1".to_string(),
            step: "cli-primary".to_string(),
            target: observer.primary_file.to_string_lossy().into_owned(),
            receipt_kind: "file".to_string(),
        },
    );
    state.final_app = Some(json!({ "authorityStatus": "committed" }));
    state.final_authorization = Some(json!({
        "pendingFileReceipts": 0,
        "pendingWorkspaceReceipts": 0,
    }));
    state.queue_empty = true;
    state.focus_control_recorded = true;
    drop(state);

    assert!(!observer.try_finalize().unwrap());
}
