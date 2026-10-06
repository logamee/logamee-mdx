mod entry;
use entry::{
    create_private_directory, ensure_same_device, error_with_reserved_info_cleanup,
    mount_root, rename_no_replace, reserve_unique_entry, select_trash_root,
    sync_commit_directories, trash_info_contents, write_and_sync,
};
use super::{
    ensure_identity_unchanged, verify_kind, verify_receipt_identity, NativeSourceIdentity,
    NativeTrashError, NativeTrashReceipt,
};
#[cfg(test)]
use super::capture_source_identity;
#[cfg(test)]
use entry::unique_name;
use crate::workspace_trash::{MoveToTrash, PlacementVerification, TrashEntryKind};

#[cfg(target_os = "linux")]
use std::{
    env,
    ffi::{CString, OsStr},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{ // platform-audit: allow (platform-gated trash transport)
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};

pub(super) fn move_to_trash(
    source: &Path,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
    match move_to_trash_inner(source, kind, source_identity) {
        Ok((receipt, warning)) => match warning {
            Some(error) => MoveToTrash::PossiblyMoved {
                recovery_receipt: Some(receipt),
                error,
            },
            None => MoveToTrash::Placed {
                recovery_receipt: receipt,
            },
        },
        Err(error) => MoveToTrash::Rejected { error },
    }
}

fn move_to_trash_inner(
    source: &Path,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
) -> Result<(NativeTrashReceipt, Option<NativeTrashError>), NativeTrashError> {
    if !source.is_absolute() {
        return Err(NativeTrashError::new(
            "validate trash source",
            "source path must be absolute",
        ));
    }
    ensure_identity_unchanged(source, &source_identity)?;

    let parent = source.parent().ok_or_else(|| {
        NativeTrashError::new("locate trash source parent", "source has no parent")
    })?;
    let source_device = match source_identity {
        NativeSourceIdentity::Unix { device, .. } => device,
    };
    let mount_root = mount_root(parent, source_device)
        .map_err(|error| NativeTrashError::new("locate source mount", error))?;
    let (trash_root, home_trash) = select_trash_root(&mount_root, source_device)?;
    let files_dir = trash_root.join("files");
    let info_dir = trash_root.join("info");
    create_private_directory(&trash_root)?;
    create_private_directory(&files_dir)?;
    create_private_directory(&info_dir)?;
    ensure_same_device(&files_dir, source_device)?;
    ensure_same_device(&info_dir, source_device)?;

    let base_name = source
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| NativeTrashError::new("name trash entry", "source has no file name"))?;
    let trash_info_path = if home_trash {
        source
    } else {
        source.strip_prefix(&mount_root).map_err(|_| {
            NativeTrashError::new(
                "record trash recovery path",
                "source is outside its detected mount root",
            )
        })?
    };
    let trash_info = trash_info_contents(trash_info_path)?;
    let (destination, info_path, mut info_file) =
        reserve_unique_entry(&files_dir, &info_dir, base_name)?;
    if let Err(error) = write_and_sync(&mut info_file, &trash_info) {
        drop(info_file);
        return Err(error_with_reserved_info_cleanup(
            "write trash recovery metadata",
            error,
            &info_path,
        ));
    }
    drop(info_file);

    if let Err(error) = rename_no_replace(source, &destination) {
        return Err(error_with_reserved_info_cleanup(
            "rename source into trash",
            error,
            &info_path,
        ));
    }

    let receipt = NativeTrashReceipt {
        destination,
        kind,
        trash_info: info_path,
        expected_trash_info: trash_info,
        source_identity,
    };
    let warning = sync_commit_directories(&files_dir, &info_dir)
        .err()
        .map(|error| NativeTrashError::new("sync trash placement", error));
    Ok((receipt, warning))
}

pub(super) fn verify_placement(
    receipt: &NativeTrashReceipt,
) -> PlacementVerification<NativeTrashError> {
    let metadata = match fs::symlink_metadata(&receipt.destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return PlacementVerification::Missing
        }
        Err(error) => {
            return PlacementVerification::Unobservable {
                error: NativeTrashError::new("observe trashed entry", error),
            }
        }
    };
    if !verify_kind(&metadata, receipt.kind) {
        return PlacementVerification::Mismatch;
    }
    match verify_receipt_identity(receipt) {
        Ok(true) => {}
        Ok(false) => return PlacementVerification::Mismatch,
        Err(error) => return PlacementVerification::Unobservable { error },
    }
    match fs::read(&receipt.trash_info) {
        Ok(contents) if contents == receipt.expected_trash_info => {
            PlacementVerification::Proven
        }
        Ok(_) => PlacementVerification::Mismatch,
        Err(error) if error.kind() == io::ErrorKind::NotFound => PlacementVerification::Missing,
        Err(error) => PlacementVerification::Unobservable {
            error: NativeTrashError::new("read trash recovery metadata", error),
        },
    }
}

#[cfg(test)]
mod tests {
use super::*;

#[test]
fn percent_encodes_paths_without_destroying_path_separators() {
    let contents = trash_info_contents(Path::new("/tmp/a b#c%25/文.md")).unwrap();
    let text = String::from_utf8(contents).unwrap();
    assert!(text.contains("Path=/tmp/a%20b%23c%2525/%E6%96%87.md\n"));
}

#[test]
fn top_directory_trash_records_a_relative_recovery_path() {
    let mount_root = Path::new("/media/archive");
    let source = Path::new("/media/archive/docs/note.md");
    let relative = source.strip_prefix(mount_root).unwrap();
    let text = String::from_utf8(trash_info_contents(relative).unwrap()).unwrap();
    assert!(text.contains("Path=docs/note.md\n"));
    assert!(!text.contains("Path=/media/archive"));
}

#[test]
fn unique_names_preserve_non_utf8_bytes() {
    let base = OsStr::from_bytes(b"note-\xff.md");
    assert_eq!(unique_name(base, 0).as_bytes(), b"note-\xff.md");
    assert_eq!(unique_name(base, 3).as_bytes(), b"note-\xff.md.3");
}

#[test]
fn mount_root_stops_at_a_device_boundary() {
    let root_device = fs::metadata("/").unwrap().dev();
    assert_eq!(
        mount_root(Path::new("/"), root_device).unwrap(),
        Path::new("/")
    );
}

#[test]
fn preserves_reserved_metadata_cleanup_failure_with_primary_error() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("missing.trashinfo");
    let primary = io::Error::from_raw_os_error(libc::EXDEV); // platform-audit: allow (linux-only trash transport)
    let primary_message = primary.to_string();
    let error =
        error_with_reserved_info_cleanup("rename source into trash", primary, &missing);

    assert!(error.message.contains(&primary_message));
    assert!(error
        .message
        .contains("failed to remove reserved recovery metadata"));
}

#[test]
fn collision_reservation_keeps_existing_entry_and_uses_suffix() {
    let temp = tempfile::tempdir().unwrap();
    let files = temp.path().join("files");
    let info = temp.path().join("info");
    create_private_directory(&files).unwrap();
    create_private_directory(&info).unwrap();
    fs::write(files.join("note.md"), "existing").unwrap();
    fs::write(info.join("note.md.trashinfo"), "existing-info").unwrap();

    let (destination, info_path, _reservation) =
        reserve_unique_entry(&files, &info, OsStr::new("note.md")).unwrap();

    assert_eq!(destination.file_name().unwrap(), "note.md.1");
    assert_eq!(info_path.file_name().unwrap(), "note.md.1.trashinfo");
    assert_eq!(
        fs::read_to_string(files.join("note.md")).unwrap(),
        "existing"
    );
}

#[test]
fn moves_files_and_reobserves_the_recovery_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("note.md");
    fs::write(&source, "draft").unwrap();
    let source_identity = capture_source_identity(&source, TrashEntryKind::File).unwrap();
    let trash_root = temp.path().join("trash");
    let files = trash_root.join("files");
    let info = trash_root.join("info");
    create_private_directory(&files).unwrap();
    create_private_directory(&info).unwrap();
    let contents = trash_info_contents(&source).unwrap();
    let (destination, trash_info, mut file) =
        reserve_unique_entry(&files, &info, source.file_name().unwrap()).unwrap();
    write_and_sync(&mut file, &contents).unwrap();
    drop(file);
    rename_no_replace(&source, &destination).unwrap();
    let receipt = NativeTrashReceipt {
        destination,
        kind: TrashEntryKind::File,
        trash_info,
        expected_trash_info: contents,
        source_identity,
    };

    assert_eq!(verify_placement(&receipt), PlacementVerification::Proven);
    assert!(!source.exists());
}

#[test]
fn verifies_non_empty_directories_without_copying() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("folder");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("child.md"), "content").unwrap();
    let source_identity =
        capture_source_identity(&source, TrashEntryKind::Directory).unwrap();
    let files = temp.path().join("trash/files");
    let info = temp.path().join("trash/info");
    create_private_directory(&files).unwrap();
    create_private_directory(&info).unwrap();
    let contents = trash_info_contents(&source).unwrap();
    let (destination, trash_info, mut file) =
        reserve_unique_entry(&files, &info, source.file_name().unwrap()).unwrap();
    write_and_sync(&mut file, &contents).unwrap();
    drop(file);
    rename_no_replace(&source, &destination).unwrap();
    let receipt = NativeTrashReceipt {
        destination,
        kind: TrashEntryKind::Directory,
        trash_info,
        expected_trash_info: contents,
        source_identity,
    };

    assert_eq!(verify_placement(&receipt), PlacementVerification::Proven);
    assert!(receipt.destination.join("child.md").is_file());
}
}
