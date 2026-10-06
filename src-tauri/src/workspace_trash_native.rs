use std::{fmt, fs, io, path::Path};

use crate::workspace_trash::{
    MoveToTrash, PlacementVerification, SourceObservation, TrashEntryKind, TrashPort,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeTrashError {
    pub(crate) operation: &'static str,
    pub(crate) message: String,
}

impl NativeTrashError {
    fn new(operation: &'static str, error: impl fmt::Display) -> Self {
        Self {
            operation,
            message: error.to_string(),
        }
    }
}

impl fmt::Display for NativeTrashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.operation, self.message)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeTrashReceipt {
    destination: std::path::PathBuf,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
    #[cfg(target_os = "linux")]
    trash_info: std::path::PathBuf,
    #[cfg(target_os = "linux")]
    expected_trash_info: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NativeSourceIdentity {
    #[cfg(unix)]
    Unix {
        device: u64,
        inode: u64,
        kind: TrashEntryKind,
        #[cfg(target_os = "linux")]
        inode_lease: LinuxInodeLease,
    },
    #[cfg(windows)]
    Windows {
        volume: u32,
        file_index: u64,
        kind: TrashEntryKind,
    },
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxInodeLease {
    _file: std::sync::Arc<fs::File>,
}

#[cfg(target_os = "linux")]
impl PartialEq for LinuxInodeLease {
    fn eq(&self, _other: &Self) -> bool {
        // dev/inode/kind carry equality; the open handle only prevents inode reuse.
        true
    }
}

#[cfg(target_os = "linux")]
impl Eq for LinuxInodeLease {}

impl NativeSourceIdentity {
    fn kind(&self) -> TrashEntryKind {
        match self {
            #[cfg(unix)]
            Self::Unix { kind, .. } => *kind,
            #[cfg(windows)]
            Self::Windows { kind, .. } => *kind,
        }
    }
}

#[derive(Default)]
pub(crate) struct NativeTrashPort {
    source_identity: Option<NativeSourceIdentity>,
    #[cfg(test)]
    injected_move: Option<InjectedMove>,
}

#[cfg(test)]
type InjectedMove = Box<
    dyn FnOnce(
        &Path,
        TrashEntryKind,
        NativeSourceIdentity,
    ) -> MoveToTrash<NativeTrashReceipt, NativeTrashError>,
>;

impl TrashPort for NativeTrashPort {
    type RecoveryReceipt = NativeTrashReceipt;
    type Error = NativeTrashError;

    fn move_to_trash(
        &mut self,
        source: &Path,
        kind: TrashEntryKind,
    ) -> MoveToTrash<Self::RecoveryReceipt, Self::Error> {
        let source_identity = match capture_source_identity(source, kind) {
            Ok(identity) => identity,
            Err(error) => return MoveToTrash::Rejected { error },
        };
        self.source_identity = Some(source_identity.clone());
        #[cfg(test)]
        if let Some(injected_move) = self.injected_move.take() {
            return injected_move(source, kind, source_identity);
        }
        let result = platform::move_to_trash(source, kind, source_identity);
        #[cfg(feature = "packaged-lifecycle-e2e")]
        match &result {
            MoveToTrash::Rejected { error } => {
                eprintln!("Packaged lifecycle Windows Trash rejected: {error}");
            }
            MoveToTrash::PossiblyMoved { error, .. } => {
                eprintln!("Packaged lifecycle Windows Trash was not proven: {error}");
            }
            MoveToTrash::Placed { .. } => {}
        }
        result
    }

    fn observe_source(&mut self, source: &Path) -> SourceObservation<Self::Error> {
        match fs::symlink_metadata(source) {
            Ok(_) => {
                let Some(expected) = self.source_identity.as_ref() else {
                    return SourceObservation::Unobservable {
                        error: NativeTrashError::new(
                            "observe trash source identity",
                            "no pre-operation source identity was retained",
                        ),
                    };
                };
                match capture_source_identity(source, expected.kind()) {
                    Ok(actual) if &actual == expected => SourceObservation::Present,
                    Ok(_) => SourceObservation::Unobservable {
                        error: NativeTrashError::new(
                            "observe trash source identity",
                            "source path now refers to a different filesystem object",
                        ),
                    },
                    Err(error) => SourceObservation::Unobservable { error },
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => SourceObservation::Missing,
            Err(error) => SourceObservation::Unobservable {
                error: NativeTrashError::new("observe trash source", error),
            },
        }
    }

    fn verify_placement(
        &mut self,
        receipt: &Self::RecoveryReceipt,
    ) -> PlacementVerification<Self::Error> {
        platform::verify_placement(receipt)
    }
}


#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod receipt_identity_tests;
mod identity;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod unsupported;

use identity::{capture_source_identity, ensure_identity_unchanged, verify_kind, verify_receipt_identity};
#[cfg(windows)]
use identity::validate_windows_handle_attributes;

mod platform {
    #[cfg(target_os = "linux")]
    pub(super) use super::linux::*;
    #[cfg(target_os = "macos")]
    pub(super) use super::macos::*;
    #[cfg(windows)]
    pub(super) use super::windows::*;
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub(super) use super::unsupported::*;
}
