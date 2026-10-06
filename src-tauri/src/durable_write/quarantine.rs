//! Quarantine and atomic no-replace move primitives.
#[allow(unused_imports)]
use std::{ fs::{self },
    io::{self},
    path::{Path, PathBuf},
    sync::{Mutex}};


use super::*;

#[cfg(unix)]
pub(crate) fn delete_quarantine_exact(path: &Path, expected: &FileVersion) -> io::Result<bool> {
    let Some(file) = verified_open_file(path, expected)? else {
        return Ok(false);
    };
    let handle_identity = file_platform_identity(&file)?;
    let path_metadata = fs::symlink_metadata(path)?;
    if path_metadata.file_type().is_symlink() || path_platform_identity(path)? != handle_identity {
        return Ok(false);
    }
    // POSIX has no unlink-by-handle operation. This final name removal is therefore
    // guaranteed only against cooperating mdx instances, which share DURABLE_WRITE_LOCK
    // and the crash-store filesystem lock. Any namespace change observed before this
    // point fails closed and leaves the random private quarantine as recovery evidence.
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(windows)]
pub(crate) fn delete_quarantine_exact(path: &Path, expected: &FileVersion) -> io::Result<bool> {
    use std::{
        mem,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FileDispositionInfoEx, SetFileInformationByHandle, FILE_ATTRIBUTE_NORMAL,
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };
    const DELETE_ACCESS: u32 = 0x0001_0000;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | DELETE_ACCESS,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_handle(handle.cast()) };
    if !file_matches_version(&mut file, expected)? {
        return Ok(false);
    }
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileDispositionInfoEx,
            (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(true)
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn delete_quarantine_exact(_path: &Path, _expected: &FileVersion) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no exact quarantine delete primitive",
    ))
}

pub(crate) fn collision_safe_quarantine_path(destination: &Path) -> io::Result<PathBuf> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("draft");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = destination.with_file_name(format!(".{file_name}.delete-{suffix}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate quarantine path",
    ))
}

#[cfg(target_os = "linux")]
pub(crate) fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let result = unsafe { MoveFileExW(wide(source).as_ptr(), wide(destination).as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn atomic_move_no_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no audited quarantine primitive",
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DurableWriteOutcome {
    ConfirmedCommitted {
        version: FileVersion,
        displaced_path: Option<PathBuf>,
    },
    ConfirmedNotCommitted {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
        message: String,
    },
    Conflict {
        current_version: Option<FileVersion>,
        recovery_path: PathBuf,
    },
    Indeterminate {
        message: String,
        recovery_paths: Vec<PathBuf>,
    },
}

pub(crate) fn capture_file_version(path: &Path) -> io::Result<Option<FileVersion>> {
    observe_open_file(path, None).map(|observed| observed.map(|observed| observed.version))
}

pub(crate) fn capture_committed_file_version(path: &Path) -> io::Result<Option<FileVersion>> {
    observe_open_file_with_binding(path, None)
        .map(|observed| observed.map(|observed| observed.version))
}
