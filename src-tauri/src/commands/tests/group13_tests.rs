use super::fixtures2::*;
use super::fixtures3::*;
use super::group13_helpers::{
    assert_committed_delete_receipt, assert_post_delete_refresh_and_reauthorization,
    assert_removed_entry_left_no_authorization_or_provenance, nested_removed_html_entry,
};

#[test]
fn delete_commit_survives_post_commit_snapshot_failure() {
    let entry = nested_removed_html_entry();
    let inner = entry.workspace.path().join("inner");
    let snapshot_calls = std::cell::Cell::new(0);

    let outcome = delete_workspace_entry_with_snapshot_inner(
        &entry.state,
        &entry.opened.workspace_token,
        &entry.canonical_removed,
        |_source: WorkspaceSnapshotSource<'_>| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            assert_removed_entry_left_no_authorization_or_provenance(
                &entry,
                &inner,
                entry.workspace.path(),
            );
            Err("injected post-commit snapshot failure".to_string())
        },
    )
    .expect("committed delete must not become command failure");

    assert_eq!(snapshot_calls.get(), 1);
    assert!(!entry.canonical_removed.exists());
    assert_committed_delete_receipt(
        outcome,
        &entry.canonical_removed,
        &entry.opened.workspace_token,
    );
    assert_post_delete_refresh_and_reauthorization(&entry);
}
#[test]
fn renaming_directory_preserves_write_authorization_for_open_descendants() {
    let dir = tempdir().unwrap();
    let notes = dir.path().join("notes");
    let doc = notes.join("doc.md");
    fs::create_dir(&notes).unwrap();
    fs::write(&doc, "# before").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();
    open_workspace_file_inner(&state, &doc).unwrap();

    let renamed = committed_rename_response(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &notes,
        "archive",
    ));
    let renamed_doc = Path::new(&renamed.new_path).join("doc.md");

    write_file_inner(&state, &renamed_doc, "# after").unwrap();
    assert_eq!(fs::read_to_string(renamed_doc).unwrap(), "# after");
}
#[test]
fn moving_directory_preserves_write_authorization_for_open_descendants() {
    let dir = tempdir().unwrap();
    let notes = dir.path().join("notes");
    let archive = dir.path().join("archive");
    let doc = notes.join("doc.md");
    fs::create_dir(&notes).unwrap();
    fs::create_dir(&archive).unwrap();
    fs::write(&doc, "# before").unwrap();
    let canonical_archive = fs::canonicalize(&archive).unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();
    open_workspace_file_inner(&state, &doc).unwrap();

    let moved = committed_rename_response(move_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &notes,
        &archive,
    ));
    let moved_doc = Path::new(&moved.new_path).join("doc.md");

    assert_eq!(Path::new(&moved.new_path), canonical_archive.join("notes"));
    assert!(!notes.exists());
    write_file_inner(&state, &moved_doc, "# after").unwrap();
    assert_eq!(fs::read_to_string(moved_doc).unwrap(), "# after");
}
#[test]
fn moving_workspace_entries_rejects_outside_descendant_and_existing_destinations() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let notes = workspace.path().join("notes");
    let nested = notes.join("nested");
    let archive = workspace.path().join("archive");
    let document = notes.join("draft.md");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir(&archive).unwrap();
    fs::write(&document, "# draft").unwrap();
    fs::write(archive.join("draft.md"), "# existing").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    assert_confirmed_not_committed(move_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &document,
        outside.path(),
    ));
    assert_confirmed_not_committed(move_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &notes,
        &nested,
    ));
    assert_confirmed_not_committed(move_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &document,
        &archive,
    ));

    assert!(document.is_file());
    assert!(notes.is_dir());
    assert_eq!(
        fs::read_to_string(archive.join("draft.md")).unwrap(),
        "# existing"
    );
}
#[test]
fn workspace_image_rename_preserves_its_file_kind() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("cover.png");
    fs::write(&image, [0x89, b'P', b'N', b'G']).unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();

    let renamed = committed_rename_response(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &image,
        "hero.webp",
    ));

    assert!(renamed.new_path.ends_with("hero.webp"));
    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &renamed.new_path,
        "hero.md",
    ));
}
#[test]
fn workspace_html_and_media_renames_preserve_their_file_kinds() {
    let dir = tempdir().unwrap();
    let html = dir.path().join("index.html");
    let video = dir.path().join("clip.mp4");
    fs::write(&html, "<h1>Home</h1>").unwrap();
    fs::write(&video, b"video").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, dir.path()).unwrap();

    let renamed_html = committed_rename_response(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &html,
        "home.htm",
    ));
    let renamed_video = committed_rename_response(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &video,
        "movie.flv",
    ));

    assert!(renamed_html.new_path.ends_with("home.htm"));
    assert!(renamed_video.new_path.ends_with("movie.flv"));
    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &renamed_html.new_path,
        "home.md",
    ));
    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &renamed_video.new_path,
        "movie.mp3",
    ));
}
