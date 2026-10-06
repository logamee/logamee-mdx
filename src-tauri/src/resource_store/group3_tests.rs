use super::test_prelude::*;
use super::*;

#[test]
fn refuses_to_replace_assets_owned_by_a_different_source() {
    let state = AppState::default();
    let workspace = TempDir::new().unwrap();
    let docs = workspace.path().join("docs");
    let diagrams = workspace.path().join("diagrams");
    fs::create_dir_all(&docs).unwrap();
    fs::create_dir_all(&diagrams).unwrap();
    fs::write(docs.join("guide.md"), b"# Guide").unwrap();
    let source_content = crate::excalidraw_scene::default_excalidraw_scene();
    fs::write(diagrams.join("system.excalidraw"), source_content).unwrap();
    let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
    let (ownership_file_name, svg_file_name, _) =
        stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
    let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");
    fs::create_dir_all(&asset_directory).unwrap();
    fs::write(
        asset_directory.join(ownership_file_name),
        b"diagrams/other.excalidraw",
    )
    .unwrap();
    fs::write(asset_directory.join(&svg_file_name), b"other-source-svg").unwrap();

    let error = write_excalidraw_asset_pair_inner(
        &state,
        excalidraw_asset_request(
            &snapshot.workspace_token,
            &snapshot.root,
            source_content,
            br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
            b"\x89PNG\r\n\x1a\nnew",
        ),
    )
    .unwrap_err();

    assert!(error.contains("different source"));
    assert_eq!(
        fs::read(asset_directory.join(svg_file_name)).unwrap(),
        b"other-source-svg"
    );
}
#[test]
fn rejects_excalidraw_assets_when_source_content_is_stale() {
    let state = AppState::default();
    let workspace = TempDir::new().unwrap();
    let docs = workspace.path().join("docs");
    let diagrams = workspace.path().join("diagrams");
    fs::create_dir_all(&docs).unwrap();
    fs::create_dir_all(&diagrams).unwrap();
    fs::write(docs.join("guide.md"), b"# Guide").unwrap();
    fs::write(
        diagrams.join("system.excalidraw"),
        crate::excalidraw_scene::default_excalidraw_scene(),
    )
    .unwrap();
    let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
    let request = excalidraw_asset_request(
        &snapshot.workspace_token,
        &snapshot.root,
        "{\"type\":\"excalidraw\",\"version\":2,\"elements\":[],\"appState\":{},\"files\":{}}",
        br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
        b"\x89PNG\r\n\x1a\nstale",
    );

    let error = write_excalidraw_asset_pair_inner(&state, request).unwrap_err();

    assert!(error.contains("changed") || error.contains("match"));
    assert!(!workspace.path().join("assets").exists());
}
