//! Commit-phase observation and settlement helpers for the replace phase of
//! the durable write pipeline.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self},
    path::{Path, PathBuf},
    sync::{Mutex}};

use super::outcomes::replacement_indeterminate;
use crate::durable_write::*;

pub(super) fn observe_replacement(
    destination: &Path,
    displaced_path: &Path,
    expected: &ExpectedFileState,
    staged_version: &FileVersion,
    fault: Option<DurableWriteFault>,
    intended_recovery: &Path,
) -> Result<FileVersion, DurableWriteOutcome> {
    let (observed_new, observed_displaced) =
        match capture_replacement_observations(destination, displaced_path, fault, intended_recovery)
        {
            Ok(observations) => observations,
            Err(outcome) => return Err(outcome),
        };
    verify_replacement_observations(
        observed_new,
        observed_displaced,
        expected,
        staged_version,
        intended_recovery,
        displaced_path,
    )
}

pub(super) fn capture_replacement_observations(
    destination: &Path,
    displaced_path: &Path,
    fault: Option<DurableWriteFault>,
    intended_recovery: &Path,
) -> Result<(Option<FileVersion>, Option<FileVersion>), DurableWriteOutcome> {
    let observed_new = match capture_file_version(destination) {
        Ok(version) => version,
        Err(error) => {
            return Err(replacement_indeterminate(
                format!(
                    "The replacement completed but the destination could not be observed: {error}"
                ),
                intended_recovery,
                displaced_path,
            ));
        }
    };
    if fault == Some(DurableWriteFault::DisplacedObserve) {
        return Err(replacement_indeterminate(
            "The replacement completed but the displaced original could not be observed."
                .to_string(),
            intended_recovery,
            displaced_path,
        ));
    }
    let observed_displaced = match capture_file_version(displaced_path) {
        Ok(version) => version,
        Err(error) => {
            return Err(replacement_indeterminate(
                format!(
                    "The replacement completed but the displaced original could not be observed: {error}"
                ),
                intended_recovery,
                displaced_path,
            ));
        }
    };
    Ok((observed_new, observed_displaced))
}

pub(super) fn verify_replacement_observations(
    observed_new: Option<FileVersion>,
    observed_displaced: Option<FileVersion>,
    expected: &ExpectedFileState,
    staged_version: &FileVersion,
    intended_recovery: &Path,
    displaced_path: &Path,
) -> Result<FileVersion, DurableWriteOutcome> {
    if !observed_displaced
        .as_ref()
        .zip(expected.version())
        .is_some_and(|(displaced, expected)| displaced.is_displaced_version_of(expected))
    {
        return Err(replacement_indeterminate(
            "The destination changed at the replacement boundary; recovery material was retained."
                .to_string(),
            intended_recovery,
            displaced_path,
        ));
    }
    let Some(version) = observed_new else {
        return Err(replacement_indeterminate(
            "The replacement outcome could not be observed; recovery material was retained."
                .to_string(),
            intended_recovery,
            displaced_path,
        ));
    };
    if !version.is_displaced_version_of(staged_version) {
        return Err(replacement_indeterminate(
            "The replacement identity did not match the synchronized staged image; recovery material was retained."
                .to_string(),
            intended_recovery,
            displaced_path,
        ));
    }
    Ok(version)
}

pub(super) fn capture_committed_binding(
    destination: &Path,
    version: &FileVersion,
    intended_recovery: &Path,
    displaced_path: &Path,
) -> Result<FileVersion, DurableWriteOutcome> {
    match capture_committed_file_version(destination) {
        Ok(Some(committed_version)) if committed_version == *version => Ok(committed_version),
        Ok(Some(_)) => Err(replacement_indeterminate(
            "The committed destination changed while its retained binding was acquired."
                .to_string(),
            intended_recovery,
            displaced_path,
        )),
        Ok(None) => Err(replacement_indeterminate(
            "The committed destination disappeared before its retained binding was acquired."
                .to_string(),
            intended_recovery,
            displaced_path,
        )),
        Err(error) => Err(replacement_indeterminate(
            format!(
                "The committed destination could not retain its object binding: {error}"
            ),
            intended_recovery,
            displaced_path,
        )),
    }
}

pub(super) fn finalize_committed_replacement(
    parent: &Path,
    fault: Option<DurableWriteFault>,
    destination: &Path,
    version: &FileVersion,
    intended_recovery: PathBuf,
    displaced_path: PathBuf,
) -> io::Result<DurableWriteOutcome> {
    let directory_sync = if fault == Some(DurableWriteFault::ParentSync) {
        Err(io::Error::other(
            "injected parent-directory synchronization failure",
        ))
    } else {
        sync_parent_directory_if_required(parent)
    };
    if let Err(error) = directory_sync {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The replacement completed but directory synchronization failed: {error}"
            ),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    if fault == Some(DurableWriteFault::CommittedBindingObserve) {
        fs::remove_file(destination)?;
    }
    let committed_version = match capture_committed_binding(
        destination,
        version,
        &intended_recovery,
        &displaced_path,
    ) {
        Ok(committed_version) => committed_version,
        Err(outcome) => return Ok(outcome),
    };
    if let Err(error) = fs::remove_file(&intended_recovery) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The commit was observed but the independent recovery image could not be retired: {error}"
            ),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    Ok(DurableWriteOutcome::ConfirmedCommitted {
        version: committed_version,
        displaced_path: Some(displaced_path),
    })
}
