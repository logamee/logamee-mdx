use super::{copy_entry, derive_copy_name, CopyEntryError};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::symlink;
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

#[cfg(unix)]
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
fn rejects_a_missing_copy_source() {
    let directory = tempdir().unwrap();
    let missing = directory.path().join("missing.md");
    let target = directory.path().join("copy.md");

    let error = assert_not_committed(copy_entry(&missing, &target, true).unwrap_err());
    assert!(error.contains("Cannot read the copy source"));
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_fifo_copy_source() {
    let directory = tempdir().unwrap();
    let fifo = directory.path().join("pipe");
    let target = directory.path().join("copy.md");
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
