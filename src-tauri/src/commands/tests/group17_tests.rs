use super::fixtures2::*;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn system_rename_moves_an_entry_when_the_destination_is_absent() {
    let workspace = tempdir().unwrap();
    let source = workspace.path().join("draft.md");
    let target = workspace.path().join("archive.md");
    fs::write(&source, b"source-owned").unwrap();

    SystemFileSystemPort.rename(&source, &target).unwrap();

    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), b"source-owned");
}
#[cfg(windows)]
mod windows_handle_bound_filesystem {
    use super::*;
    use std::{os::windows::fs::symlink_file, process::Command};

    fn create_junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "failed to create test junction");
    }

    #[test]
    fn writes_existing_and_new_regular_files() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let existing = parent.join("existing.md");
        let new = parent.join("new.md");
        fs::write(&existing, b"old-longer-content").unwrap();

        SystemFileSystemPort.write(&existing, b"updated").unwrap();
        SystemFileSystemPort.write(&new, b"created").unwrap();

        assert_eq!(fs::read(existing).unwrap(), b"updated");
        assert_eq!(fs::read(new).unwrap(), b"created");
    }

    #[test]
    fn renames_unicode_file_without_replacing_destination() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("草稿.md");
        let destination = parent.join("定稿.md");
        fs::write(&source, b"source").unwrap();

        SystemFileSystemPort.rename(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination).unwrap(), b"source");
    }

    #[test]
    fn renames_file_to_a_single_code_unit_name() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("source.md");
        let destination = parent.join("x");
        fs::write(&source, b"source").unwrap();

        SystemFileSystemPort.rename(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination).unwrap(), b"source");
    }

    #[test]
    fn rename_preserves_existing_destination_and_source() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("source.md");
        let destination = parent.join("destination.md");
        fs::write(&source, b"source-owned").unwrap();
        fs::write(&destination, b"destination-owned").unwrap();

        let error = SystemFileSystemPort
            .rename(&source, &destination)
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(source).unwrap(), b"source-owned");
        assert_eq!(fs::read(destination).unwrap(), b"destination-owned");
    }

    #[test]
    fn renames_directory_without_replacing_destination() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("drafts");
        let destination = parent.join("archive");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("nested.md"), b"nested").unwrap();

        SystemFileSystemPort.rename(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination.join("nested.md")).unwrap(), b"nested");
    }

    #[test]
    fn directory_rename_preserves_existing_destination_and_source() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("source-directory");
        let destination = parent.join("destination-directory");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(source.join("source.md"), b"source-owned").unwrap();
        fs::write(destination.join("destination.md"), b"destination-owned").unwrap();

        let error = SystemFileSystemPort
            .rename(&source, &destination)
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(source.join("source.md")).unwrap(), b"source-owned");
        assert_eq!(
            fs::read(destination.join("destination.md")).unwrap(),
            b"destination-owned"
        );
    }

    #[test]
    fn rename_does_not_replace_destination_created_after_preflight() {
        let workspace = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let source = parent.join("source.md");
        let destination = parent.join("destination.md");
        fs::write(&source, b"source-owned").unwrap();

        let error =
            windows_handle_files::rename_no_replace_with_hook(&source, &destination, || {
                fs::write(&destination, b"racer-owned")
            })
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(source).unwrap(), b"source-owned");
        assert_eq!(fs::read(destination).unwrap(), b"racer-owned");
    }

    #[test]
    fn rename_rejects_source_and_destination_child_reparse_points() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let external_source = outside.path().join("external-source.md");
        let external_destination = outside.path().join("external-destination.md");
        let source_link = parent.join("source-link.md");
        let destination_link = parent.join("destination-link.md");
        fs::write(&external_source, b"external-source-owned").unwrap();
        fs::write(&external_destination, b"external-destination-owned").unwrap();
        symlink_file(&external_source, &source_link).unwrap();
        symlink_file(&external_destination, &destination_link).unwrap();

        let source_error = SystemFileSystemPort
            .rename(&source_link, &parent.join("renamed.md"))
            .unwrap_err();
        assert_eq!(source_error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            fs::read(&external_source).unwrap(),
            b"external-source-owned"
        );

        let regular_source = parent.join("regular-source.md");
        fs::write(&regular_source, b"regular-source-owned").unwrap();
        let destination_error = SystemFileSystemPort
            .rename(&regular_source, &destination_link)
            .unwrap_err();
        assert_eq!(destination_error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(regular_source).unwrap(), b"regular-source-owned");
        assert_eq!(
            fs::read(external_destination).unwrap(),
            b"external-destination-owned"
        );
    }

    #[test]
    fn write_rejects_child_reparse_point_without_touching_external_target() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let parent = workspace.path().canonicalize().unwrap();
        let external = outside.path().join("external.md");
        let child = parent.join("child.md");
        fs::write(&external, b"external-owned").unwrap();
        symlink_file(&external, &child).unwrap();

        let error = SystemFileSystemPort
            .write(&child, b"attacker-write")
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(external).unwrap(), b"external-owned");
    }

    #[test]
    fn write_rejects_junction_parent_without_touching_external_target() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let junction = workspace.path().join("linked");
        let external = outside.path().join("external.md");
        fs::write(&external, b"external-owned").unwrap();
        create_junction(&junction, outside.path());

        let error = SystemFileSystemPort
            .write(&junction.join("external.md"), b"attacker-write")
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(external).unwrap(), b"external-owned");
    }

    #[test]
    fn rename_rejects_source_and_destination_junction_parents() {
        let workspace = tempdir().unwrap();
        let source_outside = tempdir().unwrap();
        let destination_outside = tempdir().unwrap();
        let source_junction = workspace.path().join("source-linked");
        let destination_junction = workspace.path().join("destination-linked");
        create_junction(&source_junction, source_outside.path());
        create_junction(&destination_junction, destination_outside.path());
        fs::write(source_outside.path().join("source.md"), b"source-owned").unwrap();

        let source_parent_error = SystemFileSystemPort
            .rename(
                &source_junction.join("source.md"),
                &workspace.path().join("target.md"),
            )
            .unwrap_err();
        assert_eq!(source_parent_error.kind(), io::ErrorKind::PermissionDenied);

        let regular_source = workspace.path().join("regular.md");
        fs::write(&regular_source, b"regular-owned").unwrap();
        let destination_parent_error = SystemFileSystemPort
            .rename(&regular_source, &destination_junction.join("target.md"))
            .unwrap_err();
        assert_eq!(
            destination_parent_error.kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(fs::read(regular_source).unwrap(), b"regular-owned");
        assert!(!destination_outside.path().join("target.md").exists());
    }
}
