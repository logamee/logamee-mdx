//! Shared durable-write test imports.
#[allow(unused_imports)]
pub(crate) use std::{
    fs,
    process::Command,
    sync::{Arc, Barrier},
    thread,
};
pub(crate) use tempfile::tempdir;
pub(crate) use super::{ExpectedFileState, FileVersion};

pub(crate) fn exact(version: &FileVersion) -> ExpectedFileState {
    ExpectedFileState::Exact {
        version: version.clone(),
    }
}

pub(crate) fn staged_files(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(directory)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".tmp-"))
                .then_some(path)
        })
        .collect()
}

#[cfg(unix)]
pub(crate) fn recovery_files(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(directory)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".recovery-"))
                .then_some(path)
        })
        .collect()
}
