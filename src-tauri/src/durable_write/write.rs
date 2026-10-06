//! Durable write orchestration with fault hooks.
#[allow(unused_imports)]
use std::{ fs::{self },
    io::{self, Write},
    path::{Path},
    sync::{Mutex}};


use super::*;

use super::write_replace::replace_destination_with_observation;
use super::write_stages::{install_expected_absent_path, stage_durable_image};

pub(crate) fn durable_write(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner(destination, bytes, expected, None)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DurableWriteFault {
    TempCreate,
    PartialWrite,
    Write,
    Flush,
    Metadata,
    Sync,
    Replace,
    BackupSucceededReplaceFailed,
    ReplacementSucceededBackupUnknown,
    UnsupportedReplace,
    Observe,
    CreationObserve,
    DisplacedObserve,
    ParentSync,
    CommittedBindingObserve,
}

pub(crate) fn durable_write_inner(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_hooks(destination, bytes, expected, fault, || {}, || {})
}

#[cfg(test)]
pub(crate) fn durable_write_inner_with_hook(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_hooks(destination, bytes, expected, fault, before_replace, || {})
}

pub(crate) fn durable_write_inner_with_hooks(
    requested_destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_all_hooks(
        requested_destination,
        bytes,
        expected,
        fault,
        before_replace,
        || {},
        after_replace,
    )
}

pub(crate) fn durable_write_inner_with_all_hooks(
    requested_destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
    at_mutation_boundary: impl FnOnce(),
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    let _write_guard = DURABLE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (destination, staged_path, staged_file, staged_version, intended_recovery, parent, parent_identity) =
        stage_durable_image(requested_destination, bytes, fault, expected)?;

    let current = capture_file_version(&destination)?;
    if current.as_ref() != expected.version() {
        let _ = fs::remove_file(&staged_path);
        return Ok(DurableWriteOutcome::Conflict {
            current_version: current,
            recovery_path: intended_recovery,
        });
    }
    before_replace();

    let boundary_outcome = validate_mutation_boundary(
        requested_destination,
        bytes,
        &destination,
        expected,
        &parent,
        &parent_identity,
        &staged_path,
        &staged_version,
        &intended_recovery,
    )?;
    if let Some(outcome) = boundary_outcome {
        return Ok(outcome);
    }
    at_mutation_boundary();

    dispatch_install_or_replace(
        requested_destination,
        &destination,
        &staged_path,
        staged_file,
        bytes,
        expected,
        fault,
        intended_recovery,
        &parent,
        &parent_identity,
        &staged_version,
        after_replace,
    )
}

fn dispatch_install_or_replace(
    requested_destination: &Path,
    destination: &Path,
    staged_path: &Path,
    mut staged_file: File,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    intended_recovery: PathBuf,
    parent: &Path,
    parent_identity: &DirectoryIdentity,
    staged_version: &FileVersion,
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    if matches!(expected, ExpectedFileState::Absent) {
        return install_expected_absent_path(
            requested_destination,
            destination,
            parent,
            parent_identity,
            staged_path,
            &mut staged_file,
            bytes,
            fault,
            intended_recovery,
            expected,
            after_replace,
        );
    }
    replace_destination_with_observation(
        requested_destination,
        destination,
        staged_path,
        staged_file,
        bytes,
        expected,
        fault,
        intended_recovery,
        parent,
        parent_identity,
        staged_version,
        after_replace,
    )
}

fn validate_mutation_boundary(
    requested_destination: &Path,
    bytes: &[u8],
    destination: &Path,
    expected: &ExpectedFileState,
    parent: &Path,
    parent_identity: &DirectoryIdentity,
    staged_path: &Path,
    staged_version: &FileVersion,
    intended_recovery: &Path,
) -> io::Result<Option<DurableWriteOutcome>> {
    if capture_directory_identity(parent).ok().as_ref() != Some(&parent_identity) {
        return Ok(Some(parent_change_indeterminate(
            requested_destination,
            bytes,
            vec![intended_recovery.to_path_buf()],
            Vec::new(),
            "The destination parent changed at the mutation boundary; no replacement was attempted.",
        )));
    }
    let staged_boundary = match capture_file_version(staged_path) {
        Ok(version) => version,
        Err(error) => {
            let outcome = classify_failed_attempt(
                destination,
                expected,
                vec![intended_recovery.to_path_buf()],
                &format!("The staged image could not be revalidated: {error}"),
            )?;
            return Ok(Some(outcome));
        }
    };
    if staged_boundary.as_ref() != Some(staged_version) {
        let outcome = classify_failed_attempt(
            destination,
            expected,
            vec![intended_recovery.to_path_buf()],
            "The staged path changed at the mutation boundary; no replacement was attempted.",
        )?;
        return Ok(Some(outcome));
    }
    Ok(None)
}
