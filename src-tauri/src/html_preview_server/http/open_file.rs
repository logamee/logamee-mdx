//! Platform-aware opening of authorized preview files, with the opened
//! path resolved through the real file identity (symlink-safe).
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

use crate::path_auth::{normalize_existing_path, path_is_under};

#[cfg(target_os = "macos")]
pub(crate) fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::{
        ffi::CStr,
        os::{fd::AsRawFd, unix::ffi::OsStringExt},
    };

    const F_GETPATH: std::ffi::c_int = 50;
    const PATH_BUFFER_SIZE: usize = 4096;

    unsafe extern "C" {
        fn fcntl(fd: std::ffi::c_int, command: std::ffi::c_int, ...) -> std::ffi::c_int;
    }

    let mut path = [0_u8; PATH_BUFFER_SIZE];
    if unsafe { fcntl(file.as_raw_fd(), F_GETPATH, path.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let path = CStr::from_bytes_until_nul(&path)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "opened path is not terminated"))?;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(
        path.to_bytes().to_vec(),
    )))
}

#[cfg(target_os = "linux")]
pub(crate) fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;

    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(windows)]
pub(crate) fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
        ptr::null_mut,
    };
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 {
        return Err(io::Error::last_os_error());
    }
    if written as usize >= buffer.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened path changed while it was queried",
        ));
    }
    buffer.truncate(written as usize);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn opened_file_path(_file: &File) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opened-file path verification is unavailable on this platform",
    ))
}

pub(crate) fn open_authorized_file_with(
    requested: &Path,
    root: &Path,
    after_open: impl FnOnce(),
    after_opened_path: impl FnOnce(),
) -> io::Result<(File, std::fs::Metadata, PathBuf)> {
    let file = File::open(requested)?;
    after_open();
    let opened_path = opened_file_path(&file)?;
    after_opened_path();
    let canonical = normalize_existing_path(&opened_path)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
    let retained_path = opened_file_path(&file)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || retained_path != canonical || !path_is_under(&canonical, root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "opened preview file escaped its authorized root",
        ));
    }
    Ok((file, metadata, canonical))
}

pub(crate) fn open_authorized_file(
    requested: &Path,
    root: &Path,
) -> io::Result<(File, std::fs::Metadata, PathBuf)> {
    open_authorized_file_with(requested, root, || {}, || {})
}
