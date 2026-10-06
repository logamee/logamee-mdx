//! Unix openat-style operations that refuse to follow final-component symlinks.
#![allow(dead_code)]
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

#[cfg(target_os = "macos")]
use std::{ffi::CStr, os::unix::ffi::OsStringExt};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    ffi::CString,
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    path::PathBuf,
};

#[cfg(target_os = "macos")]
pub(crate) fn opened_directory_path(directory: &File) -> io::Result<PathBuf> {
    const F_GETPATH: std::ffi::c_int = 50;
    const PATH_BUFFER_SIZE: usize = 4096;

    unsafe extern "C" {
        fn fcntl(fd: std::ffi::c_int, command: std::ffi::c_int, ...) -> std::ffi::c_int;
    }

    let mut path = [0_u8; PATH_BUFFER_SIZE];
    if unsafe { fcntl(directory.as_raw_fd(), F_GETPATH, path.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let path = CStr::from_bytes_until_nul(&path)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "opened path is not terminated"))?;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(
        path.to_bytes().to_vec(),
    )))
}

#[cfg(target_os = "linux")]
pub(crate) fn opened_directory_path(directory: &File) -> io::Result<PathBuf> {
    fs::read_link(format!("/proc/self/fd/{}", directory.as_raw_fd()))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn open_verified_parent(parent: &Path) -> io::Result<File> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)?;
    if !directory.metadata()?.is_dir() || opened_directory_path(&directory)? != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "parent directory changed after authorization",
        ));
    }
    Ok(directory)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn open_directory_without_following_links(path: &Path) -> io::Result<File> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root is not a directory",
        ));
    }
    Ok(directory)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn open_regular_file_without_following_links(path: &Path) -> io::Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let directory = open_verified_parent(parent)?;
    let file_name = CString::new(file_name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "read source is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn open_regular_file_beneath_directory(
    root: &File,
    relative: &Path,
) -> io::Result<File> {
    let mut components = relative.components().peekable();
    let mut directory = root.try_clone()?;
    while let Some(component) = components.next() {
        let std::path::Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace-relative path is invalid",
            ));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL")
        })?;
        let is_file = components.peek().is_none();
        let flags = if is_file {
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
        };
        let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        let opened = unsafe { File::from_raw_fd(descriptor) };
        if is_file {
            if !opened.metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "read source is not a regular file",
                ));
            }
            return Ok(opened);
        }
        if !opened.metadata()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace path component is not a directory",
            ));
        }
        directory = opened;
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "workspace-relative path is empty",
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn write_file_without_following_links(path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: std::ffi::c_int = 0x0000_0100;
    #[cfg(target_os = "macos")]
    const O_CLOEXEC: std::ffi::c_int = 0x0100_0000;
    #[cfg(target_os = "linux")]
    const O_NOFOLLOW: std::ffi::c_int = 0x0002_0000;
    #[cfg(target_os = "linux")]
    const O_CLOEXEC: std::ffi::c_int = 0x0008_0000;
    const O_WRONLY: std::ffi::c_int = 0x0000_0001;

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let directory = open_verified_parent(parent)?;
    let file_name = CString::new(file_name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let existing_flags = O_WRONLY | O_NOFOLLOW | O_CLOEXEC;
    let (descriptor, created) = open_or_create_file_descriptor(
        &directory,
        &file_name,
        existing_flags,
        existing_flags | create_exclusive_flags(),
    )?;
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "write destination is not a regular file",
        ));
    }
    if !created {
        file.set_len(0)?;
    }
    file.write_all(bytes)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn create_exclusive_flags() -> std::ffi::c_int {
    #[cfg(target_os = "macos")]
    const O_CREAT: std::ffi::c_int = 0x0000_0200;
    #[cfg(target_os = "macos")]
    const O_EXCL: std::ffi::c_int = 0x0000_0800;
    #[cfg(target_os = "linux")]
    const O_CREAT: std::ffi::c_int = 0x0000_0040;
    #[cfg(target_os = "linux")]
    const O_EXCL: std::ffi::c_int = 0x0000_0080;

    O_CREAT | O_EXCL
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_or_create_file_descriptor(
    directory: &File,
    file_name: &CString,
    existing_flags: std::ffi::c_int,
    create_flags: std::ffi::c_int,
) -> io::Result<(std::ffi::c_int, bool)> {
    unsafe extern "C" {
        fn openat(
            directory: std::ffi::c_int,
            path: *const std::ffi::c_char,
            flags: std::ffi::c_int,
            ...
        ) -> std::ffi::c_int;
    }

    let mut created = false;
    let mut descriptor =
        unsafe { openat(directory.as_raw_fd(), file_name.as_ptr(), existing_flags) };
    if descriptor == -1 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        descriptor = unsafe {
            openat(
                directory.as_raw_fd(),
                file_name.as_ptr(),
                create_flags,
                0o666_u32,
            )
        };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        created = true;
    }
    Ok((descriptor, created))
}
