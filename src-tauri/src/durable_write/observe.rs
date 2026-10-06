//! Versioned observation of open files.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use crate::private_fs::lowercase_hex;

use sha2::{Digest, Sha256};

use super::*;


pub(crate) fn observe_versioned_file(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<VersionedFileBytes>> {
    let first = match capture_file_version(path)? {
        Some(version) => version,
        None => return Ok(None),
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "file disappeared during bounded observation",
            ));
        }
        Err(error) => return Err(error),
    };
    let sentinel_limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(sentinel_limit)
        .read_to_end(&mut bytes)?;
    let second = capture_file_version(path)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "file disappeared during bounded observation",
        )
    })?;
    if first != second {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed during bounded observation",
        ));
    }
    Ok(Some(VersionedFileBytes {
        bytes,
        version: second,
    }))
}

pub(crate) fn read_versioned_file_with_hook(
    path: &Path,
    max_bytes: usize,
    between_observations: impl FnOnce(),
) -> io::Result<Option<VersionedFileBytes>> {
    let first = match observe_open_file(path, Some(max_bytes))? {
        Some(observed) => observed,
        None => return Ok(None),
    };
    between_observations();
    let second = observe_open_file(path, Some(max_bytes))?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "file disappeared during stable observation",
        )
    })?;
    if first.version != second.version || first.bytes != second.bytes {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed during stable observation",
        ));
    }
    Ok(Some(second))
}

pub(crate) fn observe_open_file(
    path: &Path,
    max_bytes: Option<usize>,
) -> io::Result<Option<VersionedFileBytes>> {
    observe_open_file_inner(path, max_bytes, false)
}

pub(crate) fn observe_open_file_with_binding(
    path: &Path,
    max_bytes: Option<usize>,
) -> io::Result<Option<VersionedFileBytes>> {
    observe_open_file_inner(path, max_bytes, true)
}

pub(crate) fn observe_open_file_inner(
    path: &Path,
    max_bytes: Option<usize>,
    retain_file_binding: bool,
) -> io::Result<Option<VersionedFileBytes>> {
    let Some((mut file, metadata, observed_identity)) = open_verified_observation_file(path)?
    else {
        return Ok(None);
    };

    let canonical_path = fs::canonicalize(path)?.to_string_lossy().into_owned();
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let bytes = read_and_verify_observation(&mut file, path, &observed_identity, &metadata, max_bytes)?;

    Ok(Some(VersionedFileBytes {
        version: FileVersion {
            canonical_path,
            platform_identity: observed_identity,
            length: metadata.len(),
            modified_nanos,
            sha256: lowercase_hex(&Sha256::digest(&bytes)),
            file_binding: retain_file_binding.then(|| Arc::new(file)),
        },
        bytes,
    }))
}

fn open_verified_observation_file(path: &Path) -> io::Result<Option<(File, fs::Metadata, String)>> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !path_metadata.file_type().is_file() || path_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    let file = match open_observation_file(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    let observed_identity = file_platform_identity(&file)?;
    if path_platform_identity(path)? != observed_identity {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file identity changed while it was being opened",
        ));
    }
    Ok(Some((file, metadata, observed_identity)))
}

fn read_and_verify_observation(
    file: &mut File,
    path: &Path,
    observed_identity: &str,
    metadata: &fs::Metadata,
    max_bytes: Option<usize>,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    match max_bytes {
        Some(max_bytes) => {
            let sentinel_limit = u64::try_from(max_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1);
            Read::by_ref(file)
                .take(sentinel_limit)
                .read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::FileTooLarge,
                    "file exceeds the bounded read limit",
                ));
            }
        }
        None => {
            file.read_to_end(&mut bytes)?;
        }
    }
    let metadata_after = file.metadata()?;
    let path_metadata_after = fs::symlink_metadata(path)?;
    if file_platform_identity(file)? != observed_identity
        || path_metadata_after.file_type().is_symlink()
        || path_platform_identity(path)? != observed_identity
        || metadata.len() != metadata_after.len()
        || metadata.modified().ok() != metadata_after.modified().ok()
        || metadata.len() != bytes.len() as u64
    {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed while it was being read",
        ));
    }
    Ok(bytes)
}

#[cfg(windows)]
pub(crate) fn open_observation_file(path: &Path) -> io::Result<File> {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(not(windows))]
pub(crate) fn open_observation_file(path: &Path) -> io::Result<File> {
    File::open(path)
}

#[cfg(unix)]
pub(crate) fn file_platform_identity(file: &File) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
pub(crate) fn file_platform_identity(file: &File) -> io::Result<String> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let result = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok(format!("{}:{file_index}", information.dwVolumeSerialNumber))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn file_platform_identity(_file: &File) -> io::Result<String> {
    Ok("unavailable".to_string())
}

#[cfg(windows)]
pub(crate) fn path_platform_identity(path: &Path) -> io::Result<String> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    file_platform_identity(&file)
}

#[cfg(not(windows))]
pub(crate) fn path_platform_identity(path: &Path) -> io::Result<String> {
    file_platform_identity(&File::open(path)?)
}
