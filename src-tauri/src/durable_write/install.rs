//! Install and permission transfer.
#[allow(unused_imports)]
use std::{
    fs::{self, File, OpenOptions},
    io::{self},
    path::{Path, PathBuf},
    sync::{Mutex}};


use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NewInstallDisposition {
    StagingAlias,
    #[cfg(windows)]
    StagingMoved,
}

#[cfg(windows)]
pub(crate) fn install_expected_absent(staged: &Path, destination: &Path) -> io::Result<NewInstallDisposition> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let staged_wide = wide(staged);
    let destination_wide = wide(destination);
    // Both paths are in the same canonical parent. Without MOVEFILE_REPLACE_EXISTING,
    // MoveFileExW is a no-overwrite publication of the already flushed complete stage.
    // Win32 has no supported parent namespace fsync, so no such crash guarantee is claimed.
    let result = unsafe { MoveFileExW(staged_wide.as_ptr(), destination_wide.as_ptr(), 0) };
    if result != 0 {
        Ok(NewInstallDisposition::StagingMoved)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
pub(crate) fn install_expected_absent(staged: &Path, destination: &Path) -> io::Result<NewInstallDisposition> {
    fs::hard_link(staged, destination)?;
    Ok(NewInstallDisposition::StagingAlias)
}

pub(crate) fn copy_destination_permissions(
    destination: &Path,
    staged_path: &Path,
    expected: &ExpectedFileState,
) -> io::Result<()> {
    if matches!(expected, ExpectedFileState::Absent) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    fs::set_permissions(staged_path, metadata.permissions())
}

pub(crate) fn create_named_temp(destination: &Path, kind: &str) -> io::Result<(PathBuf, File)> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mmd-data");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let staged_path = destination.with_file_name(format!(".{file_name}.{kind}-{suffix}"));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&staged_path) {
            Ok(file) => return Ok((staged_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique staging file",
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn atomic_displaced_path(staged: &Path) -> PathBuf {
    staged.to_path_buf()
}

#[cfg(windows)]
pub(crate) fn atomic_displaced_path(staged: &Path) -> PathBuf {
    collision_safe_displaced_path(staged)
}

#[cfg(any(windows, test))]
pub(crate) fn collision_safe_displaced_path(staged: &Path) -> PathBuf {
    let name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mmd-staged");
    staged.with_file_name(format!("{name}.displaced"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn atomic_displaced_path(staged: &Path) -> PathBuf {
    staged.to_path_buf()
}

#[cfg(target_os = "linux")]
pub(crate) fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let staged_c = CString::new(staged.as_os_str().as_bytes())?;
    let destination_c = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            staged_c.as_ptr(),
            libc::AT_FDCWD,
            destination_c.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result == 0 {
        Ok(staged.to_path_buf())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let staged_c = CString::new(staged.as_os_str().as_bytes())?;
    let destination_c = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(staged_c.as_ptr(), destination_c.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(staged.to_path_buf())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let backup = atomic_displaced_path(staged);
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let staged_wide = wide(staged);
    let backup_wide = wide(&backup);
    let result = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staged_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result != 0 {
        Ok(backup)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn atomic_replace_with_backup(_staged: &Path, _destination: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "this platform has no audited atomic replace-with-backup primitive",
    ))
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(unix)]
pub(crate) fn parent_directory_sync_required() -> bool {
    true
}

#[cfg(not(unix))]
pub(crate) fn parent_directory_sync_required() -> bool {
    // Win32 exposes no supported parent-directory fsync contract. The platform contract
    // therefore requires file-handle flush and post-mutation observation, but does not
    // fabricate a directory durability step that the OS cannot provide.
    false
}

pub(crate) fn sync_parent_directory_if_required(parent: &Path) -> io::Result<()> {
    if parent_directory_sync_required() {
        #[cfg(unix)]
        return sync_parent_directory(parent);
    }
    let _ = parent;
    Ok(())
}
