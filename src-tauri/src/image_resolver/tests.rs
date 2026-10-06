use super::*;
use std::{fs, io::Write};
use tempfile::tempdir;

use crate::path_auth::{authorize_directory_root_inner, authorize_file_inner};

#[test]
fn rejects_absolute_and_external_image_sources() {
    for rooted in [
        "/tmp/a.png",
        r"\tmp\a.png",
        r"C:\tmp\a.png",
        "C:/tmp/a.png",
        r"C:images\a.png",
        r"\\server\share\a.png",
        "%2Ftmp/a.png",
        "%5Ctmp%5Ca.png",
    ] {
        assert!(
            reject_unsafe_relative_image_src(rooted).is_err(),
            "accepted rooted image source: {rooted}"
        );
    }
    assert!(reject_unsafe_relative_image_src("https://example.com/a.png").is_err());
    assert!(reject_unsafe_relative_image_src("data:image/png;base64,abc").is_err());
    assert!(reject_unsafe_relative_image_src("../a.png").is_ok());
    assert!(reject_unsafe_relative_image_src("%2e%2e/a.png").is_ok());
    assert!(reject_unsafe_relative_image_src("images/a.png").is_ok());
}

#[test]
fn resolves_allowed_relative_image_path() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("doc.md"), "![x](img.png)").unwrap();
    let mut image = fs::File::create(dir.path().join("img.png")).unwrap();
    image.write_all(b"png").unwrap();
    let state = AppState::default();
    let roots = authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, dir.path().join("doc.md")).unwrap();
    let resolved = resolve_relative_image_path_inner(
        &state,
        dir.path().join("doc.md").to_str().unwrap(),
        Some(roots.to_str().unwrap()),
        "img.png",
    )
    .unwrap();
    assert_eq!(
        resolved.file_name().and_then(|n| n.to_str()),
        Some("img.png")
    );
}

#[test]
fn resolves_parent_relative_path_inside_the_authorized_workspace() {
    let workspace = tempdir().unwrap();
    let docs = workspace.path().join("docs");
    let workspace_assets = workspace.path().join("assets");
    let sibling_assets = docs.join("assets");
    let doc = docs.join("guide.md");
    let expected = workspace_assets.join("cover.png");
    fs::create_dir_all(&workspace_assets).unwrap();
    fs::create_dir_all(&sibling_assets).unwrap();
    fs::write(&doc, "![cover](../assets/cover.png)").unwrap();
    fs::write(&expected, b"workspace cover").unwrap();
    fs::write(sibling_assets.join("cover.png"), b"sibling cover").unwrap();

    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, doc.clone()).unwrap();
    let resolved = resolve_relative_image_path_inner(
        &state,
        doc.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "../assets/cover.png",
    )
    .unwrap();

    assert_eq!(resolved, expected.canonicalize().unwrap());
}

#[test]
fn resolves_a_parent_relative_excalidraw_scene_inside_the_workspace() {
    let workspace = tempdir().unwrap();
    let docs = workspace.path().join("docs");
    let diagrams = workspace.path().join("diagrams");
    let doc = docs.join("guide.md");
    let expected = diagrams.join("system diagram.excalidraw");
    fs::create_dir_all(&docs).unwrap();
    fs::create_dir_all(&diagrams).unwrap();
    fs::write(&doc, "[diagram](../diagrams/system%20diagram.excalidraw)").unwrap();
    fs::write(&expected, "{}").unwrap();

    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, doc.clone()).unwrap();
    let resolved = resolve_relative_excalidraw_path_inner(
        &state,
        doc.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "../diagrams/system%20diagram.excalidraw",
    )
    .unwrap();

    assert_eq!(resolved, expected.canonicalize().unwrap());
}

#[test]
fn does_not_fall_back_to_a_workspace_root_excalidraw_scene() {
    let workspace = tempdir().unwrap();
    let docs = workspace.path().join("docs");
    let doc = docs.join("guide.md");
    let unrelated = workspace.path().join("diagram.excalidraw");
    fs::create_dir_all(&docs).unwrap();
    fs::write(&doc, "[diagram](diagram.excalidraw)").unwrap();
    fs::write(&unrelated, "{}").unwrap();

    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, doc.clone()).unwrap();

    let error = resolve_relative_excalidraw_path_inner(
        &state,
        doc.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "diagram.excalidraw",
    )
    .unwrap_err();

    assert_eq!(error, "Excalidraw embed file not found");
}

#[test]
fn rejects_unsafe_or_non_excalidraw_embed_sources() {
    let workspace = tempdir().unwrap();
    let doc = workspace.path().join("guide.md");
    let html = workspace.path().join("diagram.html");
    fs::write(&doc, "# Guide").unwrap();
    fs::write(&html, "<h1>Not a scene</h1>").unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
    authorize_file_inner(&state, doc.clone()).unwrap();

    for source in [
        "https://example.com/diagram.excalidraw",
        "/tmp/diagram.excalidraw",
        "%2Ftmp/diagram.excalidraw",
        "diagram.html",
    ] {
        assert!(
            resolve_relative_excalidraw_path_inner(
                &state,
                doc.to_str().unwrap(),
                Some(workspace.path().to_str().unwrap()),
                source,
            )
            .is_err(),
            "accepted unsafe Excalidraw source: {source}",
        );
    }
}

#[test]
fn rejects_parent_relative_path_that_escapes_the_authorized_workspace() {
    let outer = tempdir().unwrap();
    let workspace = outer.path().join("workspace");
    let docs = workspace.join("docs");
    let doc = docs.join("guide.md");
    let outside = outer.path().join("cover.png");
    fs::create_dir_all(&docs).unwrap();
    fs::write(&doc, "![cover](../../cover.png)").unwrap();
    fs::write(&outside, b"outside cover").unwrap();

    let state = AppState::default();
    let root = authorize_directory_root_inner(&state, workspace).unwrap();
    authorize_file_inner(&state, doc.clone()).unwrap();
    let error = resolve_relative_image_path_inner(
        &state,
        doc.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "../../cover.png",
    )
    .unwrap_err();

    assert_eq!(error, "Resolved image escaped authorized roots");
}

#[cfg(unix)]
#[test]
fn reports_inaccessible_image_instead_of_not_found() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let locked = dir.path().join("locked");
    let image = locked.join("image.png");
    fs::write(&doc, "![x](locked/image.png)").unwrap();
    fs::create_dir(&locked).unwrap();
    fs::write(&image, b"png").unwrap();
    let state = AppState::default();
    authorize_file_inner(&state, doc.clone()).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let result = resolve_relative_image_path_inner(
        &state,
        doc.to_str().unwrap(),
        None,
        "locked/image.png",
    );

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let error = result.unwrap_err();
    assert!(
        error.starts_with("Image file is not accessible:"),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn image_resolver_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let doc = workspace.path().join("doc.md");
    let outside_image = outside.path().join("secret.png");
    let linked_image = workspace.path().join("linked.png");
    fs::write(&doc, "![x](linked.png)").unwrap();
    fs::write(&outside_image, b"not really png").unwrap();
    symlink(&outside_image, &linked_image).unwrap();

    let state = AppState::default();
    authorize_file_inner(&state, doc.clone()).unwrap();

    let result =
        resolve_relative_image_path_inner(&state, doc.to_str().unwrap(), None, "linked.png");
    assert!(result.is_err());
}
