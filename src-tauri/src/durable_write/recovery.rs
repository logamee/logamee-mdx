//! Recovery image creation after failed installs.
use std::{ fs::{self, File },
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};


use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DirectoryIdentity {
    canonical_path: PathBuf,
    platform_identity: String,
}

pub(crate) fn capture_directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination parent must be a real directory",
        ));
    }
    Ok(DirectoryIdentity {
        canonical_path: fs::canonicalize(path)?,
        platform_identity: path_platform_identity(path)?,
    })
}

pub(crate) fn classify_failed_attempt(
    destination: &Path,
    expected: &ExpectedFileState,
    recovery_paths: Vec<PathBuf>,
    message: &str,
) -> io::Result<DurableWriteOutcome> {
    match capture_file_version(destination) {
        Ok(current_version) if current_version.as_ref() == expected.version() => {
            Ok(DurableWriteOutcome::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
                message: message.to_string(),
            })
        }
        Ok(_) | Err(_) => Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "{message} The destination could not be proven unchanged after the attempt."
            ),
            recovery_paths,
        }),
    }
}

pub(crate) fn existing_recovery_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|path| path.exists()).collect()
}

pub(crate) fn parent_change_indeterminate(
    destination: &Path,
    bytes: &[u8],
    known_paths: Vec<PathBuf>,
    additional_images: Vec<(String, Vec<u8>)>,
    message: &str,
) -> DurableWriteOutcome {
    let mut recovery_paths = existing_recovery_paths(known_paths);
    let message = match create_recovery_in_current_parent(destination, bytes) {
        Ok(path) => {
            if !recovery_paths.contains(&path) {
                recovery_paths.push(path);
            }
            message.to_string()
        }
        Err(error) => match create_fallback_recovery(destination, "intended", bytes) {
            Ok(path) => {
                recovery_paths.push(path);
                format!(
                    "{message} The replacement-tree recovery path failed ({error}); intended bytes were retained in the fallback recovery directory."
                )
            }
            Err(fallback_error) => format!(
                "{message} A recovery image could not be created in the replacement tree ({error}) or fallback directory ({fallback_error})."
            ),
        },
    };
    let mut materialization_errors = Vec::new();
    for (kind, image) in additional_images {
        match create_fallback_recovery(destination, &kind, &image) {
            Ok(path) => recovery_paths.push(path),
            Err(error) => materialization_errors.push(format!("{kind}: {error}")),
        }
    }
    let message = if materialization_errors.is_empty() {
        message
    } else {
        format!(
            "{message} Additional exact recovery images could not be materialized: {}.",
            materialization_errors.join(", ")
        )
    };
    DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths,
    }
}

pub(crate) fn creation_indeterminate(
    message: &str,
    intended_recovery: PathBuf,
    staged_alias: Option<PathBuf>,
) -> DurableWriteOutcome {
    let message = match staged_alias {
        Some(staged_alias) => match fs::remove_file(&staged_alias) {
            Ok(()) => message.to_string(),
            Err(error) => format!(
                "{message} The non-independent staging alias at {} could not be retired: {error}",
                staged_alias.display()
            ),
        },
        None => message.to_string(),
    };
    DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths: existing_recovery_paths(vec![intended_recovery]),
    }
}

pub(crate) fn open_file_matches_bytes(file: &mut File, expected: &[u8]) -> io::Result<bool> {
    file.seek(SeekFrom::Start(0))?;
    let mut observed = Vec::new();
    file.read_to_end(&mut observed)?;
    Ok(observed == expected)
}

pub(crate) fn create_recovery_in_current_parent(destination: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    let parent = fs::canonicalize(parent)?;
    create_recovery_image(
        &parent.join(destination.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
        })?),
        bytes,
    )
}

pub(crate) fn create_fallback_recovery(destination: &Path, kind: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let file_name = destination
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("mmd-data"));
    let anchor = std::env::temp_dir().join(file_name);
    create_synced_image(&anchor, kind, bytes)
}

pub(crate) fn create_recovery_image(destination: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    create_synced_image(destination, "recovery", bytes)
}

pub(crate) fn create_synced_image(destination: &Path, kind: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let (path, mut file) = create_named_temp(destination, kind)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    sync_parent_directory_if_required(path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "recovery path has no parent")
    })?)?;
    Ok(path)
}
