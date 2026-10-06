//! Versioned read and observe paths.
#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use crate::private_fs::lowercase_hex;

use sha2::{Digest, Sha256};

use super::*;

pub(crate) fn read_versioned_file(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<VersionedFileBytes>> {
    read_versioned_file_with_hook(path, max_bytes, || {})
}

pub(crate) fn read_versioned_open_file(
    mut file: File,
    canonical_path: &Path,
    max_bytes: usize,
) -> io::Result<VersionedFileBytes> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "open source must be a regular file",
        ));
    }
    let observed_identity = file_platform_identity(&file)?;
    file.seek(SeekFrom::Start(0))?;
    let sentinel_limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(sentinel_limit)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "file exceeds the bounded read limit",
        ));
    }
    let metadata_after = file.metadata()?;
    if file_platform_identity(&file)? != observed_identity
        || metadata.len() != metadata_after.len()
        || metadata.modified().ok() != metadata_after.modified().ok()
        || metadata.len() != bytes.len() as u64
    {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed while it was being read",
        ));
    }
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Ok(VersionedFileBytes {
        version: FileVersion {
            canonical_path: canonical_path.to_string_lossy().into_owned(),
            platform_identity: observed_identity,
            length: metadata.len(),
            modified_nanos,
            sha256: lowercase_hex(&Sha256::digest(&bytes)),
            file_binding: None,
        },
        bytes,
    })
}
