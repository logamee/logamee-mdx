//! Exact-path durable removal with quarantine.
#[allow(unused_imports)]
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use crate::private_fs::lowercase_hex;

use sha2::{Digest, Sha256};

use super::*;

pub(crate) fn durable_remove_exact(
    destination: &Path,
    expected: &FileVersion,
) -> DurableDeleteOutcome {
    durable_remove_exact_with_hooks(destination, expected, || {}, |_| {})
}

#[cfg(test)]
pub(crate) fn durable_remove_exact_with_hook(
    destination: &Path,
    expected: &FileVersion,
    at_mutation_boundary: impl FnOnce(),
) -> DurableDeleteOutcome {
    durable_remove_exact_with_hooks(destination, expected, at_mutation_boundary, |_| {})
}

pub(crate) fn durable_remove_exact_with_hooks(
    destination: &Path,
    expected: &FileVersion,
    at_mutation_boundary: impl FnOnce(),
    before_final_unlink: impl FnOnce(&Path),
) -> DurableDeleteOutcome {
    let _guard = match DURABLE_WRITE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            }
        }
    };
    if let Err(outcome) = capture_deletable_version(destination, expected) {
        return outcome;
    }
    let quarantine = match collision_safe_quarantine_path(destination) {
        Ok(path) => path,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            }
        }
    };
    at_mutation_boundary();
    if atomic_move_no_replace(destination, &quarantine).is_err() {
        return classify_failed_quarantine_move(destination, expected);
    }
    let Some(parent) = destination.parent() else {
        return DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        };
    };
    if sync_parent_directory_if_required(parent).is_err() {
        return DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        };
    }
    let quarantined = match capture_file_version(&quarantine) {
        Ok(version) => version,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: vec![quarantine],
            }
        }
    };
    if !quarantined
        .as_ref()
        .is_some_and(|version| version.is_displaced_version_of(expected))
    {
        return rollback_mismatched_quarantine(destination, parent, quarantine);
    }
    delete_quarantined_and_sync(destination, parent, quarantine, expected, before_final_unlink)
}

fn capture_deletable_version(
    destination: &Path,
    expected: &FileVersion,
) -> Result<(), DurableDeleteOutcome> {
    let current = match capture_file_version(destination) {
        Ok(current) => current,
        Err(_) => {
            return Err(DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            })
        }
    };
    let Some(current) = current else {
        return Err(DurableDeleteOutcome::ConfirmedNotDeleted {
            current_version: None,
            recovery_paths: Vec::new(),
        });
    };
    if current != *expected {
        return Err(DurableDeleteOutcome::Conflict {
            current_version: Some(current),
            recovery_paths: Vec::new(),
        });
    }
    Ok(())
}

fn classify_failed_quarantine_move(
    destination: &Path,
    expected: &FileVersion,
) -> DurableDeleteOutcome {
    match capture_file_version(destination) {
        Ok(current_version) if current_version.as_ref() != Some(expected) => {
            DurableDeleteOutcome::Conflict {
                current_version,
                recovery_paths: Vec::new(),
            }
        }
        Ok(current_version) => DurableDeleteOutcome::ConfirmedNotDeleted {
            current_version,
            recovery_paths: Vec::new(),
        },
        Err(_) => DurableDeleteOutcome::Indeterminate {
            recovery_paths: Vec::new(),
        },
    }
}

fn rollback_mismatched_quarantine(
    destination: &Path,
    parent: &Path,
    quarantine: PathBuf,
) -> DurableDeleteOutcome {
    let current_version = capture_file_version(destination).ok().flatten();
    if current_version.is_none() && atomic_move_no_replace(&quarantine, destination).is_ok() {
        if sync_parent_directory_if_required(parent).is_err() {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: vec![quarantine],
            };
        }
        return DurableDeleteOutcome::Conflict {
            current_version: capture_file_version(destination).ok().flatten(),
            recovery_paths: Vec::new(),
        };
    }
    DurableDeleteOutcome::Conflict {
        current_version,
        recovery_paths: vec![quarantine],
    }
}

fn delete_quarantined_and_sync(
    destination: &Path,
    parent: &Path,
    quarantine: PathBuf,
    expected: &FileVersion,
    before_final_unlink: impl FnOnce(&Path),
) -> DurableDeleteOutcome {
    before_final_unlink(&quarantine);
    match delete_quarantine_exact(&quarantine, expected) {
        Ok(true) => {}
        Ok(false) => {
            return DurableDeleteOutcome::Conflict {
                current_version: capture_file_version(destination).ok().flatten(),
                recovery_paths: vec![quarantine],
            }
        }
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: vec![quarantine],
            }
        }
    }
    match sync_parent_directory_if_required(parent) {
        Ok(()) => DurableDeleteOutcome::ConfirmedDeleted,
        Err(_) => DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        },
    }
}

#[cfg(unix)]
pub(crate) fn verified_open_file(path: &Path, expected: &FileVersion) -> io::Result<Option<File>> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    Ok(file_matches_version(&mut file, expected)?.then_some(file))
}

pub(crate) fn file_matches_version(file: &mut File, expected: &FileVersion) -> io::Result<bool> {
    let metadata = file.metadata()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    file.seek(SeekFrom::Start(0))?;
    let matches = file_platform_identity(file)? == expected.platform_identity
        && metadata.len() == expected.length
        && modified_nanos == expected.modified_nanos
        && lowercase_hex(&Sha256::digest(&bytes)) == expected.sha256;
    Ok(matches)
}
