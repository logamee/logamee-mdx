//! Secure-filesystem platform facade.
use super::*;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod secure_fs {
    use super::*;

    pub(super) fn mkdirs_open_final(_root: &File, _relative: &Path) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn create_new_file_at(_directory: &File, _name: &str) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn open_existing_file_at(_directory: &File, _name: &str) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn publish_no_replace(
        _directory: &File,
        _staged: &str,
        _final_name: &str,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource publication is unsupported on this platform",
        ))
    }
    pub(super) fn publish_replace(
        _directory: &File,
        _staged: &str,
        _final_name: &str,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource replacement is unsupported on this platform",
        ))
    }
    pub(super) fn unlink_at(_directory: &File, _name: &str) {}
    pub(super) fn sync_directory(_directory: &File) -> io::Result<()> {
        Ok(())
    }
}
