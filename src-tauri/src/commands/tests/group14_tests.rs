use super::fixtures2::*;
use super::fixtures3::*;

#[test]
fn rename_preserves_kind_and_rejects_cross_kind_target() {
    let cases = [
        ("document.md", "document.mdx", "document.html"),
        ("page.html", "page.htm", "page.png"),
        ("cover.png", "cover.webp", "cover.mp4"),
        ("clip.mp4", "clip.webm", "clip.mp3"),
        ("track.mp3", "track.wav", "track.md"),
    ];

    for (source_name, same_kind_name, cross_kind_name) in cases {
        let workspace = tempdir().unwrap();
        let source = workspace.path().join(source_name);
        fs::write(&source, b"content").unwrap();
        let state = AppState::default();
        let opened = open_directory_inner(&state, workspace.path()).unwrap();

        let same_kind = committed_rename_response(rename_workspace_entry_inner(
            &state,
            &opened.workspace_token,
            &source,
            same_kind_name,
        ));
        let same_kind_path = workspace.path().join(same_kind_name);
        let cross_kind_path = workspace.path().join(cross_kind_name);

        assert_eq!(
            Path::new(&same_kind.new_path),
            same_kind_path.canonicalize().unwrap()
        );
        assert!(!source.exists());
        assert!(same_kind_path.is_file());
        assert_confirmed_not_committed(rename_workspace_entry_inner(
            &state,
            &opened.workspace_token,
            &same_kind_path,
            cross_kind_name,
        ));
        assert!(same_kind_path.is_file());
        assert!(!cross_kind_path.exists());
    }

    let workspace = tempdir().unwrap();
    let unsupported = workspace.path().join("notes.txt");
    let promoted = workspace.path().join("notes.md");
    fs::write(&unsupported, "notes").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    assert_confirmed_not_committed(rename_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &unsupported,
        "notes.md",
    ));
    assert!(unsupported.is_file());
    assert!(!promoted.exists());
}
fn copy_workspace_fixture() -> (tempfile::TempDir, AppState, WorkspaceSnapshot) {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let note = workspace.path().join("note.md");
    fs::write(&note, "# hello").unwrap();
    fs::create_dir_all(workspace.path().join("book/chapters")).unwrap();
    fs::write(workspace.path().join("book/chapters/one.md"), "one").unwrap();
    fs::create_dir(workspace.path().join("notes")).unwrap();
    (workspace, state, opened)
}

fn committed_copy(
    outcome: Result<MutationOutcome<RenameWorkspaceEntryResponse, WorkspaceSnapshot>, String>,
) -> RenameWorkspaceEntryResponse {
    match outcome.unwrap() {
        MutationOutcome::ConfirmedCommitted { receipt } => receipt.committed,
        outcome => panic!("expected a committed copy, got {outcome:?}"),
    }
}

fn assert_duplicate_copy_derives_note_copy(
    workspace: &Path,
    state: &AppState,
    opened: &WorkspaceSnapshot,
    note: &Path,
) {
    // Pasting a second copy into the same folder derives "note copy.md"
    // instead of refusing, matching mainstream file managers.
    let duplicate = committed_copy(copy_workspace_entry_inner(
        state,
        &opened.workspace_token,
        note,
        workspace.join("notes"),
    ));
    assert!(Path::new(&duplicate.new_path).ends_with(Path::new("notes").join("note copy.md")));
    assert_eq!(
        fs::read_to_string(workspace.join("notes/note copy.md")).unwrap(),
        "# hello"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("notes/note.md")).unwrap(),
        "# hello"
    );
}

fn assert_directory_tree_copy(workspace: &Path, state: &AppState, opened: &WorkspaceSnapshot) {
    let copied_tree = committed_copy(copy_workspace_entry_inner(
        state,
        &opened.workspace_token,
        workspace.join("book"),
        workspace.join("notes"),
    ));
    assert_eq!(copied_tree.entry_kind, "directory");
    assert_eq!(
        fs::read_to_string(workspace.join("notes/book/chapters/one.md")).unwrap(),
        "one"
    );
}

#[test]
fn copies_workspace_entries_inside_the_workspace_and_rejects_conflicts() {
    let (workspace, state, opened) = copy_workspace_fixture();
    let note = workspace.path().join("note.md");

    let committed = committed_copy(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &note,
        workspace.path().join("notes"),
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("notes/note.md")).unwrap(),
        "# hello"
    );
    assert_eq!(committed.entry_kind, "file");
    assert!(Path::new(&committed.new_path).ends_with(Path::new("notes").join("note.md")));

    assert_confirmed_not_committed(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &note,
        workspace.path(),
    ));
    assert_duplicate_copy_derives_note_copy(workspace.path(), &state, &opened, &note);
    assert_directory_tree_copy(workspace.path(), &state, &opened);

    assert_confirmed_not_committed(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        workspace.path().join("book"),
        workspace.path().join("book/chapters"),
    ));
    committed_copy(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &note,
        workspace.path().join("book"),
    ));
    assert_confirmed_not_committed(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &note,
        workspace.path(),
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("book/note.md")).unwrap(),
        "# hello"
    );
}
#[test]
fn copy_rejects_sources_outside_the_authorized_workspace() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_note = outside.path().join("outside.md");
    fs::write(&outside_note, "# outside").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    assert_confirmed_not_committed(copy_workspace_entry_inner(
        &state,
        &opened.workspace_token,
        &outside_note,
        workspace.path(),
    ));
    assert!(!workspace.path().join("outside.md").exists());
}
struct CapturingRevealPort {
    revealed: std::sync::Mutex<Option<PathBuf>>,
}
impl RevealPort for CapturingRevealPort {
    fn reveal(&self, path: &Path) -> Result<(), String> {
        *self.revealed.lock().unwrap() = Some(path.to_path_buf());
        Ok(())
    }
}
#[test]
fn reveal_uses_the_canonical_path_and_requires_authorized_entries() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("outside.md"), "# outside").unwrap();
    let state = AppState::default();
    let _opened = open_directory_inner(&state, workspace.path()).unwrap();
    let note = workspace.path().join("note.md");
    fs::write(&note, "# hello").unwrap();
    let port = CapturingRevealPort {
        revealed: std::sync::Mutex::new(None),
    };

    let canonical = reveal_workspace_entry_with_port_inner(&state, &note, &port).unwrap();
    assert_eq!(canonical, note.canonicalize().unwrap());
    assert_eq!(
        port.revealed.lock().unwrap().as_deref(),
        Some(canonical.as_path())
    );

    let directory = reveal_workspace_entry_with_port_inner(
        &state,
        workspace.path().canonicalize().unwrap(),
        &port,
    )
    .unwrap();
    assert_eq!(directory, workspace.path().canonicalize().unwrap());

    assert!(reveal_workspace_entry_with_port_inner(
        &state,
        outside.path().join("outside.md"),
        &port
    )
    .is_err());
}
#[test]
fn workspace_entry_names_reject_windows_reserved_device_names() {
    let workspace = tempdir().unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();

    for name in [
        "CON.md",
        "con",
        "Com1.txt",
        "LPT9.md",
        "aux",
        "NUL",
        "notes.md.",
    ] {
        assert_confirmed_not_committed(create_workspace_file_inner(
            &state,
            &opened.workspace_token,
            workspace.path(),
            name,
        ));
        assert_confirmed_not_committed(create_workspace_directory_inner(
            &state,
            &opened.workspace_token,
            workspace.path(),
            name,
        ));
    }

    let valid = match create_workspace_file_inner(
        &state,
        &opened.workspace_token,
        workspace.path(),
        "connector.md",
    ) {
        Ok(MutationOutcome::ConfirmedCommitted { .. }) => true,
        _ => false,
    };
    assert!(valid);
}
