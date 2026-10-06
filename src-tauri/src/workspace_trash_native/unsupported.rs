//! Unsupported-platform trash stub.
use super::*;

use super::*;

pub(super) fn move_to_trash(
    _source: &Path,
    _kind: TrashEntryKind,
    _source_identity: NativeSourceIdentity,
) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
    MoveToTrash::Rejected {
        error: NativeTrashError::new("move item to trash", "platform is unsupported"),
    }
}

pub(super) fn verify_placement(
    _receipt: &NativeTrashReceipt,
) -> PlacementVerification<NativeTrashError> {
    PlacementVerification::Missing
}
