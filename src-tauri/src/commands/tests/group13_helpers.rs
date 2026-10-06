//! Helpers for group13 command tests.
use super::fixtures2::*;

pub(super) struct NestedRemovedHtmlEntry {
    pub(super) workspace: tempfile::TempDir,
    pub(super) state: AppState,
    pub(super) outer_opened: WorkspaceSnapshot,
    pub(super) opened: WorkspaceSnapshot,
    pub(super) old_document: PathBuf,
    pub(super) canonical_removed: PathBuf,
    pub(super) canonical_old_document: PathBuf,
}

pub(super) fn nested_removed_html_entry() -> NestedRemovedHtmlEntry {
    let outer = tempdir().unwrap();
    let inner = outer.path().join("inner");
    let removed = inner.join("removed");
    let old_document = removed.join("index.html");
    let old_asset = removed.join("asset.png");
    fs::create_dir_all(&removed).unwrap();
    fs::write(&old_document, "<h1>before</h1>").unwrap();
    fs::write(&old_asset, b"png").unwrap();

    let state = AppState::default();
    let outer_opened = open_directory_inner(&state, outer.path()).unwrap();
    let opened = open_directory_inner(&state, &inner).unwrap();
    open_standalone_file_with_ports_inner(
        &state,
        &old_document,
        |file| open_authorized_file_response(file.to_path_buf()),
        |_| Ok(()),
    )
    .unwrap();
    crate::html_preview_server::prepare_html_preview_inner(
        &state,
        &old_document,
        "<h1>preview</h1>",
    )
    .unwrap();

    NestedRemovedHtmlEntry {
        canonical_removed: removed.canonicalize().unwrap(),
        canonical_old_document: old_document.canonicalize().unwrap(),
        workspace: outer,
        state,
        outer_opened,
        opened,
        old_document,
    }
}

pub(super) fn assert_removed_entry_left_no_authorization_or_provenance(
    entry: &NestedRemovedHtmlEntry,
    inner: &Path,
    outer: &Path,
) {
    assert!(!entry.canonical_removed.exists());
    assert!(!entry
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&entry.canonical_old_document));
    assert!(entry
        .state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
    resolve_authorized_workspace_root_for_token_inner(
        &entry.state,
        &entry.opened.workspace_token,
        inner,
    )
    .expect("selected workspace provenance must remain active");
    resolve_authorized_workspace_root_for_token_inner(
        &entry.state,
        &entry.outer_opened.workspace_token,
        outer,
    )
    .expect("ancestor workspace provenance must remain active");
}

pub(super) fn assert_committed_delete_receipt<T: serde::Serialize>(
    outcome: MutationOutcome<T, WorkspaceSnapshot>,
    canonical_removed: &Path,
    workspace_token: &str,
) {
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-committed",
            "receipt": {
                "committed": {
                    "deleted_path": canonical_removed.to_string_lossy(),
                },
                "workspace": {
                    "status": "stale",
                    "workspace_token": workspace_token,
                    "repair_reason": "injected post-commit snapshot failure",
                },
            },
        }),
    );
}

pub(super) fn assert_post_delete_refresh_and_reauthorization(entry: &NestedRemovedHtmlEntry) {
    let inner = entry.workspace.path().join("inner");
    let removed = inner.join("removed");
    let refreshed =
        refresh_directory_inner(&entry.state, &entry.opened.workspace_token, &inner).unwrap();
    assert!(!refreshed
        .directories
        .iter()
        .any(|entry| entry.relative_path == "removed"));
    refresh_directory_inner(
        &entry.state,
        &entry.outer_opened.workspace_token,
        entry.workspace.path(),
    )
    .unwrap();

    fs::create_dir_all(&removed).unwrap();
    fs::write(&entry.old_document, "<h1>recreated</h1>").unwrap();
    assert!(ensure_authorized_existing_file_inner(&entry.state, &entry.old_document).is_ok());
    assert!(ensure_authorized_write_file_inner(&entry.state, &entry.old_document).is_err());
}
