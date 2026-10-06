use super::*;
use super::identity::windows_shell_parsing_name_from_wide;
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[test]
fn windows_shell_parsing_name_converts_a_supported_verbatim_drive_path() {
    assert_eq!(
        windows_shell_parsing_name_from_wide(&wide(
            r"\\?\C:\Users\runneradmin\AppData\Local\Temp\note.md"
        ))
        .unwrap(),
        wide(r"C:\Users\runneradmin\AppData\Local\Temp\note.md"),
    );
}

#[test]
fn windows_shell_parsing_name_rejects_unc_and_device_namespaces() {
    for value in [r"C:\Users\runneradmin\AppData\Local\Temp\note.md"] {
        assert_eq!(
            windows_shell_parsing_name_from_wide(&wide(value)).unwrap(),
            wide(value),
        );
    }
    for value in [
        r"\\?\UNC\server\share\folder\note.md",
        r"\\server\share\folder\note.md",
    ] {
        assert_eq!(
            windows_shell_parsing_name_from_wide(&wide(value)),
            Err("Windows UNC paths are not supported for Shell Trash"),
        );
    }
    assert_eq!(
        windows_shell_parsing_name_from_wide(&wide(
            r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\note.md"
        )),
        Err("unsupported Windows verbatim path for Shell parsing"),
    );
    assert_eq!(
        windows_shell_parsing_name_from_wide(&wide(r"\\.\PhysicalDrive0")),
        Err("unsupported Windows device path for Shell parsing"),
    );
}

#[cfg(windows)]
#[test]
fn canonical_verbatim_source_uses_an_equivalent_dos_shell_name() {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::Component}; // platform-audit: allow (platform-gated trash transport)

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    fs::write(&source, "content").unwrap();
    let canonical = fs::canonicalize(&source).unwrap();
    assert!(matches!(
        canonical.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
    ));

    let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
    let shell_name = platform::shell_parsing_name(&canonical, &expected).unwrap();
    assert_eq!(shell_name.last(), Some(&0));
    let shell_path =
        std::path::PathBuf::from(OsString::from_wide(&shell_name[..shell_name.len() - 1]));
    assert!(!shell_path.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(fs::canonicalize(shell_path).unwrap(), canonical);
}

#[cfg(windows)]
#[test]
fn canonical_shell_name_rejects_a_same_path_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    fs::write(&source, "authorized").unwrap();
    let canonical = fs::canonicalize(&source).unwrap();
    let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
    fs::remove_file(&source).unwrap();
    fs::write(&source, "replacement").unwrap();

    let error = platform::shell_parsing_name(&canonical, &expected).unwrap_err();
    assert_eq!(error.operation, "revalidate trash source identity");
    assert!(error.message.contains("source changed"));
    assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
}

#[cfg(windows)]
#[test]
fn pre_delete_identity_guard_keeps_a_replacement_unmoved_and_uncommitted() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    fs::write(&source, "authorized").unwrap();
    let mut port = NativeTrashPort {
        source_identity: None,
        injected_move: Some(Box::new(|source, _, expected| {
            fs::remove_file(source).unwrap();
            fs::write(source, "replacement").unwrap();
            match platform::validate_pre_delete_identity(source, &expected) {
                Ok(()) => panic!("same-path replacement must fail the pre-delete guard"),
                Err(error) => MoveToTrash::Rejected { error },
            }
        })),
    };

    let classification =
        crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File);

    assert!(matches!(
        classification,
        crate::workspace_trash::TrashClassification::Indeterminate { .. }
    ));
    assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
}

#[test]
fn recreated_source_is_unobservable_instead_of_present() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    fs::write(&source, "first").unwrap();
    let identity = capture_source_identity(&source, TrashEntryKind::File).unwrap();
    let mut port = NativeTrashPort {
        source_identity: Some(identity),
        injected_move: None,
    };
    fs::remove_file(&source).unwrap();
    fs::write(&source, "replacement").unwrap();

    assert!(matches!(
        port.observe_source(&source),
        SourceObservation::Unobservable { .. }
    ));
}
