//! Helpers extracted from group3 tests to keep each file within size limits.
use super::fixtures2::*;
use super::fixtures3::*;

pub(super) fn create_default_excalidraw_file(
    state: &AppState,
    workspace_token: &str,
    directory: &Path,
) -> OpenFileResponse {
    match create_workspace_file_for_kind_inner(
        state,
        workspace_token,
        directory,
        "architecture",
        WorkspaceFileKind::Excalidraw,
    )
    .unwrap()
    {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt.committed,
        _ => panic!("expected a committed Excalidraw creation"),
    }
}

pub(super) fn assert_created_excalidraw_matches_defaults(
    created: &OpenFileResponse,
    initial_scene: &str,
) {
    assert_eq!(created.kind, WorkspaceFileKind::Excalidraw);
    assert_eq!(created.content.as_deref(), Some(initial_scene));
    assert_eq!(
        Path::new(&created.path)
            .extension()
            .and_then(|value| value.to_str()),
        Some("excalidraw")
    );
    assert_eq!(fs::read_to_string(&created.path).unwrap(), initial_scene);
}

pub(super) fn assert_rejected_excalidraw_write_and_save_as(
    state: &AppState,
    directory: &Path,
    created_path: &str,
    invalid_scene: &str,
    initial_scene: &str,
) {
    let before = fs::read_to_string(created_path).unwrap();
    assert_confirmed_not_committed(write_file_inner(state, created_path, invalid_scene));
    assert_eq!(fs::read_to_string(created_path).unwrap(), before);

    let invalid_destination = directory.join("invalid.excalidraw");
    assert_confirmed_not_committed(save_as_inner(
        state,
        &invalid_destination,
        invalid_scene.to_string(),
    ));
    assert!(!invalid_destination.exists());

    let wrong_extension = directory.join("copy.md");
    assert_confirmed_not_committed(save_as_for_kind_inner(
        state,
        &wrong_extension,
        initial_scene.to_string(),
        Some(WorkspaceFileKind::Excalidraw),
    ));
    assert!(!wrong_extension.exists());
}

pub(super) fn committed_outcome<T>(
    outcome: Result<MutationOutcome<T, WorkspaceSnapshot>, String>,
) -> T {
    committed_receipt(outcome).committed
}

pub(super) fn committed_receipt<T>(
    outcome: Result<MutationOutcome<T, WorkspaceSnapshot>, String>,
) -> crate::models::MutationCommitReceipt<T, WorkspaceSnapshot> {
    match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt,
        _ => panic!("expected confirmed committed outcome"),
    }
}

pub(super) fn assert_scope_discarded_after<T>(
    state: &AppState,
    opened: &WorkspaceSnapshot,
    operation_id: &str,
    mutation: impl FnOnce() -> T,
) -> T {
    let root = Path::new(&opened.root);
    let lease = publish_workspace_index(state, &opened.workspace_token, root, operation_id);
    let outcome = mutation();
    assert_workspace_index_invalidated(state, &opened.workspace_token, root, &lease);
    outcome
}
