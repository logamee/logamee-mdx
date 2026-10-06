//! Staging pipeline for workspace copies: materialize into a private
//! directory, then install with a no-replace rename.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use super::{CopyEntryError, MAX_COPY_ENTRIES};

const MAX_COPY_DEPTH: usize = 64;
const STAGING_ATTEMPTS: usize = 32;

pub(super) fn allocate_staging_path(target: &Path) -> Result<PathBuf, CopyEntryError> {
    let parent = target
        .parent()
        .ok_or_else(|| CopyEntryError::NotCommitted("Copy destination has no parent".into()))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("entry");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage a copy: {error}")))?;
        let suffix = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let candidate = parent.join(format!(".{name}.copy-{suffix}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(CopyEntryError::NotCommitted(format!(
                    "Cannot prepare a copy destination: {error}"
                )))
            }
        }
    }
    Err(CopyEntryError::NotCommitted(
        "Could not allocate a unique staging path for the copy".into(),
    ))
}

pub(super) fn stage_file(source: &Path, staged_path: &Path) -> Result<(), CopyEntryError> {
    // Classify through symlink metadata before any open: special objects such
    // as FIFOs would block a plain open for read until a writer appears.
    let classified = fs::symlink_metadata(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
    if classified.file_type().is_symlink() || !classified.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    let mut input = fs::File::open(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
    let metadata = input
        .metadata()
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot inspect the copy source: {error}")))?;
    if !metadata.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    let mut output = fs::File::create(staged_path)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
    stream_copy(&mut input, &mut output)?;
    output
        .sync_all()
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot persist the staged copy: {error}")))?;
    Ok(())
}

pub(super) fn stage_tree(
    source: &Path,
    staged_path: &Path,
    depth: usize,
    budget: &mut usize,
) -> Result<(), CopyEntryError> {
    if depth > MAX_COPY_DEPTH {
        return Err(CopyEntryError::NotCommitted(format!(
            "The directory tree exceeds the copy depth limit of {MAX_COPY_DEPTH}"
        )));
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| {
            CopyEntryError::NotCommitted(format!(
                "The directory tree exceeds the copy entry limit of {MAX_COPY_ENTRIES}"
            ))
        })?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot inspect the copy source: {error}")))?;
    if metadata.file_type().is_symlink() {
        return Err(CopyEntryError::NotCommitted(
            "Symbolic links cannot be copied as workspace entries".into(),
        ));
    }
    if metadata.file_type().is_dir() {
        fs::create_dir(staged_path)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
        let children = fs::read_dir(source)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
        for child in children {
            let child = child
                .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
            let child_name = child
                .file_name()
                .into_string()
                .map_err(|_| CopyEntryError::NotCommitted("Copy source names must be valid Unicode".into()))?;
            stage_tree(&child.path(), &staged_path.join(child_name), depth + 1, budget)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    stage_file(source, staged_path)
}

fn stream_copy(input: &mut impl Read, output: &mut impl Write) -> Result<(), CopyEntryError> {
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
    }
}

pub(super) fn install_staged(staged_root: &Path, target: &Path) -> Result<(), CopyEntryError> {
    install_no_replace(staged_root, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CopyEntryError::NotCommitted("Workspace entry already exists".into())
        } else {
            CopyEntryError::NotCommitted(format!("Cannot install the copy: {error}"))
        }
    })
}

#[cfg(target_os = "linux")]
pub(super) fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(super) fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let result = unsafe { MoveFileExW(wide(source).as_ptr(), wide(target).as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn install_no_replace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no audited no-replace rename primitive",
    ))
}

#[cfg(unix)]
pub(super) fn sync_parent_directory(target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Copy destination has no parent".to_string())?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
pub(super) fn sync_parent_directory(_target: &Path) -> Result<(), String> {
    // Win32 exposes no supported parent-directory fsync contract; the staged
    // install itself is the durability step the platform can provide.
    Ok(())
}
