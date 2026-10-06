use super::test_prelude::*;
use super::*;

#[test]
fn cleans_up_staged_file_after_partial_write_failure() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    TEST_FAULT.with(|fault| *fault.borrow_mut() = Some(TestFault::PartialStagedWrite));

    let error =
        write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

    assert!(error.contains("partial"));
    let resource_dir = dir.path().join("assets/images");
    assert!(resource_dir.exists());
    assert!(fs::read_dir(resource_dir).unwrap().next().is_none());
}
#[cfg(unix)]
#[test]
fn detects_parent_replacement_before_publication_without_writing_outside() {
    let state = AppState::default();
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    fs::create_dir(dir.path().join("assets")).unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let assets = dir.path().join("assets");
    let moved = dir.path().join("assets-moved");
    let outside_path = outside.path().to_path_buf();
    set_before_publish_hook(move || {
        fs::rename(&assets, &moved).unwrap();
        symlink(&outside_path, &assets).unwrap();
    });

    let error =
        write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

    assert!(
        error.contains("atomic")
            || error.contains("publish")
            || error.contains("No such file")
            || error.contains("Staged")
            || error.contains("Workspace root changed")
            || error.contains("authorization")
            || error.contains("Resource directory changed")
            || error.contains("Not a directory")
            || error.contains("Too many levels")
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}
#[test]
fn handles_concurrent_identical_writes_as_single_created_resource() {
    let state = Arc::new(AppState::default());
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
    let (token, root) = open_workspace_and_document(&state, &dir);
    let barrier = Arc::new(Barrier::new(8));
    let results = Arc::new(TestMutex::new(Vec::new()));

    thread::scope(|scope| {
        for _ in 0..8 {
            let state = Arc::clone(&state);
            let token = token.clone();
            let root = root.clone();
            let barrier = Arc::clone(&barrier);
            let results = Arc::clone(&results);
            scope.spawn(move || {
                barrier.wait();
                let result =
                    write_workspace_resource_inner(&state, request(&token, &root, PNG))
                        .unwrap();
                results.lock().unwrap().push(result);
            });
        }
    });

    let results = results.lock().unwrap();
    assert_eq!(results.iter().filter(|result| result.created).count(), 1);
    assert!(results
        .iter()
        .all(|result| result.relative_path == results[0].relative_path));
    let resource_dir = dir.path().join("assets/images");
    let entries = fs::read_dir(resource_dir).unwrap().count();
    assert_eq!(entries, 1);
}
fn write_and_assert_first_pair(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    source_content: &str,
    asset_directory: &Path,
) -> (WriteExcalidrawAssetPairResponse, PathBuf, PathBuf) {
    let svg_one = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#;
    let png_one = b"\x89PNG\r\n\x1a\nfirst";
    let first = write_excalidraw_asset_pair_inner(
        state,
        excalidraw_asset_request(
            workspace_token,
            workspace_root,
            source_content,
            svg_one,
            png_one,
        ),
    )
    .unwrap();

    assert!(first.updated);
    assert!(first.svg_markdown_path.starts_with("../assets/diagrams/"));
    assert!(first.png_markdown_path.starts_with("../assets/diagrams/"));
    let svg_path = asset_directory.join(&first.svg_file_name);
    let png_path = asset_directory.join(&first.png_file_name);
    assert_eq!(fs::read(&svg_path).unwrap(), svg_one);
    assert_eq!(fs::read(&png_path).unwrap(), png_one);
    (first, svg_path, png_path)
}
fn assert_second_pair_write_updates_stable_contents(
    state: &AppState,
    workspace_token: &str,
    workspace_root: &str,
    source_content: &str,
    first: &WriteExcalidrawAssetPairResponse,
    svg_path: &Path,
    png_path: &Path,
) {
    let svg_two = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>"#;
    let png_two = b"\x89PNG\r\n\x1a\nsecond";
    let second = write_excalidraw_asset_pair_inner(
        state,
        excalidraw_asset_request(
            workspace_token,
            workspace_root,
            source_content,
            svg_two,
            png_two,
        ),
    )
    .unwrap();

    assert_eq!(second.svg_file_name, first.svg_file_name);
    assert_eq!(second.png_file_name, first.png_file_name);
    assert_eq!(second.source_sha256, first.source_sha256);
    assert_eq!(first.source_sha256.len(), 64);
    assert_eq!(fs::read(svg_path).unwrap(), svg_two);
    assert_eq!(fs::read(png_path).unwrap(), png_two);
}
#[test]
fn writes_and_updates_stably_named_excalidraw_asset_pair() {
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
    let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");

    let (first, svg_path, png_path) = write_and_assert_first_pair(
        &state,
        &snapshot.workspace_token,
        &snapshot.root,
        source_content,
        &asset_directory,
    );

    assert_second_pair_write_updates_stable_contents(
        &state,
        &snapshot.workspace_token,
        &snapshot.root,
        source_content,
        &first,
        &svg_path,
        &png_path,
    );
}
#[test]
fn rolls_back_svg_when_png_publication_fails() {
    let state = AppState::default();
    let workspace = TempDir::new().unwrap();
    fs::create_dir_all(workspace.path().join("docs")).unwrap();
    fs::create_dir_all(workspace.path().join("diagrams")).unwrap();
    fs::write(workspace.path().join("docs/guide.md"), b"# Guide").unwrap();
    let source_content = crate::excalidraw_scene::default_excalidraw_scene();
    fs::write(
        workspace.path().join("diagrams/system.excalidraw"),
        source_content,
    )
    .unwrap();
    let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, workspace.path().join("docs/guide.md")).unwrap();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#;
    let png = b"\x89PNG\r\n\x1a\nfirst";
    write_excalidraw_asset_pair_inner(
        &state,
        excalidraw_asset_request(
            &snapshot.workspace_token,
            &snapshot.root,
            source_content,
            svg,
            png,
        ),
    )
    .unwrap();
    TEST_FAULT.with(|fault| *fault.borrow_mut() = Some(TestFault::FailPngReplace));
    let changed_svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>"#;
    let error = write_excalidraw_asset_pair_inner(
        &state,
        excalidraw_asset_request(
            &snapshot.workspace_token,
            &snapshot.root,
            source_content,
            changed_svg,
            b"\x89PNG\r\n\x1a\nsecond",
        ),
    )
    .unwrap_err();
    assert!(error.contains("rolled back"), "{error}");
    let asset_dir = workspace.path().join("assets/diagrams/excalidraw-assets");
    let names = stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
    assert_eq!(fs::read(asset_dir.join(names.1)).unwrap(), svg);
}
#[test]
fn refuses_to_take_over_unowned_stable_excalidraw_assets() {
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
    let (_, svg_file_name, png_file_name) =
        stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
    let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");
    fs::create_dir_all(&asset_directory).unwrap();
    fs::write(asset_directory.join(&svg_file_name), b"user-owned-svg").unwrap();

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

    assert!(error.contains("ownership"));
    assert_eq!(
        fs::read(asset_directory.join(svg_file_name)).unwrap(),
        b"user-owned-svg"
    );
    assert!(!asset_directory.join(png_file_name).exists());
}
