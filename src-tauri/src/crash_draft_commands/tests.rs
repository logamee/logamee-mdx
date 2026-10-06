use crate::crash_drafts::{CrashDraftFileKind, CrashDraftSummary, CrashDraftWriteStatus};

use super::*;

#[test]
fn command_dtos_serialize_to_the_exact_flat_frontend_schema() {
    let response = CrashDraftWriteResponseDto {
        status: WriteStatusDto::Stored,
        document_id: "0".repeat(32),
        draft_revision: 1,
        entry_token: "a".repeat(64),
        updated_at_unix_ms: 7,
        evicted_document_ids: vec!["1".repeat(32)],
    };
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        serde_json::json!({
            "status": "stored",
            "documentId": "00000000000000000000000000000000",
            "draftRevision": 1,
            "entryToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "updatedAtUnixMs": 7,
            "evictedDocumentIds": ["11111111111111111111111111111111"]
        })
    );
}

#[test]
fn catalog_projection_counts_raw_bytes_and_flattens_supported_entries() {
    let catalog = CrashDraftCatalog {
        catalog_token: "a".repeat(64),
        entries: vec![CrashDraftListEntry::Supported {
            draft: CrashDraftSummary {
                document_id: "0".repeat(32),
                file_kind: CrashDraftFileKind::Markdown,
                revision: 1,
                updated_at_ms: 2,
                path_hint: None,
                entry_token: "b".repeat(64),
                base_version_token: None,
                content_bytes: 3,
                raw_size_bytes: 41,
                write_status: Some(CrashDraftWriteStatus::Stored),
                evicted_document_ids: vec![],
                recovery_paths: vec![],
                repair_required: None,
                repair_receipt: None,
            },
        }],
    };
    let value = serde_json::to_value(project_catalog(catalog).unwrap()).unwrap();
    assert_eq!(value["totalBytes"], 41);
    assert_eq!(value["entries"][0]["status"], "recoverable");
    assert!(value["entries"][0].get("draft").is_none());
    assert!(value["entries"][0].get("contentBytes").is_some());
}

#[test]
fn projected_errors_never_include_core_messages_or_recovery_paths() {
    let error = CrashDraftError {
        code: CrashDraftErrorCode::Persistence,
        message: "/private/path contained secret text".into(),
        disposition: None,
        recovery_paths: vec!["/private/path".into()],
        repair_required: None,
        repair_receipt: None,
    };
    let json = serde_json::to_string(&project_error(error)).unwrap();
    assert!(!json.contains("private"));
    assert!(!json.contains("secret"));
}

#[test]
fn protected_recovery_distinguishes_unsupported_versions_from_corruption() {
    let catalog = CrashDraftCatalog {
        catalog_token: "a".repeat(64),
        entries: vec![CrashDraftListEntry::Protected {
            document_id: "0".repeat(32),
            entry_token: "b".repeat(64),
            reason: ProtectedDraftReason::UnsupportedSchema,
            raw_size_bytes: 10,
            future_schema_version: Some(2),
        }],
    };
    let error =
        project_protected_recovery_error(Some(catalog), &"0".repeat(32), &"b".repeat(64))
            .unwrap();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "unsupportedVersion"
    );
}

#[test]
fn completed_overflow_progress_omits_the_final_repair_receipt() {
    let value = serde_json::to_value(OverflowResetProgressDto {
        removed_entries: 1,
        blocked_entries: 0,
        more_work_remaining: false,
        repair_receipt: None,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "removedEntries": 1,
            "blockedEntries": 0,
            "moreWorkRemaining": false
        })
    );
}

#[test]
fn retained_write_cleanup_is_surfaced_as_opaque_repair_state_not_stored() {
    let receipt = "c".repeat(64);
    let result = project_write_summary(CrashDraftSummary {
        document_id: "0".repeat(32),
        file_kind: CrashDraftFileKind::Markdown,
        revision: 1,
        updated_at_ms: 2,
        path_hint: None,
        entry_token: "b".repeat(64),
        base_version_token: None,
        content_bytes: 3,
        raw_size_bytes: 40,
        write_status: Some(CrashDraftWriteStatus::Stored),
        evicted_document_ids: vec![],
        recovery_paths: vec!["/private/hidden".into()],
        repair_required: Some(crate::crash_drafts::CrashDraftRepairRequired::CleanupRepair),
        repair_receipt: Some(receipt.clone()),
    })
    .unwrap_err();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["code"], "indeterminate");
    assert_eq!(value["repairReceipt"], receipt);
    assert!(!value.to_string().contains("private"));
}
