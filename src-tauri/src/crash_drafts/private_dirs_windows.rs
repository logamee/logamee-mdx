//! Windows SDDL private-permission enforcement.
use super::*;


#[cfg(windows)]
pub(crate) fn make_directory_private(path: &Path) -> io::Result<()> {
    let sddl = private_windows_sddl(PRIVATE_DIRECTORY_SDDL, "OICI")?;
    apply_and_verify_private_windows_dacl(path, &sddl, 0x03)
}

#[cfg(windows)]
pub(crate) fn make_file_private(path: &Path) -> io::Result<()> {
    let sddl = private_windows_sddl(PRIVATE_FILE_SDDL, "")?;
    apply_and_verify_private_windows_dacl(path, &sddl, 0x00)
}
