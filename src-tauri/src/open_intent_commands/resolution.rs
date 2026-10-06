use std::{fs, path::Path};


use crate::{
    commands::{open_authorized_file_response, prepare_standalone_file_with_ports_inner},
    models::{WorkspaceSessionRestore, WorkspaceSnapshot},
    open_intent::{
        ConsumedOpenIntentTarget, OpenIntentCoordinator, OpenIntentId, OpenIntentPreviewTarget,
    },
    path_auth::{normalize_existing_path, path_is_under},
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
    workspace_snapshot::capture_workspace_snapshot,
};

#[cfg(feature = "packaged-lifecycle-e2e")]
use super::PreparedResolutionEvidence;

use super::{
    OpenIntentPreviewResponse, ResolvedOpenIntentResponse,
    source_wire_value, validate_main_owner, preview_target_kind,
    packaged_open_e2e_challenge_active, should_skip_session_restore,
};

#[cfg(feature = "packaged-lifecycle-e2e")]
pub(crate) fn prepared_resolution_evidence(
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
pub(crate) enum ResolvedOpenIntentInner<F, D> {
    File(F),
    Directory(D),
    SessionRestore,
}


pub(crate) fn peek_open_intent_inner(
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

pub(crate) fn resolve_open_intent_with_ports_inner<F, D>(
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

pub(crate) fn discard_open_intent_inner(
    coordinator: &OpenIntentCoordinator,
    owner: &str,
    intent_id: &str,
) -> Result<bool, String> {
    validate_main_owner(owner)?;
    let id = OpenIntentId::from_wire(intent_id)
        .ok_or_else(|| "Open request identifier is invalid".to_string())?;
    Ok(coordinator.discard_matching_head(id))
}

pub(crate) fn prepare_directory_open_inner(
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

pub(crate) fn canonical_restored_workspace_root(path: &str) -> Result<std::path::PathBuf, String> {
    let raw = Path::new(path);
    let canonical = normalize_existing_path(raw)?;
    if raw != canonical || !canonical.is_dir() {
        return Err("Saved workspace root is no longer a canonical directory".to_string());
    }
    Ok(canonical)
}

pub(crate) fn prepare_session_restore_inner(
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

pub(crate) fn resolve_session_restore_response(
    coordinator: &OpenIntentCoordinator,
    state: &AppState,
    owner: &str,
) -> Result<ResolvedOpenIntentResponse, String> {
    // The restore request may have been enqueued before an explicit open arrived (for example a
    // macOS `Opened` event delivered after the webview issued the restore request). If an explicit
    // open has since arrived, resolve the restore as a no-op so it never displaces the newer file.
    if should_skip_session_restore(
        coordinator.has_explicit_open_request(),
        packaged_open_e2e_challenge_active(),
    ) {
        return Ok(ResolvedOpenIntentResponse::SessionRestore {
            restore: None,
            workspace_open_receipt: None,
        });
    }
    prepare_session_restore_inner(state, owner).map(
        |(restore, workspace_open_receipt)| ResolvedOpenIntentResponse::SessionRestore {
            restore,
            workspace_open_receipt,
        },
    )
}
