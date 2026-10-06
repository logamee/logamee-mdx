//! Trash-info writing, root selection and durable commit helpers.
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
use percent_encoding::{percent_encode, AsciiSet, CONTROLS};

const TRASH_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

use super::*;

pub(super) fn trash_info_contents(source: &Path) -> Result<Vec<u8>, NativeTrashError> {
    let encoded = percent_encode(source.as_os_str().as_bytes(), TRASH_PATH_ENCODE_SET);
    let deletion_date = deletion_date()?;
    Ok(format!("[Trash Info]\nPath={encoded}\nDeletionDate={deletion_date}\n").into_bytes())
}

fn deletion_date() -> Result<String, NativeTrashError> {
    let timestamp = unsafe { libc::time(std::ptr::null_mut()) }; // platform-audit: allow (linux-only trash transport)
    let mut local = unsafe { std::mem::zeroed::<libc::tm>() }; // platform-audit: allow (linux-only trash transport)
    if unsafe { libc::localtime_r(&timestamp, &mut local) }.is_null() { // platform-audit: allow (linux-only trash transport)
        return Err(NativeTrashError::new(
            "create trash deletion timestamp",
            io::Error::last_os_error(),
        ));
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        local.tm_year + 1900,
        local.tm_mon + 1,
        local.tm_mday,
        local.tm_hour,
        local.tm_min,
        local.tm_sec
    ))
}

pub(super) fn mount_root(start: &Path, device: u64) -> io::Result<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let Some(parent) = current.parent() else {
            return Ok(current);
        };
        if fs::metadata(parent)?.dev() != device {
            return Ok(current);
        }
        current = parent.to_path_buf();
    }
}

pub(super) fn select_trash_root(
    mount_root: &Path,
    source_device: u64,
) -> Result<(PathBuf, bool), NativeTrashError> {
    if let Some(data_home) = xdg_data_home() {
        let home_trash = data_home.join("Trash");
        if nearest_existing_device(&home_trash) == Some(source_device) {
            return Ok((home_trash, true));
        }
    }

    let uid = unsafe { libc::geteuid() }; // platform-audit: allow (linux-only trash transport)
    let shared = mount_root.join(".Trash");
    if let Ok(metadata) = fs::symlink_metadata(&shared) {
        let mode = metadata.permissions().mode();
        if metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.dev() == source_device
            && mode & libc::S_ISVTX != 0 // platform-audit: allow (linux-only trash transport)
        {
            return Ok((shared.join(uid.to_string()), false));
        }
    }
    Ok((mount_root.join(format!(".Trash-{uid}")), false))
}

fn xdg_data_home() -> Option<PathBuf> {
    match env::var_os("XDG_DATA_HOME") {
        Some(path) if Path::new(&path).is_absolute() => Some(path.into()),
        _ => env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")),
    }
}

fn nearest_existing_device(path: &Path) -> Option<u64> {
    path.ancestors()
        .find_map(|candidate| fs::metadata(candidate).ok().map(|metadata| metadata.dev()))
}

pub(super) fn create_private_directory(path: &Path) -> Result<(), NativeTrashError> {
    fs::create_dir_all(path)
        .map_err(|error| NativeTrashError::new("create trash directory", error))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash directory", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(NativeTrashError::new(
            "validate trash directory",
            "trash directory is not a real directory",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| NativeTrashError::new("secure trash directory", error))
}

pub(super) fn ensure_same_device(path: &Path, expected_device: u64) -> Result<(), NativeTrashError> {
    let actual = fs::metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash filesystem", error))?
        .dev();
    if actual == expected_device {
        Ok(())
    } else {
        Err(NativeTrashError::new(
            "validate trash filesystem",
            "trash directory is on a different filesystem; copy/delete fallback is forbidden",
        ))
    }
}

pub(super) fn reserve_unique_entry(
    files_dir: &Path,
    info_dir: &Path,
    base_name: &OsStr,
) -> Result<(PathBuf, PathBuf, File), NativeTrashError> {
    for suffix in 0_u32..10_000 {
        let candidate = unique_name(base_name, suffix);
        let destination = files_dir.join(&candidate);
        if fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        let mut info_name = candidate;
        info_name.push(".trashinfo");
        let info_path = info_dir.join(info_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&info_path)
        {
            Ok(file) => return Ok((destination, info_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(NativeTrashError::new(
                    "reserve trash recovery metadata",
                    error,
                ))
            }
        }
    }
    Err(NativeTrashError::new(
        "name trash entry",
        "could not allocate a unique trash name",
    ))
}

pub(super) fn unique_name(base_name: &OsStr, suffix: u32) -> std::ffi::OsString {
    let mut name = base_name.to_os_string();
    if suffix != 0 {
        name.push(format!(".{suffix}"));
    }
    name
}

pub(super) fn write_and_sync(file: &mut File, contents: &[u8]) -> io::Result<()> {
    file.write_all(contents)?;
    file.sync_all()
}

pub(super) fn error_with_reserved_info_cleanup(
    operation: &'static str,
    primary: io::Error,
    info_path: &Path,
) -> NativeTrashError {
    let message = match fs::remove_file(info_path) {
        Ok(()) => primary.to_string(),
        Err(cleanup) => format!(
            "{primary}; additionally failed to remove reserved recovery metadata {}: {cleanup}",
            info_path.display()
        ),
    };
    NativeTrashError::new(operation, message)
}

pub(super) fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in source path"))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in trash path"))?;
    let result = unsafe {
        libc::syscall( // platform-audit: allow (linux-only trash transport)
            libc::SYS_renameat2, // platform-audit: allow (linux-only trash transport)
            libc::AT_FDCWD, // platform-audit: allow (linux-only trash transport)
            source.as_ptr(),
            libc::AT_FDCWD, // platform-audit: allow (linux-only trash transport)
            destination.as_ptr(),
            libc::RENAME_NOREPLACE, // platform-audit: allow (linux-only trash transport)
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn sync_commit_directories(files_dir: &Path, info_dir: &Path) -> io::Result<()> {
    File::open(files_dir)?.sync_all()?;
    File::open(info_dir)?.sync_all()
}
