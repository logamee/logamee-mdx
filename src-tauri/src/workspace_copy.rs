//! Staged, atomic copies of workspace entries.
//!
//! A copy never mutates the destination name directly: the whole tree is
//! materialized inside a private staging directory next to the destination and
//! then installed with a no-replace rename. A failure before that rename
//! commits nothing, so callers can report `ConfirmedNotCommitted` honestly;
//! only a failure after the rename is reported as committed-but-unverified.

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Matches the workspace snapshot traversal cap so a copy cannot enumerate a
/// tree the workspace itself refuses to index.
pub(crate) const MAX_COPY_ENTRIES: usize = 200_000;
const MAX_COPY_DEPTH: usize = 64;
const STAGING_ATTEMPTS: usize = 32;

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

fn allocate_staging_path(target: &Path) -> Result<PathBuf, CopyEntryError> {
    let parent = target
        .parent()
        .ok_or_else(|| CopyEntryError::NotCommitted("Copy destination has no parent".into()))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("entry");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage a copy: {error}")))?;
        let suffix = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let candidate = parent.join(format!(".{name}.copy-{suffix}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(CopyEntryError::NotCommitted(format!(
                    "Cannot prepare a copy destination: {error}"
                )))
            }
        }
    }
    Err(CopyEntryError::NotCommitted(
        "Could not allocate a unique staging path for the copy".into(),
    ))
}

fn stage_file(source: &Path, staged_path: &Path) -> Result<(), CopyEntryError> {
    // Classify through symlink metadata before any open: special objects such
    // as FIFOs would block a plain open for read until a writer appears.
    let classified = fs::symlink_metadata(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
    if classified.file_type().is_symlink() || !classified.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    let mut input = fs::File::open(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
    let metadata = input
        .metadata()
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot inspect the copy source: {error}")))?;
    if !metadata.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    let mut output = fs::File::create(staged_path)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
    stream_copy(&mut input, &mut output)?;
    output
        .sync_all()
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot persist the staged copy: {error}")))?;
    Ok(())
}

fn stage_tree(
    source: &Path,
    staged_path: &Path,
    depth: usize,
    budget: &mut usize,
) -> Result<(), CopyEntryError> {
    if depth > MAX_COPY_DEPTH {
        return Err(CopyEntryError::NotCommitted(format!(
            "The directory tree exceeds the copy depth limit of {MAX_COPY_DEPTH}"
        )));
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| {
            CopyEntryError::NotCommitted(format!(
                "The directory tree exceeds the copy entry limit of {MAX_COPY_ENTRIES}"
            ))
        })?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot inspect the copy source: {error}")))?;
    if metadata.file_type().is_symlink() {
        return Err(CopyEntryError::NotCommitted(
            "Symbolic links cannot be copied as workspace entries".into(),
        ));
    }
    if metadata.file_type().is_dir() {
        fs::create_dir(staged_path)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
        let children = fs::read_dir(source)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
        for child in children {
            let child = child
                .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
            let child_name = child
                .file_name()
                .into_string()
                .map_err(|_| CopyEntryError::NotCommitted("Copy source names must be valid Unicode".into()))?;
            stage_tree(&child.path(), &staged_path.join(child_name), depth + 1, budget)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(CopyEntryError::NotCommitted(
            "Copy sources must be regular files or directories".into(),
        ));
    }
    stage_file(source, staged_path)
}

fn stream_copy(input: &mut impl Read, output: &mut impl Write) -> Result<(), CopyEntryError> {
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot read the copy source: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| CopyEntryError::NotCommitted(format!("Cannot stage the copy: {error}")))?;
    }
}

fn install_staged(staged_root: &Path, target: &Path) -> Result<(), CopyEntryError> {
    install_no_replace(staged_root, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CopyEntryError::NotCommitted("Workspace entry already exists".into())
        } else {
            CopyEntryError::NotCommitted(format!("Cannot install the copy: {error}"))
        }
    })
}

#[cfg(target_os = "linux")]
fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn install_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let result = unsafe { MoveFileExW(wide(source).as_ptr(), wide(target).as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn install_no_replace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no audited no-replace rename primitive",
    ))
}

#[cfg(unix)]
fn sync_parent_directory(target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Copy destination has no parent".to_string())?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_parent_directory(_target: &Path) -> Result<(), String> {
    // Win32 exposes no supported parent-directory fsync contract; the staged
    // install itself is the durability step the platform can provide.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_entry, derive_copy_name, CopyEntryError};
    use std::{fs, os::unix::fs::symlink};
    use tempfile::tempdir;

    #[test]
    fn derives_copy_names_with_the_file_manager_convention() {
        let taken = ["note.md", "note copy.md"];
        let is_taken = |candidate: &str| taken.contains(&candidate);
        assert_eq!(
            derive_copy_name("note.md", is_taken).as_deref(),
            Some("note copy 2.md")
        );
        assert_eq!(
            derive_copy_name("fresh.md", |_| false).as_deref(),
            Some("fresh.md")
        );
        let folder_taken = ["book", "book copy"];
        assert_eq!(
            derive_copy_name("book", |candidate| folder_taken.contains(&candidate)).as_deref(),
            Some("book copy 2")
        );
        assert_eq!(
            derive_copy_name("book", |candidate| candidate != "book copy").as_deref(),
            Some("book copy")
        );
        let exhausted = |_candidate: &str| true;
        assert_eq!(derive_copy_name("note.md", exhausted), None);
    }

    fn assert_not_committed(error: CopyEntryError) -> String {
        match error {
            CopyEntryError::NotCommitted(message) => message,
            CopyEntryError::CommittedButUnverified { .. } => {
                panic!("expected a not-committed copy failure")
            }
        }
    }

    #[test]
    fn copies_a_file_byte_for_byte_and_leaves_no_staging_residue() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("note.md");
        fs::write(&source, b"# hello").unwrap();
        let target = directory.path().join("note copy.md");

        copy_entry(&source, &target, true).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"# hello");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn copies_a_directory_tree_recursively() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("book");
        fs::create_dir_all(source.join("chapters/inner")).unwrap();
        fs::write(source.join("readme.md"), "readme").unwrap();
        fs::write(source.join("chapters/one.md"), "one").unwrap();
        fs::write(source.join("chapters/inner/two.md"), "two").unwrap();
        let target = directory.path().join("book copy");

        copy_entry(&source, &target, false).unwrap();

        assert_eq!(fs::read_to_string(target.join("readme.md")).unwrap(), "readme");
        assert_eq!(fs::read_to_string(target.join("chapters/one.md")).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(target.join("chapters/inner/two.md")).unwrap(),
            "two"
        );
    }

    #[test]
    fn refuses_to_overwrite_an_existing_destination_and_commits_nothing() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("note.md");
        fs::write(&source, b"new").unwrap();
        let target = directory.path().join("existing.md");
        fs::write(&target, b"original").unwrap();

        let error = assert_not_committed(copy_entry(&source, &target, true).unwrap_err());

        assert!(error.contains("already exists"));
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn refuses_symlinks_anywhere_in_the_copied_tree() {
        let directory = tempdir().unwrap();
        let outside = directory.path().join("outside.md");
        fs::write(&outside, b"outside").unwrap();
        let source = directory.path().join("book");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("note.md"), "note").unwrap();
        symlink(&outside, source.join("link.md")).unwrap();
        let target = directory.path().join("book copy");

        let error = assert_not_committed(copy_entry(&source, &target, false).unwrap_err());

        assert!(error.contains("Symbolic links"));
        assert!(!target.exists());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }

    #[test]
    fn rejects_a_missing_or_non_regular_copy_source() {
        let directory = tempdir().unwrap();
        let missing = directory.path().join("missing.md");
        let target = directory.path().join("copy.md");

        let error = assert_not_committed(copy_entry(&missing, &target, true).unwrap_err());
        assert!(error.contains("Cannot read the copy source"));
        assert!(!target.exists());

        let fifo = directory.path().join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().to_str().unwrap()).unwrap();
        unsafe {
            libc::mkfifo(name.as_ptr(), 0o600);
        }
        let error = assert_not_committed(copy_entry(&fifo, &target, true).unwrap_err());
        assert!(error.contains("regular files"));
        assert!(!target.exists());
    }

    #[test]
    fn enforces_the_copy_depth_limit() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("deep");
        let mut deepest = source.clone();
        for index in 0..80 {
            deepest = deepest.join(format!("level-{index}"));
        }
        fs::create_dir_all(&deepest).unwrap();
        fs::write(deepest.join("note.md"), "deep").unwrap();
        let target = directory.path().join("deep copy");

        let error = assert_not_committed(copy_entry(&source, &target, false).unwrap_err());

        assert!(error.contains("depth limit"));
        assert!(!target.exists());
    }
}
