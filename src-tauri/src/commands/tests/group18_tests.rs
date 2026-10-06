use super::fixtures2::*;

#[cfg(unix)]
use std::os::unix::fs::symlink;

#[cfg(unix)]
struct SymlinkSwapWritePort<'a> {
    outside: &'a Path,
}

#[cfg(unix)]
impl FileSystemPort for SymlinkSwapWritePort<'_> {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        fs::remove_file(path)?;
        symlink(self.outside, path)?;
        SystemFileSystemPort.write(path, bytes)
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("symlink-swap test must not create workspace files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("symlink-swap test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("symlink-swap test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("symlink-swap test must not delete through the port")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("symlink-swap test must not delete directories")
    }
}

#[cfg(unix)]
struct SaveAsSymlinkSwapPort<'a> {
    outside: &'a Path,
}

#[cfg(unix)]
impl FileSystemPort for SaveAsSymlinkSwapPort<'_> {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        symlink(self.outside, path)?;
        SystemFileSystemPort.write(path, bytes)
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("save-as symlink-swap test must not create workspace files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("save-as symlink-swap test must not create directories")
    }

    fn rename(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        unreachable!("save-as symlink-swap test must not rename")
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("save-as symlink-swap test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("save-as symlink-swap test must not delete directories")
    }
}

#[cfg(unix)]
#[test]
fn system_write_rejects_existing_file_symlink_swap_without_touching_target() {
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("draft.html");
    let outside_directory = tempdir().unwrap();
    let outside = outside_directory.path().join("outside.html");
    fs::write(&document, "inside-before").unwrap();
    fs::write(&outside, "outside-before").unwrap();
    let state = AppState::default();
    open_directory_inner(&state, workspace.path()).unwrap();
    open_workspace_file_inner(&state, &document).unwrap();
    let canonical_document = document.canonicalize().unwrap();
    let canonical_outside = outside.canonicalize().unwrap();

    let outcome = write_file_with_ports_inner(
        &state,
        &canonical_document,
        "inside-after",
        &SymlinkSwapWritePort {
            outside: &canonical_outside,
        },
    )
    .unwrap();

    assert!(matches!(outcome, MutationOutcome::Indeterminate { .. }));
    assert_eq!(
        fs::read_to_string(&canonical_outside).unwrap(),
        "outside-before"
    );
    assert!(fs::symlink_metadata(&canonical_document)
        .unwrap()
        .file_type()
        .is_symlink());
}
#[cfg(unix)]
#[test]
fn system_write_rejects_save_as_symlink_swap_without_touching_target() {
    let directory = tempdir().unwrap();
    let outside_directory = tempdir().unwrap();
    let destination = directory.path().join("saved.html");
    let outside = outside_directory.path().join("outside.html");
    fs::write(&outside, "outside-before").unwrap();
    let canonical_directory = directory.path().canonicalize().unwrap();
    let normalized_destination = canonical_directory.join("saved.html");
    let canonical_outside = outside.canonicalize().unwrap();
    let state = AppState::default();

    let outcome = save_as_with_ports_inner(
        &state,
        &destination,
        "saved content",
        &SaveAsSymlinkSwapPort {
            outside: &canonical_outside,
        },
    )
    .unwrap();

    assert!(matches!(outcome, MutationOutcome::Indeterminate { .. }));
    assert_eq!(
        fs::read_to_string(&canonical_outside).unwrap(),
        "outside-before"
    );
    assert_eq!(
        state
            .file_authorization()
            .exact_write_grant_snapshot_for_test(&normalized_destination)
            .unwrap(),
        None,
    );
    assert!(fs::symlink_metadata(&normalized_destination)
        .unwrap()
        .file_type()
        .is_symlink());
}
#[test]
fn workspace_session_commands_require_the_main_window_owner() {
    assert!(validate_workspace_session_owner("main").is_ok());
    assert!(validate_workspace_session_owner("mmd-editor-popout").is_err());
    assert!(validate_workspace_session_owner("mmd-preview-popout").is_err());
}
#[test]
fn workspace_session_restore_returns_none_without_a_saved_session() {
    let app_data = tempdir().unwrap();
    let state = session_state(app_data.path().to_path_buf());

    assert!(restore_workspace_session_inner(&state).unwrap().is_none());
}
#[test]
fn workspace_session_restore_reopens_the_workspace_and_prepares_the_last_active_file() {
    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let document = workspace.path().join("notes.md");
    fs::write(&document, "# Notes").unwrap();
    let original_state = session_state(app_data.path().to_path_buf());
    let opened = open_directory_inner(&original_state, workspace.path()).unwrap();
    let canonical_document = document.canonicalize().unwrap();

    persist_workspace_session_inner(
        &original_state,
        &opened.workspace_token,
        &opened.root,
        canonical_document.to_str(),
    )
    .unwrap();

    let restored_state = session_state(app_data.path().to_path_buf());
    let restored = restore_workspace_session_inner(&restored_state)
        .unwrap()
        .expect("saved workspace session is restored");
    let prepared = restored
        .active_file
        .expect("saved active file is prepared for commit");

    assert_eq!(restored.workspace.root, opened.root);
    assert_eq!(prepared.file.path, canonical_document.to_string_lossy());
    assert!(ensure_authorized_write_file_inner(&restored_state, &canonical_document).is_err());
    assert!(matches!(
        restored_state
            .recent_files()
            .unwrap()
            .commit_open(
                &prepared.open_receipt,
                "main",
                restored_state.file_authorization(),
            )
            .unwrap(),
        OpenCommitResult::Committed { .. }
    ));
    assert!(ensure_authorized_write_file_inner(&restored_state, &canonical_document).is_ok());
}
#[test]
fn missing_workspace_session_root_is_cleared_without_authorizing_a_workspace() {
    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let state = session_state(app_data.path().to_path_buf());
    state
        .workspace_session()
        .unwrap()
        .save(&WorkspaceSessionRecord::new(
            canonical_root.to_string_lossy().to_string(),
            None,
        ))
        .unwrap();
    drop(workspace);

    assert!(restore_workspace_session_inner(&state).unwrap().is_none());
    assert!(state.workspace_session().unwrap().load().unwrap().is_none());
    assert!(ensure_authorized_directory_inner(&state, &canonical_root).is_err());
}
#[test]
fn workspace_session_root_that_disappears_during_restore_is_cleared() {
    let app_data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let canonical_root = workspace.path().canonicalize().unwrap();
    let state = session_state(app_data.path().to_path_buf());
    state
        .workspace_session()
        .unwrap()
        .save(&WorkspaceSessionRecord::new(
            canonical_root.to_string_lossy().to_string(),
            None,
        ))
        .unwrap();

    let restored = restore_workspace_session_with_ports_inner(&state, "main", |root| {
        fs::remove_dir_all(root).unwrap();
        Err("workspace disappeared during asset scope setup".to_string())
    })
    .unwrap();

    assert!(restored.is_none());
    assert!(state.workspace_session().unwrap().load().unwrap().is_none());
    assert!(ensure_authorized_directory_inner(&state, &canonical_root).is_err());
}
