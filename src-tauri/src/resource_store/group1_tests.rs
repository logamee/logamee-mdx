use super::test_prelude::*;
use super::*;

#[test]
fn rejects_unauthorized_workspace_token_before_side_effects() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();

    let error = write_workspace_resource_inner(
        &state,
        request("workspace-999", &dir.path().to_string_lossy(), PNG),
    )
    .unwrap_err();

    assert!(error.contains("Workspace authorization") || error.contains("Invalid workspace"));
    assert!(!dir.path().join("assets").exists());
}
#[test]
fn rejects_parent_traversal_and_absolute_resource_directories_before_side_effects() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let mut traversal = request(&token, &root, PNG);
    traversal.resource_directory = "assets/../outside".to_string();
    assert!(write_workspace_resource_inner(&state, traversal).is_err());

    let mut absolute = request(&token, &root, PNG);
    absolute.resource_directory = dir.path().join("assets").to_string_lossy().to_string();
    assert!(write_workspace_resource_inner(&state, absolute).is_err());
    assert!(!dir.path().join("assets").exists());
}
#[test]
fn writes_to_an_explicitly_authorized_absolute_resource_directory() {
    let state = AppState::default();
    let outer = TempDir::new().unwrap();
    let workspace = outer.path().join("workspace");
    let docs = workspace.join("docs");
    let resources = outer.path().join("shared-resources");
    fs::create_dir_all(&docs).unwrap();
    fs::create_dir_all(&resources).unwrap();
    fs::write(docs.join("draft.md"), b"# Draft").unwrap();
    let snapshot = open_directory_inner(&state, &workspace).unwrap();
    open_workspace_file_inner(&state, docs.join("draft.md")).unwrap();
    let authorization =
        authorize_resource_directory_path_inner(&state, &resources, |_| Ok(())).unwrap();
    let mut input = request(&snapshot.workspace_token, &snapshot.root, PNG);
    input.document_path = docs.join("draft.md").to_string_lossy().to_string();
    input.resource_directory = authorization.path.clone();
    input.resource_directory_token = Some(authorization.token);

    let response = write_workspace_resource_inner(&state, input).unwrap();

    assert_eq!(
        response.markdown_path,
        format!("../../shared-resources/{}", response.file_name)
    );
    assert_eq!(response.relative_path, response.markdown_path);
    assert_eq!(fs::read(resources.join(response.file_name)).unwrap(), PNG);
}
#[test]
fn rejects_absolute_resource_directory_without_matching_live_authorization() {
    let state = AppState::default();
    let workspace = TempDir::new().unwrap();
    let resources = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    fs::write(workspace.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &workspace);

    let mut missing = request(&token, &root, PNG);
    missing.resource_directory = resources.path().to_string_lossy().to_string();
    assert!(write_workspace_resource_inner(&state, missing)
        .unwrap_err()
        .contains("explicitly authorized"));

    let authorization =
        authorize_resource_directory_path_inner(&state, other.path(), |_| Ok(())).unwrap();
    let mut mismatched = request(&token, &root, PNG);
    mismatched.resource_directory = resources.path().to_string_lossy().to_string();
    mismatched.resource_directory_token = Some(authorization.token);
    assert!(write_workspace_resource_inner(&state, mismatched).is_err());
    assert!(fs::read_dir(resources.path()).unwrap().next().is_none());
    assert!(fs::read_dir(other.path()).unwrap().next().is_none());
}
#[cfg(unix)]
#[test]
fn rejects_nested_symlink_without_creating_outside_side_effects() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    fs::create_dir(dir.path().join("assets")).unwrap();
    symlink(outside.path(), dir.path().join("assets/images")).unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let error =
        write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

    assert!(
        error.contains("securely")
            || error.contains("symbolic")
            || error.contains("Not a directory")
            || error.contains("Too many levels")
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}
#[cfg(unix)]
#[test]
fn rejects_final_symlink_target_during_dedup_verification() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let digest = md5_hex(PNG);
    let resource_dir = dir.path().join("assets/images");
    fs::create_dir_all(&resource_dir).unwrap();
    fs::write(outside.path().join("target.png"), PNG).unwrap();
    symlink(
        outside.path().join("target.png"),
        resource_dir.join(format!("{digest}.png")),
    )
    .unwrap();

    let error =
        write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

    assert!(error.contains("without following links") || error.contains("Too many levels"));
}
#[test]
fn rejects_bad_signature_unsupported_type_malformed_base64_and_oversize_before_side_effects() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let bad_signature = request(&token, &root, b"not-png");
    assert!(write_workspace_resource_inner(&state, bad_signature)
        .unwrap_err()
        .contains("match"));

    let mut unsupported = request(&token, &root, PNG);
    unsupported.mime_type = "application/pdf".to_string();
    assert!(write_workspace_resource_inner(&state, unsupported)
        .unwrap_err()
        .contains("not supported"));

    let mut malformed = request(&token, &root, PNG);
    malformed.bytes_base64 = "%%%".to_string();
    assert!(write_workspace_resource_inner(&state, malformed)
        .unwrap_err()
        .contains("base64"));

    let mut oversized = request(&token, &root, PNG);
    oversized.bytes_base64 = BASE64_STANDARD.encode(vec![0_u8; MAX_RESOURCE_BYTES + 1]);
    assert!(write_workspace_resource_inner(&state, oversized)
        .unwrap_err()
        .contains("16 MiB"));
    assert!(!dir.path().join("assets").exists());
}
#[test]
fn rejects_arbitrary_clipboard_svg_without_trusted_generated_contract() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let mut input = request(
        &token,
        &root,
        br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
    );
    input.mime_type = "image/svg+xml".to_string();

    let error = write_workspace_resource_inner(&state, input).unwrap_err();

    assert!(error.contains("trusted generated"));
    assert!(!dir.path().join("assets").exists());
}
#[test]
fn accepts_structurally_safe_trusted_generated_svg() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let mut input = request(
        &token,
        &root,
        br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#,
    );
    input.mime_type = "image/svg+xml".to_string();
    input.trusted_generated = Some(true);

    let response = write_workspace_resource_inner(&state, input).unwrap();

    assert!(response.relative_path.ends_with(".svg"));
    assert!(dir.path().join(response.relative_path).exists());
}
#[test]
fn rejects_document_paths_outside_authorized_workspace() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let outside_doc = outside.path().join("draft.md");
    fs::write(&outside_doc, b"# Outside").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);

    let mut input = request(&token, &root, PNG);
    input.document_path = outside_doc.to_string_lossy().to_string();

    assert!(write_workspace_resource_inner(&state, input)
        .unwrap_err()
        .contains("outside"));
    assert!(!dir.path().join("assets").exists());
}
#[test]
fn rejects_stale_or_unauthorized_markdown_document() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    let doc = dir.path().join("draft.md");
    fs::write(&doc, b"# Draft").unwrap();
    let snapshot = open_directory_inner(&state, dir.path()).unwrap();
    let mut input = request(&snapshot.workspace_token, &snapshot.root, PNG);
    assert!(write_workspace_resource_inner(&state, input.clone())
        .unwrap_err()
        .contains("explicitly"));

    open_workspace_file_inner(&state, &doc).unwrap();
    let replacement = dir.path().join("replacement.md");
    fs::write(&replacement, b"# Replacement").unwrap();
    fs::remove_file(&doc).unwrap();
    fs::rename(replacement, &doc).unwrap();
    input.document_path = doc.to_string_lossy().to_string();
    let error = write_workspace_resource_inner(&state, input).unwrap_err();
    assert!(
        error.contains("identity") || error.contains("explicitly") || error.contains("changed")
    );
}
#[test]
fn rejects_existing_digest_file_with_different_bytes() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let input = request(&token, &root, PNG);
    let digest = md5_hex(PNG);
    let resource_dir = dir.path().join("assets/images");
    fs::create_dir_all(&resource_dir).unwrap();
    fs::write(resource_dir.join(format!("{digest}.png")), b"different").unwrap();

    let error = write_workspace_resource_inner(&state, input).unwrap_err();

    assert!(error.contains("collides"));
}
