//! Path helpers and per-type impls for workspace entities.
use super::*;

pub(crate) fn reject_symlink_components_below_root(path: &Path, root: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Cannot access workspace entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            let parent = current
                .parent()
                .ok_or_else(|| "Workspace entry path is invalid".to_string())?;
            let canonical_parent = normalize_existing_path(parent)?;
            if path_is_under(&canonical_parent, root) {
                return Err("Symbolic links cannot be modified as workspace entries".into());
            }
        }
    }
    Ok(())
}
