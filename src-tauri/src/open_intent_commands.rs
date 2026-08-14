use std::{fs, path::Path, sync::Arc};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::{
    commands::{
        allow_asset_preview_directory, open_authorized_file_response,
        prepare_standalone_file_with_ports_inner,
    },
    models::{PreparedOpenFileResponse, WorkspaceSessionRestore, WorkspaceSnapshot},
    open_intent::{
        ConsumedOpenIntentTarget, OpenIntentCoordinator, OpenIntentId, OpenIntentPreviewTarget,
        OpenIntentSource,
    },
    path_auth::{normalize_existing_path, path_is_under, PreparedWorkspaceSettlement},
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
    workspace_snapshot::capture_workspace_snapshot,
};

#[cfg(feature = "packaged-lifecycle-e2e")]
use crate::packaged_open_e2e::{
    authorization_state, observe_backend_prepared, observe_backend_rejected,
    observe_focus_requested, observe_intent_discarded, observe_receipt_settlement,
};

pub(crate) const OPEN_INTENT_PENDING_EVENT: &str = "mmd:open-intent-pending";
pub(crate) const OPEN_INTENT_FOCUS_EVENT: &str = "mmd:open-intent-focus";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenIntentPreviewResponse {
    id: String,
    source: &'static str,
    display_path: String,
    target_kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ResolvedOpenIntentResponse {
    File {
        prepared: PreparedOpenFileResponse,
    },
    Directory {
        workspace: WorkspaceSnapshot,
        workspace_open_receipt: String,
    },
    SessionRestore {
        restore: Option<WorkspaceSessionRestore>,
        workspace_open_receipt: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceOpenSettlementResponse {
    Applied,
    Discarded,
    Expired,
    Unknown,
}

#[cfg(feature = "packaged-lifecycle-e2e")]
struct PreparedResolutionEvidence<'a> {
    target: &'a str,
    target_kind: &'static str,
    receipts: Vec<(&'static str, &'a str, &'a str)>,
}

#[cfg(feature = "packaged-lifecycle-e2e")]
fn prepared_resolution_evidence(
    response: &ResolvedOpenIntentResponse,
) -> PreparedResolutionEvidence<'_> {
    match response {
        ResolvedOpenIntentResponse::File { prepared } => PreparedResolutionEvidence {
            target: &prepared.file.path,
            target_kind: "file",
            receipts: vec![(
                "file",
                prepared.open_receipt.as_str(),
                prepared.file.path.as_str(),
            )],
        },
        ResolvedOpenIntentResponse::Directory {
            workspace,
            workspace_open_receipt,
        } => PreparedResolutionEvidence {
            target: &workspace.root,
            target_kind: "directory",
            receipts: vec![(
                "workspace",
                workspace_open_receipt.as_str(),
                workspace.root.as_str(),
            )],
        },
        ResolvedOpenIntentResponse::SessionRestore {
            restore,
            workspace_open_receipt,
        } => {
            let mut receipts = Vec::with_capacity(2);
            if let (Some(receipt), Some(workspace)) = (
                workspace_open_receipt.as_deref(),
                restore.as_ref().map(|restore| &restore.workspace),
            ) {
                receipts.push(("workspace", receipt, workspace.root.as_str()));
            }
            if let Some(prepared) = restore
                .as_ref()
                .and_then(|restore| restore.active_file.as_ref())
            {
                receipts.push((
                    "file",
                    prepared.open_receipt.as_str(),
                    prepared.file.path.as_str(),
                ));
            }
            PreparedResolutionEvidence {
                target: restore
                    .as_ref()
                    .map(|restore| restore.workspace.root.as_str())
                    .unwrap_or("session_restore"),
                target_kind: "session_restore",
                receipts,
            }
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ResolvedOpenIntentInner<F, D> {
    File(F),
    Directory(D),
    SessionRestore,
}

fn source_wire_value(source: OpenIntentSource) -> &'static str {
    match source {
        OpenIntentSource::StartupArguments => "startup_args",
        OpenIntentSource::SecondaryInstance => "secondary_instance",
        OpenIntentSource::OpenedEvent => "opened_event",
        OpenIntentSource::DragDrop => "drag_drop",
        OpenIntentSource::SessionRestore => "session_restore",
    }
}

fn validate_main_owner(owner: &str) -> Result<(), String> {
    if owner == "main" {
        Ok(())
    } else {
        Err("Only the main window can process application open requests".to_string())
    }
}

fn request_session_restore_inner(
    coordinator: &OpenIntentCoordinator,
    owner: &str,
) -> Result<(), String> {
    validate_main_owner(owner)?;
    let result = coordinator.enqueue_session_restore();
    #[cfg(feature = "packaged-lifecycle-e2e")]
    crate::packaged_open_e2e::observe_enqueue(coordinator, &result);
    result.map(|_| ()).map_err(|_| {
        "Too many files are waiting to be opened. Finish the current request and try again."
            .to_string()
    })
}

#[tauri::command]
pub(crate) fn request_session_restore(
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<(), String> {
    request_session_restore_inner(&coordinator, window.label())
}

#[tauri::command]
pub(crate) fn focus_main_window(
    intent_id: Option<String>,
    coalesced: Option<bool>,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<(), String> {
    validate_main_owner(window.label())?;
    window
        .show()
        .map_err(|error| format!("Cannot show the main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Cannot focus the main window: {error}"))?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if let Some(intent_id) =
        intent_id.or_else(|| coordinator.peek_head().map(|head| head.id().to_wire()))
    {
        observe_focus_requested(&intent_id, coalesced.unwrap_or(false));
    }
    #[cfg(not(feature = "packaged-lifecycle-e2e"))]
    let _ = (intent_id, coalesced, coordinator);
    Ok(())
}

fn preview_target_kind(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => "unknown",
        Ok(metadata) if metadata.is_file() => "file",
        Ok(metadata) if metadata.is_dir() => "directory",
        _ => "unknown",
    }
}

fn peek_open_intent_inner(
    coordinator: &OpenIntentCoordinator,
) -> Option<OpenIntentPreviewResponse> {
    let preview = coordinator.peek_preview()?;
    let (display_path, target_kind) = match preview.target() {
        OpenIntentPreviewTarget::CandidatePath(path) => (
            path.to_string_lossy().into_owned(),
            preview_target_kind(path),
        ),
        // This is deliberately not derived from the persisted session record. Reading or
        // displaying its raw path before resolution would turn an opaque queue item into a
        // path-disclosure and could tempt callers to authorize it ahead of the queue.
        OpenIntentPreviewTarget::SessionRestore => {
            ("Restore previous workspace".to_string(), "session_restore")
        }
    };
    Some(OpenIntentPreviewResponse {
        id: preview.id().to_wire(),
        source: source_wire_value(preview.source()),
        display_path,
        target_kind,
    })
}

fn resolve_open_intent_with_ports_inner<F, D>(
    coordinator: &OpenIntentCoordinator,
    owner: &str,
    intent_id: &str,
    open_file: impl FnOnce(&Path) -> Result<F, String>,
    open_directory: impl FnOnce(&Path) -> Result<D, String>,
) -> Result<ResolvedOpenIntentInner<F, D>, String> {
    validate_main_owner(owner)?;
    let id = OpenIntentId::from_wire(intent_id)
        .ok_or_else(|| "Open request identifier is invalid".to_string())?;
    let intent = coordinator
        .consume_matching_head(id)
        .ok_or_else(|| "Open request is no longer at the head of the queue".to_string())?;
    let ConsumedOpenIntentTarget::CandidatePath(candidate) = intent.target() else {
        return Ok(ResolvedOpenIntentInner::SessionRestore);
    };
    let metadata = match fs::symlink_metadata(candidate) {
        Ok(metadata) => metadata,
        Err(error) => return Err(format!("Cannot access requested path: {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("Symbolic-link launch targets are not supported".to_string());
    }
    let canonical = normalize_existing_path(candidate)?;
    if metadata.is_file() && canonical.is_file() {
        return open_file(&canonical).map(ResolvedOpenIntentInner::File);
    }
    if metadata.is_dir() && canonical.is_dir() {
        return open_directory(&canonical).map(ResolvedOpenIntentInner::Directory);
    }
    Err("Requested path is no longer a regular file or directory".to_string())
}

fn discard_open_intent_inner(
    coordinator: &OpenIntentCoordinator,
    owner: &str,
    intent_id: &str,
) -> Result<bool, String> {
    validate_main_owner(owner)?;
    let id = OpenIntentId::from_wire(intent_id)
        .ok_or_else(|| "Open request identifier is invalid".to_string())?;
    Ok(coordinator.discard_matching_head(id))
}

fn prepare_directory_open_inner(
    state: &AppState,
    owner: &str,
    path: &Path,
    expected_root: Option<&Path>,
) -> Result<(WorkspaceSnapshot, String), String> {
    let prepared = state.file_authorization().prepare_workspace_authorization(
        owner,
        path,
        expected_root,
        capture_workspace_snapshot,
    )?;
    let receipt = prepared.receipt;
    match prepared
        .snapshot
        .into_workspace_snapshot(&prepared.workspace)
    {
        Ok(workspace) => Ok((workspace, receipt)),
        Err(error) => {
            let _ = state.file_authorization().settle_workspace_authorization(
                owner,
                &receipt,
                false,
                |_| Ok(()),
            );
            Err(error)
        }
    }
}

fn canonical_restored_workspace_root(path: &str) -> Result<std::path::PathBuf, String> {
    let raw = Path::new(path);
    let canonical = normalize_existing_path(raw)?;
    if raw != canonical || !canonical.is_dir() {
        return Err("Saved workspace root is no longer a canonical directory".to_string());
    }
    Ok(canonical)
}

fn prepare_session_restore_inner(
    state: &AppState,
    owner: &str,
) -> Result<(Option<WorkspaceSessionRestore>, Option<String>), String> {
    let Some(record) = state.workspace_session()?.load()? else {
        return Ok((None, None));
    };
    let workspace_root = match canonical_restored_workspace_root(record.workspace_root()) {
        Ok(root) => root,
        Err(_) => {
            state.workspace_session()?.clear()?;
            return Ok((None, None));
        }
    };
    let (workspace, receipt) =
        prepare_directory_open_inner(state, owner, &workspace_root, Some(&workspace_root))?;

    let active_file = record.active_path().and_then(|active_path| {
        let raw = Path::new(active_path);
        let canonical = normalize_existing_path(raw).ok()?;
        let valid = raw == canonical
            && canonical.is_file()
            && path_is_under(&canonical, &workspace_root)
            && WorkspaceFileKind::classify(&canonical).is_some()
            && workspace.files.iter().any(|file| file.path == active_path);
        valid
            .then(|| {
                prepare_standalone_file_with_ports_inner(state, owner, canonical, |file| {
                    open_authorized_file_response(file.to_path_buf())
                })
                .ok()
            })
            .flatten()
    });
    if record.active_path().is_some() && active_file.is_none() {
        let _ = state
            .workspace_session()
            .and_then(|session| session.save(&record.without_active_path()));
    }
    Ok((
        Some(WorkspaceSessionRestore {
            workspace,
            active_file,
        }),
        Some(receipt),
    ))
}

#[tauri::command]
pub(crate) fn peek_open_intent(
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<Option<OpenIntentPreviewResponse>, String> {
    validate_main_owner(window.label())?;
    Ok(peek_open_intent_inner(&coordinator))
}

#[tauri::command]
pub(crate) fn resolve_open_intent(
    intent_id: String,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
    state: State<'_, AppState>,
) -> Result<ResolvedOpenIntentResponse, String> {
    let owner = window.label().to_string();
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state(&state)?;
    let result = resolve_open_intent_with_ports_inner(
        &coordinator,
        &owner,
        &intent_id,
        |path| {
            prepare_standalone_file_with_ports_inner(&state, &owner, path, |file| {
                open_authorized_file_response(file.to_path_buf())
            })
        },
        |path| prepare_directory_open_inner(&state, &owner, path, None),
    )
    .and_then(|resolved| match resolved {
        ResolvedOpenIntentInner::File(prepared) => {
            Ok(ResolvedOpenIntentResponse::File { prepared })
        }
        ResolvedOpenIntentInner::Directory((workspace, workspace_open_receipt)) => {
            Ok(ResolvedOpenIntentResponse::Directory {
                workspace,
                workspace_open_receipt,
            })
        }
        ResolvedOpenIntentInner::SessionRestore => prepare_session_restore_inner(&state, &owner)
            .map(
                |(restore, workspace_open_receipt)| ResolvedOpenIntentResponse::SessionRestore {
                    restore,
                    workspace_open_receipt,
                },
            ),
    });
    #[cfg(feature = "packaged-lifecycle-e2e")]
    {
        let evidence_after = authorization_state(&state)?;
        match &result {
            Ok(response) => {
                let evidence = prepared_resolution_evidence(response);
                observe_backend_prepared(
                    &intent_id,
                    evidence.target,
                    evidence.target_kind,
                    &evidence.receipts,
                    &evidence_before,
                    &evidence_after,
                );
            }
            Err(error) => {
                observe_backend_rejected(&intent_id, error, &evidence_before, &evidence_after)
            }
        }
    }
    result
}

#[tauri::command]
pub(crate) fn settle_open_intent_workspace(
    workspace_open_receipt: String,
    applied: bool,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<WorkspaceOpenSettlementResponse, String> {
    validate_main_owner(window.label())?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    let evidence_before = authorization_state(&state)?;
    let settlement = state.file_authorization().settle_workspace_authorization(
        window.label(),
        &workspace_open_receipt,
        applied,
        |root| allow_asset_preview_directory(&app, root),
    );
    #[cfg(feature = "packaged-lifecycle-e2e")]
    {
        let evidence_after = authorization_state(&state)?;
        observe_receipt_settlement(
            &workspace_open_receipt,
            match &settlement {
                Ok(PreparedWorkspaceSettlement::Applied) => "applied",
                Ok(PreparedWorkspaceSettlement::Discarded) => "discarded",
                Ok(PreparedWorkspaceSettlement::Expired) => "expired",
                Ok(PreparedWorkspaceSettlement::Unknown) => "unknown",
                Err(_) => "failed",
            },
            &evidence_before,
            &evidence_after,
        );
    }
    let settlement = settlement?;
    if settlement == PreparedWorkspaceSettlement::Applied {
        state.workspace_index().discard_all();
    }
    Ok(match settlement {
        PreparedWorkspaceSettlement::Applied => WorkspaceOpenSettlementResponse::Applied,
        PreparedWorkspaceSettlement::Discarded => WorkspaceOpenSettlementResponse::Discarded,
        PreparedWorkspaceSettlement::Expired => WorkspaceOpenSettlementResponse::Expired,
        PreparedWorkspaceSettlement::Unknown => WorkspaceOpenSettlementResponse::Unknown,
    })
}

#[tauri::command]
pub(crate) fn discard_open_intent(
    intent_id: String,
    window: WebviewWindow,
    coordinator: State<'_, Arc<OpenIntentCoordinator>>,
) -> Result<bool, String> {
    let discarded = discard_open_intent_inner(&coordinator, window.label(), &intent_id)?;
    #[cfg(feature = "packaged-lifecycle-e2e")]
    if discarded {
        observe_intent_discarded(&intent_id);
    }
    Ok(discarded)
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, ffi::OsString, fs, path::Path};

    use tempfile::tempdir;

    use crate::open_intent::{
        OpenIntentCoordinator, OpenIntentSource, DEFAULT_OPEN_INTENT_CAPACITY,
    };
    use crate::{
        path_auth::resolve_authorized_workspace_root_for_token_inner,
        workspace_session::WorkspaceSessionRecord,
    };

    use super::*;

    fn enqueue(coordinator: &OpenIntentCoordinator, target: &Path) -> String {
        let cwd = target.parent().unwrap();
        coordinator
            .enqueue_args(
                [OsString::from("mmd"), target.as_os_str().to_os_string()],
                cwd,
                OpenIntentSource::StartupArguments,
            )
            .unwrap();
        peek_open_intent_inner(coordinator).unwrap().id
    }

    #[test]
    fn preview_is_non_consuming_and_contains_only_display_metadata() {
        let directory = tempdir().unwrap();
        let file = directory.path().join("draft.md");
        fs::write(&file, "draft").unwrap();
        let coordinator = OpenIntentCoordinator::new(DEFAULT_OPEN_INTENT_CAPACITY);
        let id = enqueue(&coordinator, &file);

        let first = peek_open_intent_inner(&coordinator).unwrap();
        let second = peek_open_intent_inner(&coordinator).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.id, id);
        assert_eq!(first.display_path, file.to_string_lossy());
        assert_eq!(first.source, "startup_args");
        assert_eq!(first.target_kind, "file");
    }

    #[test]
    fn preview_classifies_directories_and_keeps_missing_targets_untrusted() {
        let directory = tempdir().unwrap();
        let coordinator = OpenIntentCoordinator::default();
        let directory_id = enqueue(&coordinator, directory.path());

        let preview = peek_open_intent_inner(&coordinator).unwrap();
        assert_eq!(preview.id, directory_id);
        assert_eq!(preview.target_kind, "directory");
        assert!(discard_open_intent_inner(&coordinator, "main", &directory_id).unwrap());

        let missing = directory.path().join("missing.md");
        let missing_id = enqueue(&coordinator, &missing);
        let preview = peek_open_intent_inner(&coordinator).unwrap();
        assert_eq!(preview.id, missing_id);
        assert_eq!(preview.target_kind, "unknown");
    }

    #[test]
    fn drag_drop_preview_uses_the_backend_source_wire_value() {
        let coordinator = OpenIntentCoordinator::default();
        let path = tempdir().unwrap().path().join("dropped.md");
        coordinator
            .enqueue_path(path, OpenIntentSource::DragDrop)
            .unwrap();

        assert_eq!(
            peek_open_intent_inner(&coordinator).unwrap().source,
            "drag_drop"
        );
    }

    #[test]
    fn session_restore_preview_is_opaque_and_carries_no_persisted_path() {
        let coordinator = OpenIntentCoordinator::default();
        let id = coordinator.enqueue_session_restore().unwrap().head().id();

        let preview = peek_open_intent_inner(&coordinator).unwrap();
        assert_eq!(preview.id, id.to_wire());
        assert_eq!(preview.source, "session_restore");
        assert_eq!(preview.display_path, "Restore previous workspace");
        assert_eq!(preview.target_kind, "session_restore");
    }

    #[test]
    fn main_app_restore_request_appends_after_an_existing_native_open() {
        let coordinator = OpenIntentCoordinator::default();
        let directory = tempdir().unwrap();
        let association = directory.path().join("association.md");
        coordinator
            .enqueue_path(association, OpenIntentSource::OpenedEvent)
            .unwrap();

        request_session_restore_inner(&coordinator, "main").unwrap();

        assert_eq!(
            peek_open_intent_inner(&coordinator).unwrap().source,
            "opened_event"
        );
    }

    #[test]
    fn popout_restore_request_is_rejected_without_enqueuing() {
        let coordinator = OpenIntentCoordinator::default();

        assert!(request_session_restore_inner(&coordinator, "mmd-editor-popout").is_err());
        assert!(peek_open_intent_inner(&coordinator).is_none());
    }

    #[test]
    fn session_restore_only_resolves_after_earlier_open_request_is_consumed() {
        let coordinator = OpenIntentCoordinator::default();
        let directory = tempdir().unwrap();
        let file = directory.path().join("startup.md");
        fs::write(&file, "startup").unwrap();
        let startup_id = enqueue(&coordinator, &file);
        let restore_id = coordinator
            .enqueue_session_restore()
            .unwrap()
            .head()
            .id()
            .to_wire();

        let result = resolve_open_intent_with_ports_inner(
            &coordinator,
            "main",
            &restore_id,
            |_| Ok(()),
            |_| Ok(()),
        );
        assert!(result.is_err());

        let _ = resolve_open_intent_with_ports_inner(
            &coordinator,
            "main",
            &startup_id,
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
        let resolved = resolve_open_intent_with_ports_inner(
            &coordinator,
            "main",
            &restore_id,
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(resolved, ResolvedOpenIntentInner::SessionRestore);
    }

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
}
