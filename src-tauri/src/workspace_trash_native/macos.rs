//! macOS Finder trash transport.
use std::{
    ffi::{CStr, CString},
    io,
    os::unix::ffi::{OsStrExt, OsStringExt}, // platform-audit: allow (platform-gated trash transport)
    path::PathBuf,
    ptr::NonNull,
};

use objc2_foundation::{NSFileManager, NSURL}; // platform-audit: allow (macos-only trash transport)

use super::*;


pub(super) fn move_to_trash(
    source: &Path,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
    if let Err(error) = ensure_identity_unchanged(source, &source_identity) {
        return MoveToTrash::Rejected { error };
    }
    let source = match CString::new(source.as_os_str().as_bytes()) {
        Ok(source) => source,
        Err(error) => {
            return MoveToTrash::Rejected {
                error: NativeTrashError::new("encode trash source", error),
            }
        }
    };
    let source_url = unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            NonNull::new(source.as_ptr().cast_mut()).expect("CString is non-null"),
            kind == TrashEntryKind::Directory,
            None,
        )
    };
    let mut resulting_url = None;
    let result = NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&source_url, Some(&mut resulting_url));
    let receipt = resulting_url.map(|url| {
        let destination = unsafe {
            std::ffi::OsString::from_vec(
                CStr::from_ptr(url.fileSystemRepresentation().as_ptr())
                    .to_bytes()
                    .to_vec(),
            )
        };
        NativeTrashReceipt {
            destination: PathBuf::from(destination),
            kind,
            source_identity,
        }
    });
    match (result, receipt) {
        (Ok(()), Some(recovery_receipt)) => MoveToTrash::Placed { recovery_receipt },
        (Ok(()), None) => MoveToTrash::PossiblyMoved {
            recovery_receipt: None,
            error: NativeTrashError::new(
                "obtain trash recovery receipt",
                "NSFileManager returned no resulting item URL",
            ),
        },
        (Err(error), recovery_receipt) => MoveToTrash::PossiblyMoved {
            recovery_receipt,
            error: NativeTrashError::new("move item to Trash", format!("{error:?}")),
        },
    }
}

pub(super) fn verify_placement(
    receipt: &NativeTrashReceipt,
) -> PlacementVerification<NativeTrashError> {
    match fs::symlink_metadata(&receipt.destination) {
        Ok(metadata) if verify_kind(&metadata, receipt.kind) => {
            match verify_receipt_identity(receipt) {
                Ok(true) => PlacementVerification::Proven,
                Ok(false) => PlacementVerification::Mismatch,
                Err(error) => PlacementVerification::Unobservable { error },
            }
        }
        Ok(_) => PlacementVerification::Mismatch,
        Err(error) if error.kind() == io::ErrorKind::NotFound => PlacementVerification::Missing,
        Err(error) => PlacementVerification::Unobservable {
            error: NativeTrashError::new("observe macOS Trash receipt", error),
        },
    }
}
