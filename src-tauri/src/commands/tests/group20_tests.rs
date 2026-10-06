use super::trash_fixtures::*;

#[test]
fn coordinated_save_as_creates_new_and_overwrites_dialog_accepted_existing_files() {
    let directory = tempdir().unwrap();
    let new_path = directory.path().join("new.md");
    let existing_path = directory.path().join("existing.md");
    fs::write(&existing_path, "before").unwrap();
    let state = AppState::default();

    let created = save_as_coordinated_inner(
        &state,
        &new_path,
        "created",
        None,
        "save-as-new",
        MAIN_SAVE_OWNER,
    )
    .unwrap();
    assert!(matches!(
        created,
        DocumentSaveResponse::ConfirmedCommitted { .. }
    ));
    assert_eq!(fs::read_to_string(&new_path).unwrap(), "created");

    let overwritten = save_as_coordinated_inner(
        &state,
        &existing_path,
        "replacement",
        None,
        "save-as-existing",
        MAIN_SAVE_OWNER,
    )
    .unwrap();
    assert!(matches!(
        overwritten,
        DocumentSaveResponse::ConfirmedCommitted {
            cleanup_repair_receipt: None,
            ..
        }
    ));
    assert_eq!(fs::read_to_string(&existing_path).unwrap(), "replacement");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}
#[test]
fn committed_backup_cleanup_success_and_failure_preserve_commit_proof_without_paths() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("note.md");
    let displaced = directory.path().join(".private-backup");
    fs::write(&destination, "committed").unwrap();
    fs::write(&displaced, "old").unwrap();
    let version = crate::durable_write::capture_file_version(&destination)
        .unwrap()
        .unwrap();
    let success = document_save_response_with_cleanup(
        &destination,
        DocumentSaveDisposition::ConfirmedCommitted {
            version: version.clone(),
            displaced_path: Some(displaced.clone()),
        },
        |path| fs::remove_file(path),
    );
    assert!(matches!(
        success,
        DocumentSaveResponse::ConfirmedCommitted {
            cleanup_repair_receipt: None,
            ..
        }
    ));
    assert!(!displaced.exists());

    let failed = document_save_response_with_cleanup(
        &destination,
        DocumentSaveDisposition::ConfirmedCommitted {
            version,
            displaced_path: Some(displaced.clone()),
        },
        |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected cleanup failure",
            ))
        },
    );
    let wire = serde_json::to_value(failed).unwrap();
    let receipt = wire["cleanup_repair_receipt"].as_str().unwrap();
    assert_eq!(receipt.len(), 72);
    assert!(receipt.starts_with("cleanup-"));
    assert!(!wire.to_string().contains(".private-backup"));
}
fn assert_committed_save_wire_contract(path: &str, version: &crate::durable_write::FileVersion) {
    let committed = serde_json::to_value(DocumentSaveResponse::ConfirmedCommitted {
        path: path.to_string(),
        version: version.clone(),
        cleanup_repair_receipt: Some("cleanup-opaque".to_string()),
    })
    .unwrap();
    assert_eq!(committed["status"], "confirmed_committed");
    assert_eq!(committed["path"], path);
    assert_eq!(committed["cleanup_repair_receipt"], "cleanup-opaque");
    assert!(committed["version"]["canonicalPath"].is_string());
    assert!(committed["version"]["platformIdentity"].is_string());
    assert!(committed["version"]["length"].is_string());
    assert!(committed["version"]["modifiedNanos"].is_string());
    assert!(committed["version"]["sha256"].is_string());
}

fn assert_not_committed_save_wire_contract(
    path: &str,
    version: &crate::durable_write::FileVersion,
) {
    let not_committed = serde_json::to_value(DocumentSaveResponse::ConfirmedNotCommitted {
        path: path.to_string(),
        current_version: Some(version.clone()),
        message: "not committed".to_string(),
    })
    .unwrap();
    assert_eq!(not_committed["status"], "confirmed_not_committed");
    assert!(not_committed.get("current_version").is_some());
}

fn assert_conflict_save_wire_contract(path: &str, version: &crate::durable_write::FileVersion) {
    let conflict = serde_json::to_value(DocumentSaveResponse::Conflict {
        path: path.to_string(),
        current_version: Some(version.clone()),
        overwrite_token: None,
        message: "changed".to_string(),
    })
    .unwrap();
    assert_eq!(conflict["status"], "conflict");
    assert!(conflict.get("current_version").is_some());
    assert!(conflict.get("overwrite_token").is_none());
    assert!(conflict.get("recovery_path").is_none());
}

fn assert_race_conflict_wire_contract(
    destination: &Path,
    directory_root: &Path,
    version: crate::durable_write::FileVersion,
) {
    let race_token = "b".repeat(64);
    let race_conflict = serde_json::to_value(document_save_response(
        destination,
        DocumentSaveDisposition::Conflict {
            current_version: Some(version),
            recovery_path: directory_root.join("private-recovery"),
            overwrite_token: Some(OverwriteToken::from_wire(&race_token).unwrap()),
        },
    ))
    .unwrap();
    assert_eq!(race_conflict["status"], "conflict");
    assert_eq!(race_conflict["overwrite_token"], race_token);
    assert!(race_conflict.get("recovery_path").is_none());
}

fn assert_indeterminate_and_token_wire_contracts(path: &str, destination: &Path) {
    let indeterminate = serde_json::to_value(DocumentSaveResponse::Indeterminate {
        path: path.to_string(),
        message: "inspect the document".to_string(),
    })
    .unwrap();
    assert_eq!(
        indeterminate,
        serde_json::json!({
            "status": "indeterminate",
            "path": destination.to_string_lossy(),
            "message": "inspect the document",
        })
    );
    assert_eq!(
        serde_json::to_value(OverwriteTokenResponse {
            overwrite_token: "a".repeat(64),
        })
        .unwrap(),
        serde_json::json!({ "overwriteToken": "a".repeat(64) })
    );
}

#[test]
fn document_save_and_overwrite_token_dtos_have_exact_wire_contracts() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("note.md");
    fs::write(&destination, "disk").unwrap();
    let version = crate::durable_write::capture_file_version(&destination)
        .unwrap()
        .unwrap();
    let path = destination.to_string_lossy().to_string();

    assert_committed_save_wire_contract(&path, &version);
    assert_not_committed_save_wire_contract(&path, &version);
    assert_conflict_save_wire_contract(&path, &version);
    assert_race_conflict_wire_contract(&destination, directory.path(), version);
    assert_indeterminate_and_token_wire_contracts(&path, &destination);
}
fn create_trash_source(workspace_root: &Path, directory_case: bool) -> PathBuf {
    if directory_case {
        let source = workspace_root.join("folder");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("nested.md"), "nested").unwrap();
        source
    } else {
        let source = workspace_root.join("note.md");
        fs::write(&source, "note").unwrap();
        source
    }
}

fn assert_rejected_trash_classification(directory_case: bool) {
    let workspace = tempdir().unwrap();
    let recovery = tempdir().unwrap();
    let source = create_trash_source(workspace.path(), directory_case);
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    if !directory_case {
        open_workspace_file_inner(&state, &source).unwrap();
    }
    let mut port = scripted_trash(ScriptedTrashMode::Rejected, recovery.path().join("unused"));

    let outcome = delete_workspace_entry_with_trash_port_inner(
        &state,
        &opened.workspace_token,
        &source,
        &mut port,
        capture_workspace_snapshot,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        MutationOutcome::ConfirmedNotCommitted { .. }
    ));
    assert!(source.exists());
    assert_eq!(port.calls, 1);
    if directory_case {
        assert!(ensure_authorized_directory_inner(&state, &source).is_ok());
    } else {
        assert!(ensure_authorized_write_file_inner(&state, &source).is_ok());
    }
}

#[test]
fn native_trash_classification_preserves_files_and_nonempty_directories_when_rejected() {
    for directory_case in [false, true] {
        assert_rejected_trash_classification(directory_case);
    }
}

fn assert_committed_trash_classification(directory_case: bool) {
    let workspace = tempdir().unwrap();
    let recovery = tempdir().unwrap();
    let source = create_trash_source(workspace.path(), directory_case);
    let recovery_path = recovery.path().join(if directory_case {
        "folder-recovery"
    } else {
        "note-recovery.md"
    });
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    if !directory_case {
        open_workspace_file_inner(&state, &source).unwrap();
    }
    let mut port = scripted_trash(ScriptedTrashMode::Committed, recovery_path.clone());

    let outcome = delete_workspace_entry_with_trash_port_inner(
        &state,
        &opened.workspace_token,
        &source,
        &mut port,
        capture_workspace_snapshot,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        MutationOutcome::ConfirmedCommitted { .. }
    ));
    assert!(!source.exists());
    assert!(recovery_path.exists());
    assert_eq!(port.calls, 1);
    if !directory_case {
        assert!(ensure_authorized_write_file_inner(&state, &source).is_err());
    }
}

#[test]
fn native_trash_classification_commits_only_with_exact_recovery_placement() {
    for directory_case in [false, true] {
        assert_committed_trash_classification(directory_case);
    }
}
