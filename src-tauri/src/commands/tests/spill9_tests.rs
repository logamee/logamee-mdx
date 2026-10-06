use super::fixtures2::*;

#[test]
fn system_rename_does_not_replace_a_destination_created_after_preflight() {
    struct RacingSystemRenamePort;

    impl FileSystemPort for RacingSystemRenamePort {
        fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
            unreachable!("rename race test must not write through the port")
        }

        fn create_new(&self, _path: &Path) -> std::io::Result<()> {
            unreachable!("rename race test must not create through the port")
        }

        fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
            unreachable!("rename race test must not create directories")
        }

        fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            fs::write(to, b"racer-owned")?;
            SystemFileSystemPort.rename(from, to)
        }

        fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
            unreachable!("rename race test must not delete files")
        }

        fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
            unreachable!("rename race test must not delete directories")
        }
    }

    let workspace = tempdir().unwrap();
    let source = workspace.path().join("draft.md");
    fs::write(&source, b"source-owned").unwrap();
    let state = AppState::default();
    let opened = open_directory_inner(&state, workspace.path()).unwrap();
    let canonical_source = source.canonicalize().unwrap();
    let normalized_target = workspace.path().canonicalize().unwrap().join("archive.md");
    let snapshot_calls = Cell::new(0);

    let outcome = rename_workspace_entry_with_ports_inner(
        &state,
        &opened.workspace_token,
        &canonical_source,
        "archive.md",
        &RacingSystemRenamePort,
        |_source| {
            snapshot_calls.set(snapshot_calls.get() + 1);
            Err("snapshot must not run after a lost rename race".to_string())
        },
    )
    .unwrap();

    assert!(matches!(outcome, MutationOutcome::Indeterminate { .. }));
    assert_eq!(snapshot_calls.get(), 0);
    assert_eq!(fs::read(&normalized_target).unwrap(), b"racer-owned");
    assert_eq!(fs::read(&canonical_source).unwrap(), b"source-owned");
}
