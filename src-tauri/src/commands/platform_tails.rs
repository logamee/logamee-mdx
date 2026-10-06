//! Platform fallbacks for file identity and the FileSystemPort contract.
use std::{fs, io, path::Path};

use super::ObservedPath;
#[cfg(windows)]
use super::windows_handle_files;
use super::workspace_mutation::observe::observe_path;

#[cfg(windows)]
pub(crate) fn write_file_without_following_links(path: &Path, bytes: &[u8]) -> io::Result<()> {
    windows_handle_files::write(path, bytes)
}

#[cfg(windows)]
pub(crate) fn open_regular_file_without_following_links(path: &Path) -> io::Result<fs::File> {
    windows_handle_files::open_read(path)
}

#[cfg(windows)]
pub(crate) fn open_regular_file_beneath_directory(
    root: &fs::File,
    relative: &Path,
) -> io::Result<fs::File> {
    windows_handle_files::open_read_beneath(root, relative)
}

#[cfg(windows)]
pub(crate) fn open_directory_without_following_links(path: &Path) -> io::Result<fs::File> {
    windows_handle_files::nt::open_directory(path)
}

#[cfg(unix)]
pub(crate) fn opened_file_platform_identity(file: &fs::File) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
pub(crate) fn opened_file_platform_identity(file: &fs::File) -> io::Result<String> {
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

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn write_file_without_following_links(_path: &Path, _bytes: &[u8]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "nofollow handle-based writes are unavailable on this platform",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn open_regular_file_without_following_links(_path: &Path) -> io::Result<fs::File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "nofollow handle-based reads are unavailable on this platform",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn open_regular_file_beneath_directory(
    _root: &fs::File,
    _relative: &Path,
) -> io::Result<fs::File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "root-bound nofollow reads are unavailable on this platform",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn open_directory_without_following_links(_path: &Path) -> io::Result<fs::File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "nofollow directory handles are unavailable on this platform",
    ))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn opened_file_platform_identity(_file: &fs::File) -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem identity is unavailable on this platform",
    ))
}

pub(crate) trait FileSystemPort {
    fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()>;
    fn create_new(&self, path: &Path) -> std::io::Result<()>;
    fn create_new_with_contents(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        self.create_new(path)?;
        self.write(path, bytes)
    }
    fn create_dir(&self, path: &Path) -> std::io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    #[cfg(test)]
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
    #[cfg(test)]
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()>;

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        observe_path(path, expected_bytes)
    }
}
