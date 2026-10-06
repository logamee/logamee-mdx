//! Outcome classification helpers for the replace phase of the durable write
//! pipeline. Extracted verbatim from `replace_destination_with_observation` so
//! each stage stays independently auditable; statement order, fault-hook
//! ordering and message literals are unchanged.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self},
    path::{Path, PathBuf},
    sync::{Mutex}};

use crate::durable_write::*;

// Threat boundary: random private staging names are recovery internals, not authority
// tokens. Public Linux/macOS/Windows replacement APIs still consume a pathname, so a
// hostile same-UID process can substitute that leaf after revalidation. Unix keeps the
// verified stage handle open. ReplaceFileW requires an exclusive open of the replacement,
// so Windows releases that handle immediately before the native call and relies on the
// independent intended image plus destination and displaced digests. These post-mutation
// checks reject a substituted staged path as Indeterminate on every platform.
// Destination races remain fully in scope and are never dismissed by this boundary.

pub(super) fn replacement_indeterminate(
    message: String,
    intended_recovery: &Path,
    displaced_path: &Path,
) -> DurableWriteOutcome {
    DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths: vec![
            intended_recovery.to_path_buf(),
            displaced_path.to_path_buf(),
        ],
    }
}

pub(super) fn pre_replace_fault_outcome(
    destination: &Path,
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    intended_recovery: &Path,
) -> io::Result<Option<DurableWriteOutcome>> {
    if fault == Some(DurableWriteFault::Replace) {
        let outcome = classify_failed_attempt(
            destination,
            expected,
            vec![intended_recovery.to_path_buf()],
            "The replacement primitive failed before mutation.",
        )?;
        return Ok(Some(outcome));
    }
    if fault == Some(DurableWriteFault::UnsupportedReplace) {
        let outcome = classify_failed_attempt(
            destination,
            expected,
            vec![intended_recovery.to_path_buf()],
            "No audited atomic replace-with-backup primitive is available.",
        )?;
        return Ok(Some(outcome));
    }
    if fault == Some(DurableWriteFault::BackupSucceededReplaceFailed) {
        let observed = observe_open_file(destination, None)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::Interrupted, "destination disappeared")
        })?;
        let backup = create_recovery_image(destination, &observed.bytes)?;
        let outcome = classify_failed_attempt(
            destination,
            expected,
            vec![intended_recovery.to_path_buf(), backup],
            "A before-image backup completed, but replacement failed without mutating the destination.",
        )?;
        return Ok(Some(outcome));
    }
    Ok(None)
}

pub(super) fn replace_error_outcome(
    destination: &Path,
    expected: &ExpectedFileState,
    error: io::Error,
    displaced_hint: PathBuf,
    intended_recovery: PathBuf,
) -> io::Result<DurableWriteOutcome> {
    let mut recovery_paths = vec![intended_recovery];
    if displaced_hint.exists() {
        recovery_paths.push(displaced_hint);
    }
    if replace_error_requires_indeterminate(&error) {
        let observation = match capture_file_version(destination) {
            Ok(Some(version)) => format!(
                "destination re-observed with digest {} after the partial-state error",
                version.sha256
            ),
            Ok(None) => {
                "destination re-observed as absent after the partial-state error".to_string()
            }
            Err(observe_error) => format!(
                "destination re-observation also failed after the partial-state error: {observe_error}"
            ),
        };
        return Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The replacement primitive reported a documented partial-state error: {error}; {observation}."
            ),
            recovery_paths: existing_recovery_paths(recovery_paths),
        });
    }
    classify_failed_attempt(
        destination,
        expected,
        recovery_paths,
        &format!("The replacement primitive reported failure: {error}"),
    )
}

pub(super) fn revalidate_staged_handle(
    staged_file: &mut File,
    bytes: &[u8],
    intended_recovery: &Path,
    displaced_path: &Path,
) -> Option<DurableWriteOutcome> {
    match open_file_matches_bytes(staged_file, bytes) {
        Ok(true) => None,
        Ok(false) => Some(DurableWriteOutcome::Indeterminate {
            message: "The verified staged handle changed during replacement.".to_string(),
            recovery_paths: existing_recovery_paths(vec![
                intended_recovery.to_path_buf(),
                displaced_path.to_path_buf(),
            ]),
        }),
        Err(error) => Some(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The verified staged handle could not be revalidated after replacement: {error}"
            ),
            recovery_paths: existing_recovery_paths(vec![
                intended_recovery.to_path_buf(),
                displaced_path.to_path_buf(),
            ]),
        }),
    }
}

pub(super) fn post_replace_fault(
    fault: Option<DurableWriteFault>,
    intended_recovery: &Path,
    displaced_path: &Path,
) -> Option<DurableWriteOutcome> {
    if fault == Some(DurableWriteFault::ReplacementSucceededBackupUnknown) {
        return Some(replacement_indeterminate(
            "Replacement succeeded but backup disposition could not be confirmed.".to_string(),
            intended_recovery,
            displaced_path,
        ));
    }
    if fault == Some(DurableWriteFault::Observe) {
        return Some(replacement_indeterminate(
            "The replacement completed but outcome observation failed.".to_string(),
            intended_recovery,
            displaced_path,
        ));
    }
    None
}
