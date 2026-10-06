//! Failure classification and directory identity.
#[allow(unused_imports)]
use std::{ fs::{self },
    io::{self},
    path::{PathBuf},
    sync::{Mutex}};



#[cfg(windows)]
pub(crate) fn replace_error_requires_indeterminate(error: &io::Error) -> bool {
    windows_replace_error_requires_indeterminate(error.raw_os_error())
}

#[cfg(not(windows))]
pub(crate) fn replace_error_requires_indeterminate(_error: &io::Error) -> bool {
    false
}

#[cfg(any(windows, test))]
pub(crate) fn windows_replace_error_requires_indeterminate(raw_os_error: Option<i32>) -> bool {
    matches!(raw_os_error, Some(1176 | 1177))
}
