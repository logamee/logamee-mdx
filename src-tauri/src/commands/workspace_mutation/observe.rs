use std::{fs, path::Path};

use crate::path_auth::RenameErrorObservation;
use super::super::{
    FileSystemPort, ObservedContentEvidence, ObservedPath, ObservedPathKind, RenamePathEvidence,
};

fn rename_path_evidence(
    filesystem: &impl FileSystemPort,
    path: &Path,
    is_file: bool,
) -> RenamePathEvidence {
    match filesystem.observe(path, None) {
        Ok(ObservedPath::Missing) => RenamePathEvidence::Missing,
        Ok(ObservedPath::Present {
            canonical_path: Some(canonical_path),
            kind,
            ..
        }) if canonical_path == path
            && kind
                == if is_file {
                    ObservedPathKind::File
                } else {
                    ObservedPathKind::Directory
                } =>
        {
            RenamePathEvidence::Matches
        }
        Ok(ObservedPath::Present { .. }) => RenamePathEvidence::Unexpected,
        Err(error) => RenamePathEvidence::ObservationFailed(error.to_string()),
    }
}

pub(crate) fn observe_rename_after_error(
    filesystem: &impl FileSystemPort,
    old_path: &Path,
    new_path: &Path,
    is_file: bool,
) -> RenameErrorObservation {
    let old = rename_path_evidence(filesystem, old_path, is_file);
    let new = rename_path_evidence(filesystem, new_path, is_file);
    match (&old, &new) {
        (RenamePathEvidence::Matches, RenamePathEvidence::Missing) => {
            RenameErrorObservation::ConfirmedNotCommitted
        }
        (RenamePathEvidence::Missing, RenamePathEvidence::Matches) => {
            RenameErrorObservation::ConfirmedCommitted
        }
        (RenamePathEvidence::Matches, RenamePathEvidence::Matches) => {
            RenameErrorObservation::Indeterminate {
                message: " Outcome observation found both old and new paths; the rename remains indeterminate."
                    .to_string(),
            }
        }
        (RenamePathEvidence::Missing, RenamePathEvidence::Missing) => {
            RenameErrorObservation::Indeterminate {
                message: " Outcome observation found neither old nor new path; the rename remains indeterminate."
                    .to_string(),
            }
        }
        _ => {
            let mut message = String::new();
            match old {
                RenamePathEvidence::Unexpected => message.push_str(
                    " Observation of old path did not match the expected kind and canonical identity.",
                ),
                RenamePathEvidence::ObservationFailed(error) => message
                    .push_str(&format!(" Observation of old path failed: {error}.")),
                RenamePathEvidence::Missing | RenamePathEvidence::Matches => {}
            }
            match new {
                RenamePathEvidence::Unexpected => message.push_str(
                    " Observation of new path did not match the expected kind and canonical identity.",
                ),
                RenamePathEvidence::ObservationFailed(error) => message
                    .push_str(&format!(" Observation of new path failed: {error}.")),
                RenamePathEvidence::Missing | RenamePathEvidence::Matches => {}
            }
            message.push_str(" The rename remains indeterminate.");
            RenameErrorObservation::Indeterminate { message }
        }
    }
}

pub(crate) fn observe_path(path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ObservedPath::Missing);
        }
        Err(error) => return Err(error),
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Ok(ObservedPath::Present {
            canonical_path: None,
            kind: ObservedPathKind::Symlink,
            content: ObservedContentEvidence::NotRequested,
        });
    }

    let canonical_path = fs::canonicalize(path)?;
    let (kind, content) = if file_type.is_file() {
        let content = match expected_bytes {
            Some(expected) if canonical_path == path => {
                let observed = fs::read(&canonical_path)?;
                ObservedContentEvidence::Compared {
                    matches_expected: observed == expected,
                    bytes_read: observed.len(),
                }
            }
            Some(_) | None => ObservedContentEvidence::NotRequested,
        };
        (ObservedPathKind::File, content)
    } else if file_type.is_dir() {
        (
            ObservedPathKind::Directory,
            ObservedContentEvidence::NotRequested,
        )
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Observed path is not a file, directory, or symlink",
        ));
    };

    Ok(ObservedPath::Present {
        canonical_path: Some(canonical_path),
        kind,
        content,
    })
}
