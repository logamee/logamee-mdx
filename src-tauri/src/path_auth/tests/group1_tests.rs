use std::path::Path;

use super::prelude::*;

#[test]
fn relocating_a_markdown_anchor_invalidates_its_embed_lease() {
    let workspace = tempdir().unwrap();
    let markdown = workspace.path().join("notes.md");
    let renamed_markdown = workspace.path().join("renamed.md");
    let html = workspace.path().join("embed.html");
    fs::write(&markdown, "# Notes").unwrap();
    fs::write(&html, "<h1>Embed</h1>").unwrap();
    let canonical_markdown = normalize_existing_path(&markdown).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    let scope = preview_scope_for_anchored_file_inner(&state, &markdown, &html).unwrap();
    let lease = scope.lease().clone();

    fs::rename(&markdown, &renamed_markdown).unwrap();
    let canonical_renamed_markdown = normalize_existing_path(&renamed_markdown).unwrap();
    let invalidated = state
        .file_authorization()
        .relocate_path_prefix(&canonical_markdown, &canonical_renamed_markdown)
        .unwrap();

    assert!(invalidated.contains(&lease));
}
#[test]
fn normalize_new_path_rejects_parent_components() {
    let dir = tempdir().unwrap();
    assert!(normalize_parent_for_new_path(dir.path().join("ok.md")).is_ok());
    assert!(normalize_parent_for_new_path(dir.path().join("../bad.md")).is_err());
}
#[test]
fn file_only_authorization_denies_sibling_read_and_write() {
    let dir = tempdir().unwrap();
    let allowed = dir.path().join("allowed.md");
    let sibling = dir.path().join("sibling.md");
    fs::write(&allowed, "# allowed").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    let state = AppState::default();

    let allowed_canonical = authorize_file_inner(&state, allowed).unwrap();
    assert_eq!(
        ensure_authorized_existing_file_inner(&state, &allowed_canonical).unwrap(),
        allowed_canonical
    );
    assert!(ensure_authorized_existing_file_inner(&state, &sibling).is_err());
    assert!(ensure_authorized_write_file_inner(&state, &sibling).is_err());
}
fn run_failing_prepare_and_assert_no_grants_published(
    state: &AppState,
    canonical_document: &Path,
    canonical_parent: &Path,
) {
    let error = state
        .file_authorization()
        .with_prepared_open_document_grant(canonical_document, |_prepared| {
            Err::<(), _>("injected pre-commit failure".to_string())
        })
        .unwrap_err();
    assert_eq!(error, "injected pre-commit failure");
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(canonical_document)
            .unwrap(),
        None
    );
    assert_eq!(
        state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(canonical_parent)
            .unwrap(),
        None
    );
}

fn apply_prepared_grant_and_assert_published(
    state: &AppState,
    canonical_document: &Path,
    canonical_parent: &Path,
    sibling: &Path,
) {
    state
        .file_authorization()
        .with_prepared_open_document_grant(canonical_document, |prepared| {
            prepared.apply().unwrap();
            Ok(())
        })
        .unwrap();

    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(canonical_document)
            .unwrap(),
        Some((GrantStatus::Active, 1))
    );
    assert_eq!(
        state
            .file_authorization()
            .internal_asset_grant_snapshot_for_test(canonical_parent)
            .unwrap(),
        Some((GrantStatus::Active, 1))
    );
    assert_eq!(
        ensure_authorized_existing_file_inner(state, canonical_document).unwrap(),
        canonical_document
    );
    assert!(ensure_authorized_existing_file_inner(state, sibling).is_err());
}

#[test]
fn prepared_open_document_grant_publishes_only_on_terminal_apply() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    let sibling = directory.path().join("sibling.md");
    fs::write(&document, "# document").unwrap();
    fs::write(&sibling, "# sibling").unwrap();
    let canonical_document = normalize_existing_path(&document).unwrap();
    let canonical_parent = canonical_document.parent().unwrap().to_path_buf();
    let state = AppState::default();

    run_failing_prepare_and_assert_no_grants_published(
        &state,
        &canonical_document,
        &canonical_parent,
    );
    apply_prepared_grant_and_assert_published(
        &state,
        &canonical_document,
        &canonical_parent,
        &sibling,
    );
}
#[cfg(feature = "packaged-lifecycle-e2e")]
#[test]
fn packaged_evidence_snapshot_reports_exact_active_grants_and_pending_workspace_receipts() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("evidence.md");
    fs::write(&document, "# evidence").unwrap();
    let canonical = normalize_existing_path(&document).unwrap();
    let state = AppState::default();

    let prepared = state
        .file_authorization()
        .prepare_workspace_authorization("main", directory.path(), None, |_| Ok(()))
        .unwrap();
    let pending = state.file_authorization().evidence_snapshot().unwrap();
    assert_eq!(pending.pending_workspace_receipts, 1);
    assert!(pending.grants.is_empty());

    state
        .file_authorization()
        .with_prepared_open_document_grant(&canonical, |grant| {
            grant.apply().unwrap();
            Ok(())
        })
        .unwrap();
    let applied = state.file_authorization().evidence_snapshot().unwrap();
    assert!(applied.grants.iter().any(|grant| {
        grant.kind == "exact_rw"
            && grant.path == canonical.to_string_lossy()
            && grant.origin == "open_document"
            && grant.status == "active"
    }));
    assert_eq!(applied.pending_workspace_receipts, 1);

    assert_eq!(
        state
            .file_authorization()
            .settle_workspace_authorization("main", &prepared.receipt, false, |_| Ok(()))
            .unwrap(),
        PreparedWorkspaceSettlement::Discarded
    );
    assert_eq!(
        state
            .file_authorization()
            .evidence_snapshot()
            .unwrap()
            .pending_workspace_receipts,
        0
    );
}
#[cfg(feature = "packaged-lifecycle-e2e")]
#[test]
fn packaged_evidence_snapshot_aggregates_same_category_origins() {
    let directory = tempdir().unwrap();
    let first_document = directory.path().join("first.md");
    let second_document = directory.path().join("second.md");
    fs::write(&first_document, "# first").unwrap();
    fs::write(&second_document, "# second").unwrap();
    let state = AppState::default();

    let first_grant = state
        .file_authorization()
        .authorize_file(&first_document)
        .unwrap();
    let first_generation = state
        .file_authorization()
        .authorization_generation()
        .unwrap();
    let second_grant = state
        .file_authorization()
        .authorize_file(&second_document)
        .unwrap();

    let parent = normalize_existing_path(directory.path()).unwrap();
    let snapshot = state.file_authorization().evidence_snapshot().unwrap();
    assert!(first_generation > 0);
    assert!(snapshot.generation > first_generation);
    assert_eq!(exact_rw_open_document_counts(&snapshot), vec![1, 1]);
    assert_eq!(active_internal_asset_grants(&snapshot, &parent), 1);
    assert_eq!(internal_asset_count(&snapshot, &parent), 2);

    state
        .file_authorization()
        .revoke_origin(first_grant.origin(), RevokeOriginMode::All)
        .unwrap();
    let after_first_revoke = state.file_authorization().evidence_snapshot().unwrap();
    assert_partial_revoke_state(&after_first_revoke, &snapshot, &parent);

    state
        .file_authorization()
        .revoke_origin(second_grant.origin(), RevokeOriginMode::All)
        .unwrap();
    let after_second_revoke = state.file_authorization().evidence_snapshot().unwrap();
    assert!(after_second_revoke.generation > after_first_revoke.generation);
    assert!(after_second_revoke.grants.is_empty());
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn assert_partial_revoke_state(
    after_first_revoke: &crate::path_auth::AuthorizationEvidenceSnapshot,
    snapshot: &crate::path_auth::AuthorizationEvidenceSnapshot,
    parent: &Path,
) {
    assert!(after_first_revoke.generation > snapshot.generation);
    assert_eq!(internal_asset_count(after_first_revoke, parent), 1);
    assert_eq!(exact_rw_grant_count(after_first_revoke), 1);
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn internal_asset_count(
    snapshot: &crate::path_auth::AuthorizationEvidenceSnapshot,
    parent: &Path,
) -> usize {
    snapshot
        .grants
        .iter()
        .find(|grant| internal_asset_for_parent(grant, parent))
        .unwrap()
        .count
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn internal_asset_for_parent(grant: &crate::path_auth::AuthorizationEvidenceGrant, parent: &Path) -> bool {
    grant.kind == "internal_asset" && grant.path == parent.to_string_lossy()
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn active_internal_asset_grants(
    snapshot: &crate::path_auth::AuthorizationEvidenceSnapshot,
    parent: &Path,
) -> usize {
    snapshot
        .grants
        .iter()
        .filter(|grant| {
            internal_asset_for_parent(grant, parent)
                && grant.origin == "open_document"
                && grant.status == "active"
        })
        .count()
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn exact_rw_open_document_counts(snapshot: &crate::path_auth::AuthorizationEvidenceSnapshot) -> Vec<usize> {
    snapshot
        .grants
        .iter()
        .filter(|grant| grant.kind == "exact_rw" && grant.origin == "open_document")
        .map(|grant| grant.count)
        .collect()
}

#[cfg(feature = "packaged-lifecycle-e2e")]
#[cfg(feature = "packaged-lifecycle-e2e")]
fn exact_rw_grant_count(snapshot: &crate::path_auth::AuthorizationEvidenceSnapshot) -> usize {
    snapshot
        .grants
        .iter()
        .filter(|grant| grant.kind == "exact_rw")
        .count()
}
#[test]
fn authorization_generation_advances_for_grant_revoke_and_regrant() {
    let directory = tempdir().unwrap();
    let document = directory.path().join("document.md");
    fs::write(&document, "# document").unwrap();
    let session = FileAuthorizationSession::default();

    assert_eq!(session.authorization_generation().unwrap(), 0);
    let first = session.authorize_file(&document).unwrap();
    let after_grant = session.authorization_generation().unwrap();
    assert!(after_grant > 0);

    session
        .revoke_origin(first.origin(), RevokeOriginMode::All)
        .unwrap();
    let after_revoke = session.authorization_generation().unwrap();
    assert!(after_revoke > after_grant);

    session.authorize_file(&document).unwrap();
    assert!(session.authorization_generation().unwrap() > after_revoke);
}
