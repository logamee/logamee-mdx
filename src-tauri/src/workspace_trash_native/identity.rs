//! Source identity capture and receipt verification.
use std::{fs, path::Path};
#[cfg(windows)]
use std::io;

#[cfg(windows)]
use std::os::windows::ffi::OsStringExt; // platform-audit: allow (platform-gated trash transport)

use super::{ NativeSourceIdentity, NativeTrashError, NativeTrashReceipt };
use crate::workspace_trash::TrashEntryKind;

#[cfg(unix)]
pub(super) fn capture_source_identity(
    path: &Path,
    kind: TrashEntryKind,
) -> Result<NativeSourceIdentity, NativeTrashError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash source identity", error))?;
    validate_source_type(&metadata, kind)?;
    use std::os::unix::fs::MetadataExt; // platform-audit: allow (platform-gated trash transport)
    #[cfg(target_os = "linux")]
    let inode_lease = {
        use super::LinuxInodeLease;
        use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt, sync::Arc}; // platform-audit: allow (platform-gated trash transport)

        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) // platform-audit: allow (platform-gated trash transport)
            .open(path)
            .map_err(|error| NativeTrashError::new("pin trash source identity", error))?;
        let pinned = file.metadata().map_err(|error| {
            NativeTrashError::new("inspect pinned trash source identity", error)
        })?;
        validate_source_type(&pinned, kind)?;
        if pinned.dev() != metadata.dev() || pinned.ino() != metadata.ino() {
            return Err(NativeTrashError::new(
                "pin trash source identity",
                "source changed while its filesystem identity was being retained",
            ));
        }
        LinuxInodeLease {
            _file: Arc::new(file),
        }
    };
    Ok(NativeSourceIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
        kind,
        #[cfg(target_os = "linux")]
        inode_lease,
    })
}

#[cfg(windows)]
pub(super) fn capture_source_identity(
    path: &Path,
    kind: TrashEntryKind,
) -> Result<NativeSourceIdentity, NativeTrashError> {
    use std::os::windows::fs::MetadataExt; // platform-audit: allow (platform-gated trash transport)
    use std::{os::windows::ffi::OsStrExt, ptr}; // platform-audit: allow (platform-gated trash transport)
    use windows_sys::Win32::{ // platform-audit: allow (platform-gated trash transport)
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash source identity", error))?;
    validate_source_type(&metadata, kind)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "symbolic links and reparse points cannot be moved to Trash",
        ));
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(NativeTrashError::new(
            "open trash source identity",
            io::Error::last_os_error(),
        ));
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    let information_error = (result == 0).then(io::Error::last_os_error);
    let close_result = unsafe { CloseHandle(handle) };
    let close_error = (close_result == 0).then(io::Error::last_os_error);
    if let Some(error) = information_error {
        let message = match close_error {
            Some(close) => {
                format!("{error}; additionally failed to close identity handle: {close}")
            }
            None => error.to_string(),
        };
        return Err(NativeTrashError::new("read trash source identity", message));
    }
    if let Some(error) = close_error {
        return Err(NativeTrashError::new("close trash source identity", error));
    }
    validate_windows_handle_attributes(
        information.dwFileAttributes,
        kind,
        FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_DEVICE,
    )?;
    Ok(NativeSourceIdentity::Windows {
        volume: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        kind,
    })
}

#[cfg(windows)]
pub(super) fn validate_windows_handle_attributes(
    attributes: u32,
    kind: TrashEntryKind,
    reparse_flag: u32,
    directory_flag: u32,
    device_flag: u32,
) -> Result<(), NativeTrashError> {
    if attributes & (reparse_flag | device_flag) != 0 {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "reparse points and special device objects cannot be moved to Trash",
        ));
    }
    let is_directory = attributes & directory_flag != 0;
    if is_directory != (kind == TrashEntryKind::Directory) {
        return Err(NativeTrashError::new(
            "validate trash source kind",
            "authoritative file-handle kind does not match the requested kind",
        ));
    }
    Ok(())
}

pub(super) fn validate_source_type(
    metadata: &fs::Metadata,
    kind: TrashEntryKind,
) -> Result<(), NativeTrashError> {
    let file_type = metadata.file_type();
    if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "symbolic links and special files cannot be moved to Trash",
        ));
    }
    if !verify_kind(metadata, kind) {
        return Err(NativeTrashError::new(
            "validate trash source kind",
            "source kind changed before trash operation",
        ));
    }
    Ok(())
}

pub(super) fn verify_receipt_identity(receipt: &NativeTrashReceipt) -> Result<bool, NativeTrashError> {
    let metadata = fs::symlink_metadata(&receipt.destination)
        .map_err(|error| NativeTrashError::new("observe trashed entry identity", error))?;
    drop(metadata);
    Ok(capture_source_identity(&receipt.destination, receipt.kind)? == receipt.source_identity)
}

pub(super) fn ensure_identity_unchanged(
    path: &Path,
    expected: &NativeSourceIdentity,
) -> Result<(), NativeTrashError> {
    if capture_source_identity(path, expected.kind())? == *expected {
        Ok(())
    } else {
        Err(NativeTrashError::new(
            "revalidate trash source identity",
            "source changed between authorization and platform mutation",
        ))
    }
}

pub(super) fn verify_kind(metadata: &fs::Metadata, kind: TrashEntryKind) -> bool {
    match kind {
        TrashEntryKind::File => !metadata.file_type().is_dir(),
        TrashEntryKind::Directory => metadata.file_type().is_dir(),
    }
}

#[cfg(any(windows, test))]
pub(super) fn windows_shell_parsing_name_from_wide(path: &[u16]) -> Result<Vec<u16>, &'static str> {
    // Rust canonicalization returns verbatim names; Shell expects a display name.
    const BACKSLASH: u16 = b'\\' as u16;
    const VERBATIM_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'?' as u16, BACKSLASH];
    const VERBATIM_UNC_PREFIX: [u16; 8] = [
        BACKSLASH,
        BACKSLASH,
        b'?' as u16,
        BACKSLASH,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        BACKSLASH,
    ];
    const DEVICE_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'.' as u16, BACKSLASH];

    if path.starts_with(&VERBATIM_UNC_PREFIX) {
        return Err("Windows UNC paths are not supported for Shell Trash");
    }
    if let Some(rest) = path.strip_prefix(&VERBATIM_PREFIX) {
        let drive_letter = rest.first().copied().is_some_and(|value| {
            (b'A' as u16..=b'Z' as u16).contains(&value)
                || (b'a' as u16..=b'z' as u16).contains(&value)
        });
        if drive_letter && rest.get(1) == Some(&(b':' as u16)) && rest.get(2) == Some(&BACKSLASH) {
            return Ok(rest.to_vec());
        }
        return Err("unsupported Windows verbatim path for Shell parsing");
    }
    if path.starts_with(&DEVICE_PREFIX) {
        return Err("unsupported Windows device path for Shell parsing");
    }
    if path.starts_with(&[BACKSLASH, BACKSLASH]) {
        return Err("Windows UNC paths are not supported for Shell Trash");
    }
    Ok(path.to_vec())
}
