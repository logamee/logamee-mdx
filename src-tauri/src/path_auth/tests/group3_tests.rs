use super::prelude::*;
use super::super::lock_probe::{trace, LockEvent};

#[test]
fn workspace_entry_uses_explicit_token_not_first_matching_root() {
    let outer = tempdir().unwrap();
    let inner = outer.path().join("inner");
    let document = inner.join("document.md");
    fs::create_dir(&inner).unwrap();
    fs::write(&document, "# document").unwrap();
    let canonical_outer = normalize_existing_path(outer.path()).unwrap();
    let canonical_inner = normalize_existing_path(&inner).unwrap();
    let state = AppState::default();

    let outer_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_outer)
        .unwrap();
    let inner_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_inner)
        .unwrap();

    let (_, selected_outer) = state
        .file_authorization()
        .workspace_entry_for_mutation(outer_workspace.token(), &document)
        .unwrap();
    let (_, selected_inner) = state
        .file_authorization()
        .workspace_entry_for_mutation(inner_workspace.token(), &document)
        .unwrap();

    assert_eq!(selected_outer, canonical_outer);
    assert_eq!(selected_inner, canonical_inner);
}
#[cfg(windows)]
#[test]
fn canonical_verbatim_drive_workspace_entry_supports_mutation_validation() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();
    let canonical_document = normalize_existing_path(&document).unwrap();
    assert!(matches!(
        canonical_root.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
    ));
    let state = AppState::default();
    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_root)
        .unwrap();

    let (entry, selected_root) = state
        .file_authorization()
        .workspace_entry_for_mutation(authorized_workspace.token(), &canonical_document)
        .unwrap();

    assert_eq!(entry, canonical_document);
    assert_eq!(selected_root, canonical_root);
}
#[cfg(windows)]
#[test]
fn canonical_verbatim_drive_workspace_entry_still_rejects_symlinks() {
    use std::os::windows::fs::symlink_file;

    let workspace = tempdir().unwrap();
    let target = workspace.path().join("target.md");
    let link = workspace.path().join("linked.md");
    fs::write(&target, "# target").unwrap();
    symlink_file(&target, &link).unwrap();
    let canonical_root = normalize_existing_path(workspace.path()).unwrap();
    assert!(matches!(
        canonical_root.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
    ));
    let state = AppState::default();
    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_root)
        .unwrap();

    let error = state
        .file_authorization()
        .workspace_entry_for_mutation(
            authorized_workspace.token(),
            canonical_root.join("linked.md"),
        )
        .unwrap_err();

    assert_eq!(
        error,
        "Symbolic links cannot be modified as workspace entries"
    );
    assert_eq!(fs::read(target).unwrap(), b"# target");
}
#[test]
fn cannot_select_any_active_workspace_root_as_a_mutation_target_through_an_overlap() {
    let outer = tempdir().unwrap();
    let inner = outer.path().join("inner");
    fs::create_dir(&inner).unwrap();
    let canonical_outer = normalize_existing_path(outer.path()).unwrap();
    let canonical_inner = normalize_existing_path(&inner).unwrap();
    let state = AppState::default();

    let outer_workspace = state
        .file_authorization()
        .authorize_directory_root(&canonical_outer)
        .unwrap();
    state
        .file_authorization()
        .authorize_directory_root(&canonical_inner)
        .unwrap();

    assert!(state
        .file_authorization()
        .workspace_entry_for_mutation(outer_workspace.token(), &canonical_inner)
        .is_err());
}
fn committed_rename_transaction_fixture()
-> (AppState, AuthorizedWorkspace, PathBuf, PathBuf, tempfile::TempDir) {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("draft.html");
    fs::write(&source, "draft").unwrap();
    let state = AppState::default();
    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(workspace.path())
        .unwrap();
    state.file_authorization().authorize_file(&source).unwrap();
    prepare_html_preview_inner(&state, &source, "draft").unwrap();
    let canonical_source = source.canonicalize().unwrap();
    let target = canonical_source.with_file_name("renamed.html");
    (state, authorized_workspace, canonical_source, target, workspace)
}

fn run_committed_rename_transaction(
    state: &AppState,
    authorized_workspace: &AuthorizedWorkspace,
    canonical_source: &PathBuf,
    target: &PathBuf,
) -> (Result<AuthorizedRenameOutcome, String>, Vec<LockEvent>) {
    let canonical_source = canonical_source.clone();
    let target = target.clone();
    let (outcome, events) = trace(|| {
        rename_authorized_workspace_entry_inner(
            state,
            &authorized_workspace.wire_token(),
            &canonical_source,
            |entry, is_file| {
                assert_eq!(entry, canonical_source);
                assert!(is_file);
                Ok("renamed.html".to_string())
            },
            |old_path, new_path| {
                assert_eq!(old_path, canonical_source);
                assert_eq!(new_path, target);
                fs::rename(old_path, new_path)
                    .map_err(|err| format!("Failed to rename entry: {err}"))
            },
            |_| panic!("observation must not run after a successful rename"),
        )
    });
    (outcome, events)
}

#[test]
fn rename_transaction_commits_filesystem_and_authorization_before_preview_invalidation() {
    let (state, authorized_workspace, canonical_source, target, _workspace) =
        committed_rename_transaction_fixture();

    let (outcome, events) = run_committed_rename_transaction(
        &state,
        &authorized_workspace,
        &canonical_source,
        &target,
    );

    let AuthorizedRenameOutcome::Committed(renamed) = outcome.unwrap() else {
        panic!("expected committed rename outcome");
    };
    assert_eq!(
        renamed.workspace().wire_token(),
        authorized_workspace.wire_token()
    );
    assert_eq!(renamed.old_path(), canonical_source);
    assert_eq!(renamed.new_path(), target);
    assert!(renamed.is_file());
    assert!(!canonical_source.exists());
    assert!(target.is_file());
    assert!(ensure_authorized_write_file_inner(&state, &target).is_ok());
    assert!(ensure_authorized_write_file_inner(&state, &canonical_source).is_err());
    assert_eq!(
        events,
        [
            LockEvent::AuthorizationAcquired,
            LockEvent::AuthorizationReleased,
            LockEvent::HtmlSitesAcquired,
            LockEvent::HtmlSitesReleased,
        ]
    );
}
#[test]
fn rename_transaction_returns_recovery_required_for_post_commit_preview_failure() {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("draft.md");
    fs::write(&source, "draft").unwrap();
    let state = AppState::default();
    let authorized_workspace = state
        .file_authorization()
        .authorize_directory_root(workspace.path())
        .unwrap();
    let canonical_source = source.canonicalize().unwrap();
    let target = canonical_source.with_file_name("renamed.md");

    let outcome = rename_authorized_workspace_entry_with_preview_inner(
        &state,
        &authorized_workspace.wire_token(),
        &source,
        |_, is_file| {
            assert!(is_file);
            Ok("renamed.md".to_string())
        },
        |old_path, new_path| {
            fs::rename(old_path, new_path)
                .map_err(|err| format!("Failed to rename entry: {err}"))
        },
        |_| panic!("observation must not run after a successful rename"),
        |_| Err("injected post-commit preview failure".to_string()),
    )
    .unwrap();

    let AuthorizedRenameOutcome::RecoveryRequired {
        renamed,
        recovery_message,
    } = outcome
    else {
        panic!("expected recovery-required rename outcome");
    };
    assert_eq!(renamed.old_path(), canonical_source);
    assert_eq!(renamed.new_path(), target);
    assert!(target.is_file());
    assert_eq!(recovery_message, "injected post-commit preview failure");
}
#[test]
fn rename_transaction_rejects_a_valid_token_for_another_workspace_before_commit() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let source = second.path().join("draft.md");
    fs::write(&source, "draft").unwrap();
    let state = AppState::default();
    let first_workspace = state
        .file_authorization()
        .authorize_directory_root(first.path())
        .unwrap();
    state
        .file_authorization()
        .authorize_directory_root(second.path())
        .unwrap();
    let rename_calls = std::cell::Cell::new(0);

    let error = match rename_authorized_workspace_entry_inner(
        &state,
        &first_workspace.wire_token(),
        &source,
        |_, _| Ok("renamed.md".to_string()),
        |_, _| {
            rename_calls.set(rename_calls.get() + 1);
            Ok(())
        },
        |_| panic!("observation must not run before filesystem mutation"),
    ) {
        Ok(_) => panic!("wrong-workspace rename must fail before commit"),
        Err(error) => error,
    };

    assert_eq!(error, "Workspace entry is outside the selected workspace");
    assert_eq!(rename_calls.get(), 0);
    assert!(source.is_file());
    assert!(!second.path().join("renamed.md").exists());
}
