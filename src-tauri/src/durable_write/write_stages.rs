//! Phase helpers for the durable write pipeline.
//! Durable write orchestration with fault hooks.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use crate::private_fs::lowercase_hex;

use super::*;

pub(super) fn install_expected_absent_path(
    requested_destination: &Path,
    destination: &Path,
    parent: &Path,
    parent_identity: &DirectoryIdentity,
    staged_path: &Path,
    staged_file: &mut File,
    bytes: &[u8],
    fault: Option<DurableWriteFault>,
    intended_recovery: PathBuf,
    expected: &ExpectedFileState,
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    if fault == Some(DurableWriteFault::Replace) {
        return classify_failed_attempt(
            destination,
            expected,
            vec![intended_recovery],
            "The creation primitive failed before installing the destination.",
        );
    }
    match install_expected_absent(staged_path, destination) {
        Ok(disposition) => install_and_confirm(
            requested_destination,
            destination,
            parent,
            parent_identity,
            staged_path,
            staged_file,
            bytes,
            fault,
            intended_recovery,
            disposition,
            after_replace,
        ),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return match capture_file_version(destination) {
                Ok(Some(current_version)) => Ok(DurableWriteOutcome::Conflict {
                    current_version: Some(current_version),
                    recovery_path: intended_recovery,
                }),
                Ok(None) | Err(_) => Ok(DurableWriteOutcome::Indeterminate {
                    message: "The creation primitive reported an existing destination, but that result could not be confirmed."
                        .to_string(),
                    recovery_paths: vec![intended_recovery],
                }),
            };
        }
        Err(error) => {
            return classify_failed_attempt(
                destination,
                expected,
                vec![intended_recovery],
                &format!("The creation primitive failed: {error}"),
            );
        }
    }
}

fn install_and_confirm(
    requested_destination: &Path,
    destination: &Path,
    parent: &Path,
    parent_identity: &DirectoryIdentity,
    staged_path: &Path,
    staged_file: &mut File,
    bytes: &[u8],
    fault: Option<DurableWriteFault>,
    intended_recovery: PathBuf,
    disposition: NewInstallDisposition,
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    after_replace();
    let staged_alias = (disposition == NewInstallDisposition::StagingAlias)
        .then(|| staged_path.to_path_buf());
    if capture_directory_identity(parent).ok().as_ref() != Some(parent_identity) {
        return Ok(parent_change_indeterminate(
            requested_destination,
            bytes,
            vec![intended_recovery],
            Vec::new(),
            if staged_alias.is_some() {
                "The destination parent changed while the new file was being installed. The non-independent staging alias location is uncertain."
            } else {
                "The destination parent changed while the new file was being installed."
            },
        ));
    }
    if let Some(indeterminate) =
        revalidate_installed_handle(staged_file, bytes, &intended_recovery, &staged_alias)
    {
        return Ok(indeterminate);
    }
    let version = match capture_created_version(destination, fault, &intended_recovery, &staged_alias) {
        Ok(version) => version,
        Err(outcome) => return Ok(outcome),
    };
    let intended_digest = lowercase_hex(&Sha256::digest(bytes));
    if version.sha256 != intended_digest {
        return Ok(creation_indeterminate(
            "The created destination no longer matches the synchronized intended image.",
            intended_recovery,
            staged_alias,
        ));
    }
    if let Some(indeterminate) = retire_staging_alias(staged_alias.as_deref(), &intended_recovery) {
        return Ok(indeterminate);
    }
    Ok(sync_created_and_confirm(
        parent,
        fault,
        intended_recovery,
        version,
    ))
}

fn revalidate_installed_handle(
    staged_file: &mut File,
    bytes: &[u8],
    intended_recovery: &Path,
    staged_alias: &Option<PathBuf>,
) -> Option<DurableWriteOutcome> {
    match open_file_matches_bytes(staged_file, bytes) {
        Ok(true) => None,
        Ok(false) => Some(creation_indeterminate(
            "The installed object no longer matches the verified staged handle.",
            intended_recovery.to_path_buf(),
            staged_alias.clone(),
        )),
        Err(error) => Some(creation_indeterminate(
            &format!("The installed staged handle could not be revalidated: {error}"),
            intended_recovery.to_path_buf(),
            staged_alias.clone(),
        )),
    }
}

fn capture_created_version(
    destination: &Path,
    fault: Option<DurableWriteFault>,
    intended_recovery: &Path,
    staged_alias: &Option<PathBuf>,
) -> Result<FileVersion, DurableWriteOutcome> {
    if fault == Some(DurableWriteFault::CreationObserve) {
        return Err(creation_indeterminate(
            "The destination was created but could not be observed.",
            intended_recovery.to_path_buf(),
            staged_alias.clone(),
        ));
    }
    match capture_committed_file_version(destination) {
        Ok(Some(version)) => Ok(version),
        Ok(None) => Err(creation_indeterminate(
            "The created destination disappeared before it could be observed.",
            intended_recovery.to_path_buf(),
            staged_alias.clone(),
        )),
        Err(error) => Err(creation_indeterminate(
            &format!("The destination was created but could not be observed: {error}"),
            intended_recovery.to_path_buf(),
            staged_alias.clone(),
        )),
    }
}

fn retire_staging_alias(
    staged_alias: Option<&Path>,
    intended_recovery: &Path,
) -> Option<DurableWriteOutcome> {
    let staged_alias = staged_alias?;
    if let Err(error) = fs::remove_file(staged_alias) {
        return Some(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The destination was created but its staging link could not be retired: {error}"
            ),
            recovery_paths: existing_recovery_paths(vec![intended_recovery.to_path_buf()]),
        });
    }
    None
}

fn sync_created_and_confirm(
    parent: &Path,
    fault: Option<DurableWriteFault>,
    intended_recovery: PathBuf,
    version: FileVersion,
) -> DurableWriteOutcome {
    if fault == Some(DurableWriteFault::ParentSync)
        || sync_parent_directory_if_required(parent).is_err()
    {
        return DurableWriteOutcome::Indeterminate {
            message: "The destination was created but directory synchronization failed."
                .to_string(),
            recovery_paths: vec![intended_recovery],
        };
    }
    DurableWriteOutcome::ConfirmedCommitted {
        version,
        displaced_path: Some(intended_recovery),
    }
}

pub(super) fn stage_durable_image(
    requested_destination: &Path,
    bytes: &[u8],
    fault: Option<DurableWriteFault>,
    expected: &ExpectedFileState,
) -> io::Result<(
    PathBuf,
    PathBuf,
    File,
    FileVersion,
    PathBuf,
    PathBuf,
    DirectoryIdentity,
)> {
    let requested_parent = requested_destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    fs::create_dir_all(requested_parent)?;
    let parent = fs::canonicalize(requested_parent)?;
    let destination = parent.join(requested_destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?);
    let parent_identity = capture_directory_identity(&parent)?;
    let (staged_path, staged_file, staged_version) =
        stage_and_sync_image(&destination, bytes, fault, expected)?;
    let intended_recovery = create_recovery_image(&destination, bytes)?;
    Ok((
        destination,
        staged_path,
        staged_file,
        staged_version,
        intended_recovery,
        parent,
        parent_identity,
    ))
}

fn stage_and_sync_image(
    destination: &Path,
    bytes: &[u8],
    fault: Option<DurableWriteFault>,
    expected: &ExpectedFileState,
) -> io::Result<(PathBuf, File, FileVersion)> {
    if fault == Some(DurableWriteFault::TempCreate) {
        return Err(io::Error::other("injected staged creation failure"));
    }
    let (staged_path, mut staged_file) = create_named_temp(destination, "tmp")?;
    if fault == Some(DurableWriteFault::Write) {
        return Err(io::Error::other("injected staged write failure"));
    }
    if fault == Some(DurableWriteFault::PartialWrite) {
        staged_file.write_all(&bytes[..bytes.len() / 2])?;
        return Err(io::Error::other("injected partial staged write failure"));
    }
    staged_file.write_all(bytes)?;
    if fault == Some(DurableWriteFault::Flush) {
        return Err(io::Error::other("injected staged flush failure"));
    }
    staged_file.flush()?;
    if fault == Some(DurableWriteFault::Metadata) {
        return Err(io::Error::other("injected metadata copy failure"));
    }
    copy_destination_permissions(destination, &staged_path, expected)?;
    if fault == Some(DurableWriteFault::Sync) {
        return Err(io::Error::other("injected staged sync failure"));
    }
    staged_file.sync_all()?;
    let staged_version = capture_file_version(&staged_path)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "staged image disappeared after synchronization",
        )
    })?;
    Ok((staged_path, staged_file, staged_version))
}
