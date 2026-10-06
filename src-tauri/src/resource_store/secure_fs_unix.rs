//! Secure filesystem access on Unix.
use super::*;

use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd},
};

fn c_name(path: &Path) -> io::Result<CString> {
    use std::os::unix::ffi::OsStrExt; // platform-audit: allow (platform-gated secure-fs transport)
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL"))
}

fn component_name(component: Component<'_>) -> io::Result<CString> {
    let Component::Normal(name) = component else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "relative path is invalid",
        ));
    };
    c_name(Path::new(name))
}

pub(super) fn mkdirs_open_final(root: &File, relative: &Path) -> io::Result<File> {
    let mut directory = root.try_clone()?;
    for component in relative.components() {
        let name = component_name(component)?;
        let mkdir_result =
            unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o755) }; // platform-audit: allow (platform-gated secure-fs transport)
        if mkdir_result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        let descriptor = unsafe {
            libc::openat( // platform-audit: allow (platform-gated secure-fs transport)
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC, // platform-audit: allow (platform-gated secure-fs transport)
            )
        };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        let opened = unsafe { File::from_raw_fd(descriptor) };
        if !opened.metadata()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "resource path component is not a directory",
            ));
        }
        directory = opened;
    }
    Ok(directory)
}

pub(super) fn create_new_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = CString::new(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let descriptor = unsafe {
        libc::openat( // platform-audit: allow (platform-gated secure-fs transport)
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, // platform-audit: allow (platform-gated secure-fs transport)
            0o600,
        )
    };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "created resource is not a regular file",
        ));
    }
    Ok(file)
}

pub(super) fn open_existing_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = CString::new(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let descriptor = unsafe {
        libc::openat( // platform-audit: allow (platform-gated secure-fs transport)
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC, // platform-audit: allow (platform-gated secure-fs transport)
        )
    };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "resource is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(target_os = "linux")]
pub(super) fn publish_no_replace(
    directory: &File,
    staged: &str,
    final_name: &str,
) -> io::Result<()> {
    let staged = CString::new(staged)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
    let final_name = CString::new(final_name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let result = unsafe {
        libc::renameat2( // platform-audit: allow (platform-gated secure-fs transport)
            directory.as_raw_fd(),
            staged.as_ptr(),
            directory.as_raw_fd(),
            final_name.as_ptr(),
            libc::RENAME_NOREPLACE, // platform-audit: allow (platform-gated secure-fs transport)
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn publish_no_replace(
    directory: &File,
    staged: &str,
    final_name: &str,
) -> io::Result<()> {
    let source = CString::new(staged)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
    let destination = CString::new(final_name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let result = unsafe {
        libc::renameatx_np( // platform-audit: allow (platform-gated secure-fs transport)
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL, // platform-audit: allow (platform-gated secure-fs transport)
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn publish_replace(
    directory: &File,
    staged: &str,
    final_name: &str,
) -> io::Result<()> {
    let staged = CString::new(staged)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
    let final_name = CString::new(final_name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
    let result = unsafe {
        libc::renameat( // platform-audit: allow (platform-gated secure-fs transport)
            directory.as_raw_fd(),
            staged.as_ptr(),
            directory.as_raw_fd(),
            final_name.as_ptr(),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn unlink_at(directory: &File, name: &str) {
    if let Ok(name) = CString::new(name) {
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0); // platform-audit: allow (platform-gated secure-fs transport)
        }
    }
}

pub(super) fn sync_directory(directory: &File) -> io::Result<()> {
    directory.sync_all()
}
