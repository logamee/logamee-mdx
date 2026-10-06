//! Helpers extracted from group6 tests to keep each file within size limits.
use super::fixtures2::*;

pub(super) struct RenamedHtmlWorkspace {
    pub(super) state: AppState,
    pub(super) opened: WorkspaceSnapshot,
    pub(super) inner: PathBuf,
    pub(super) canonical_source: PathBuf,
    pub(super) canonical_old_document: PathBuf,
    pub(super) target: PathBuf,
    pub(super) new_document: PathBuf,
    pub(super) new_asset: PathBuf,
}

pub(super) fn prepare_renamed_html_workspace(outer: &Path) -> RenamedHtmlWorkspace {
    let inner = outer.join("inner");
    let source = inner.join("drafts");
    let old_document = source.join("index.html");
    let old_asset = source.join("asset.png");
    fs::create_dir_all(&source).unwrap();
    fs::write(&old_document, "<h1>before</h1>").unwrap();
    fs::write(&old_asset, b"png").unwrap();

    let state = AppState::default();
    open_directory_inner(&state, outer).unwrap();
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

    let canonical_source = source.canonicalize().unwrap();
    let canonical_old_document = old_document.canonicalize().unwrap();
    let target = inner.canonicalize().unwrap().join("archive");
    let new_document = target.join("index.html");
    let new_asset = target.join("asset.png");
    RenamedHtmlWorkspace {
        state,
        opened,
        inner,
        canonical_source,
        canonical_old_document,
        target,
        new_document,
        new_asset,
    }
}

pub(super) fn assert_rename_committed_state(space: &RenamedHtmlWorkspace) {
    assert!(!space.canonical_source.exists());
    assert!(space.target.is_dir());
    assert!(ensure_authorized_write_file_inner(&space.state, &space.new_document).is_ok());
    assert!(
        ensure_authorized_write_file_inner(&space.state, &space.canonical_old_document).is_err()
    );
    assert!(is_authorized_image_path(&space.state, &space.new_asset).unwrap());
    assert!(!space
        .state
        .html_preview_server
        .site_documents()
        .unwrap()
        .contains(&space.canonical_old_document));
    assert!(space
        .state
        .file_authorization()
        .preview_lease_snapshot()
        .unwrap()
        .is_empty());
}

pub(super) fn assert_rename_committed_outcome_json(
    outcome: &MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>,
    space: &RenamedHtmlWorkspace,
) {
    use serde_json::json;
    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({
            "status": "confirmed-committed",
            "receipt": {
                "committed": {
                    "entry_kind": "directory",
                    "old_path": space.canonical_source.to_string_lossy(),
                    "new_path": space.target.to_string_lossy(),
                },
                "workspace": {
                    "status": "stale",
                    "workspace_token": space.opened.workspace_token,
                    "repair_reason": "injected post-commit snapshot failure",
                },
            },
        }),
    );
}

pub(super) struct HtmlDraftBaseline {
    pub(super) state: AppState,
    pub(super) opened: WorkspaceSnapshot,
    pub(super) canonical_source: PathBuf,
    pub(super) target: PathBuf,
    pub(super) authorization_before: String,
    pub(super) sites_before: HashSet<PathBuf>,
}

pub(super) fn open_html_draft_with_preview(workspace_root: &Path) -> HtmlDraftBaseline {
    let source = workspace_root.join("draft.html");
    fs::write(&source, "<h1>draft</h1>").unwrap();

    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace_root).unwrap();
    open_workspace_file_inner(&state, &source).unwrap();
    crate::html_preview_server::prepare_html_preview_inner(&state, &source, "<h1>preview</h1>")
        .unwrap();

    let canonical_source = source.canonicalize().unwrap();
    let target = canonical_source.with_file_name("renamed.html");
    let authorization_before = state.file_authorization().state_fingerprint_for_test();
    let sites_before = state.html_preview_server.site_documents().unwrap();
    HtmlDraftBaseline {
        state,
        opened,
        canonical_source,
        target,
        authorization_before,
        sites_before,
    }
}

pub(super) fn assert_rename_authorization_poison_panics(draft: &HtmlDraftBaseline) {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let state = &draft.state;
    let poisoned = catch_unwind(AssertUnwindSafe(|| {
        let _ = rename_authorized_workspace_entry_inner(
            state,
            &draft.opened.workspace_token,
            &draft.canonical_source,
            |_, _| -> Result<String, String> {
                panic!("injected authorization poison before filesystem mutation")
            },
            |_, _| panic!("filesystem mutation must not run while poisoning authorization"),
            |_| panic!("observation must not run while poisoning authorization"),
        );
    }));
    assert!(poisoned.is_err());
}

pub(super) fn assert_disk_and_authorization_unchanged(draft: &HtmlDraftBaseline) {
    assert_eq!(
        fs::read_to_string(&draft.canonical_source).unwrap(),
        "<h1>draft</h1>"
    );
    assert!(!draft.target.exists());
    assert_eq!(
        draft
            .state
            .file_authorization()
            .state_fingerprint_for_test(),
        draft.authorization_before
    );
    assert_eq!(
        draft.state.html_preview_server.site_documents().unwrap(),
        draft.sites_before
    );
}
