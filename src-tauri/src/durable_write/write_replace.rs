//! Replace-phase execution and post-mutation observation.
//! Phase helpers for the durable write pipeline.
//! Durable write orchestration with fault hooks.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self},
    path::{Path, PathBuf},
    sync::{Mutex}};

use super::*;

mod commit;
mod outcomes;

use commit::{finalize_committed_replacement, observe_replacement};
use outcomes::{
    post_replace_fault, pre_replace_fault_outcome, revalidate_staged_handle,
    replace_error_outcome,
};

pub(super) fn replace_destination_with_observation(
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
    let fault_outcome = pre_replace_fault_outcome(destination, expected, fault, &intended_recovery)?;
    if let Some(outcome) = fault_outcome {
        return Ok(outcome);
    }

    let displaced_hint = atomic_displaced_path(staged_path);
    #[cfg(windows)]
    drop(staged_file);
    let displaced_path = match atomic_replace_with_backup(staged_path, destination) {
        Ok(path) => path,
        Err(error) => return replace_error_outcome(
            destination,
            expected,
            error,
            displaced_hint,
            intended_recovery,
        ),
    };

    let displaced_bytes = fs::read(&displaced_path).ok();
    after_replace();
    if capture_directory_identity(parent).ok().as_ref() != Some(parent_identity) {
        return Ok(parent_change_during_replace(
            requested_destination,
            bytes,
            &intended_recovery,
            &displaced_path,
            displaced_bytes,
        ));
    }

    #[cfg(not(windows))]
    if let Some(indeterminate) =
        revalidate_staged_handle(&mut staged_file, bytes, &intended_recovery, &displaced_path)
    {
        return Ok(indeterminate);
    }
    if let Some(indeterminate) = post_replace_fault(fault, &intended_recovery, &displaced_path) {
        return Ok(indeterminate);
    }
    let version = match observe_replacement(
        destination,
        &displaced_path,
        expected,
        staged_version,
        fault,
        &intended_recovery,
    ) {
        Ok(version) => version,
        Err(outcome) => return Ok(outcome),
    };

    finalize_committed_replacement(parent, fault, destination, &version, intended_recovery, displaced_path)
}

fn parent_change_during_replace(
    requested_destination: &Path,
    bytes: &[u8],
    intended_recovery: &Path,
    displaced_path: &Path,
    displaced_bytes: Option<Vec<u8>>,
) -> DurableWriteOutcome {
    parent_change_indeterminate(
        requested_destination,
        bytes,
        vec![intended_recovery.to_path_buf(), displaced_path.to_path_buf()],
        displaced_bytes
            .into_iter()
            .map(|bytes| ("displaced".to_string(), bytes))
            .collect(),
        "The destination parent changed while replacement was in progress.",
    )
}
