//! Shared save-flow preflight: exact write authority and save-as destination
//! conflict observation. Extracted from `save_expected_inner` so the authority
//! contract has a single implementation shared by save and token issuance.
pub(crate) use super::*;

use crate::path_auth::{PendingSaveAuthority, SaveAuthorizationScope};

pub(super) fn require_exact_write_authority(
    scope: &mut SaveAuthorizationScope<'_>,
    pending: Option<&PendingSaveAuthority>,
) -> Result<(), String> {
    if let Some(pending) = pending {
        if !scope.matches_pending(pending) {
            scope.invalidate_pending(pending);
            return Err("Destination does not have current exact write authority".into());
        }
    } else if !scope.has_exact_write_authority() {
        scope.refresh_workspace_document_identity();
        if !scope.has_exact_write_authority() {
            return Err("Destination does not have current exact write authority".into());
        }
    }
    Ok(())
}

impl DocumentSaveCoordinator {
    /// Observes a save-as destination that already exists and issues the
    /// overwrite token for the resulting Conflict disposition.
    pub(super) fn conflict_if_destination_exists(
        &self,
        scope: &mut SaveAuthorizationScope<'_>,
        bytes: &[u8],
        operation_id: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<Option<DocumentSaveDisposition>, String> {
        let Some(current_version) = pending
            .is_some()
            .then(|| {
                capture_file_version(scope.path())
                    .map_err(|error| format!("Cannot observe save-as destination: {error}"))
            })
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        let overwrite_token = self.insert_overwrite_token(
            scope,
            current_version.clone(),
            bytes,
            operation_id,
            pending,
        )?;
        Ok(Some(DocumentSaveDisposition::Conflict {
            current_version: Some(current_version),
            recovery_path: scope.path().to_path_buf(),
            overwrite_token: Some(overwrite_token),
        }))
    }
}
