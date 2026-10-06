use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn canonicalize_existing_path(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    fs::canonicalize(path.as_ref())
}

pub(crate) fn normalize_existing_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    canonicalize_existing_path(path).map_err(|err| format!("Cannot access path: {err}"))
}

pub(crate) fn normalize_parent_for_new_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = path.as_ref();
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Parent directory traversal is not allowed".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Path has no file name".to_string())?;
    let parent = normalize_existing_path(parent)?;
    Ok(parent.join(file_name))
}

pub(crate) fn normalize_file_for_write(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = path.as_ref();
    if path.exists() {
        let canonical = normalize_existing_path(path)?;
        if !canonical.is_file() {
            return Err("Destination is not a file".into());
        }
        Ok(canonical)
    } else {
        normalize_parent_for_new_path(path)
    }
}

pub(crate) fn path_is_under(child: &Path, root: &Path) -> bool {
    child == root || child.starts_with(root)
}

