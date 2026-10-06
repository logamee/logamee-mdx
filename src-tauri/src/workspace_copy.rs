//! Staged, atomic copies of workspace entries.
//!
//! A copy never mutates the destination name directly: the whole tree is
//! materialized inside a private staging directory next to the destination and
//! then installed with a no-replace rename. A failure before that rename
//! commits nothing, so callers can report `ConfirmedNotCommitted` honestly;
//! only a failure after the rename is reported as committed-but-unverified.

use std::{fs, path::{Path, PathBuf}};

/// Matches the workspace snapshot traversal cap so a copy cannot enumerate a
/// tree the workspace itself refuses to index.
pub(crate) const MAX_COPY_ENTRIES: usize = 200_000;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum CopyEntryError {
    /// Nothing was installed at the destination name.
    NotCommitted(String),
    /// The destination name was installed, but durability could not be proven.
    CommittedButUnverified { target: PathBuf, message: String },
}

/// Derives the destination name for a copy whose original name is taken:
/// `note.md` becomes `note copy.md`, then `note copy 2.md`, and so on — the
/// same convention as mainstream file managers. Returns `None` when no free
/// candidate exists within the bounded probe.
pub(crate) fn derive_copy_name(
    original: &str,
    is_taken: impl Fn(&str) -> bool,
) -> Option<String> {
    let probe = |candidate: &str| !is_taken(candidate);
    if probe(original) {
        return Some(original.to_string());
    }
    let (stem, extension) = split_name(original);
    if probe(&format!("{stem} copy{extension}")) {
        return Some(format!("{stem} copy{extension}"));
    }
    for index in 2..=99 {
        let candidate = format!("{stem} copy {index}{extension}");
        if probe(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn split_name(name: &str) -> (String, String) {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    (stem.to_string(), extension)
}

pub(crate) fn copy_entry(source: &Path, target: &Path, is_file: bool) -> Result<(), CopyEntryError> {
    let staged_root = allocate_staging_path(target)?;
    let mut budget = MAX_COPY_ENTRIES;
    let install_result = if is_file {
        stage_file(source, &staged_root)
    } else {
        stage_tree(source, &staged_root, 0, &mut budget)
    };
    if let Err(error) = install_result {
        let _ = fs::remove_dir_all(&staged_root);
        return Err(error);
    }
    if let Err(error) = install_staged(&staged_root, target) {
        let _ = fs::remove_dir_all(&staged_root);
        return Err(error);
    }
    if let Err(error) = sync_parent_directory(target) {
        return Err(CopyEntryError::CommittedButUnverified {
            target: target.to_path_buf(),
            message: format!("The copy was installed but directory synchronization failed: {error}"),
        });
    }
    Ok(())
}

mod staging;

use staging::{allocate_staging_path, install_staged, stage_file, stage_tree, sync_parent_directory};

#[cfg(test)]
mod tests;
