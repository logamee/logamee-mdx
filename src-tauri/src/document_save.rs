pub(crate) use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use crate::private_fs::lowercase_hex;

pub(crate) use sha2::{Digest, Sha256};

use crate::{
    durable_write::{capture_file_version, durable_write, DurableWriteOutcome, ExpectedFileState, FileVersion},
    path_auth::{
        FileAuthorizationSession, PendingSaveAuthority, SaveAuthorizationScope, SaveIdentityOrigins,
    },
};

const OVERWRITE_TOKEN_TTL: Duration = Duration::from_secs(60);
const MAX_OVERWRITE_TOKENS: usize = 128;
pub(crate) const MAIN_SAVE_OWNER: &str = "main";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct OverwriteToken(String);

impl OverwriteToken {
    pub(crate) fn from_wire(value: &str) -> Result<Self, String> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Overwrite token is malformed".into());
        }
        Ok(Self(value.to_string()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DocumentSaveDisposition {
    ConfirmedCommitted {
        version: FileVersion,
        displaced_path: Option<PathBuf>,
    },
    ConfirmedNotCommitted {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
        message: String,
    },
    Conflict {
        current_version: Option<FileVersion>,
        recovery_path: PathBuf,
        overwrite_token: Option<OverwriteToken>,
    },
    Indeterminate {
        message: String,
        recovery_paths: Vec<PathBuf>,
    },
}

impl From<DurableWriteOutcome> for DocumentSaveDisposition {
    fn from(outcome: DurableWriteOutcome) -> Self {
        match outcome {
            DurableWriteOutcome::ConfirmedCommitted {
                version,
                displaced_path,
            } => Self::ConfirmedCommitted {
                version,
                displaced_path,
            },
            DurableWriteOutcome::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
                message,
            } => Self::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
                message,
            },
            DurableWriteOutcome::Conflict {
                current_version,
                recovery_path,
            } => Self::Conflict {
                current_version,
                recovery_path,
                overwrite_token: None,
            },
            DurableWriteOutcome::Indeterminate {
                message,
                recovery_paths,
            } => Self::Indeterminate {
                message,
                recovery_paths,
            },
        }
    }
}

struct OverwriteRecord {
    destination: PathBuf,
    observed_version: FileVersion,
    intended_sha256: String,
    operation_id: String,
    expires_at: Instant,
    authorization_generation: u64,
    pending_save_as: Option<PendingSaveAuthority>,
    main_owner: bool,
}

pub(super) fn ensure_main_save_owner(owner: &str) -> Result<(), String> {
    if owner != MAIN_SAVE_OWNER {
        return Err("Document saves are owned by the main window".into());
    }
    Ok(())
}

pub(crate) struct DocumentSaveCoordinator {
    tokens: Mutex<HashMap<String, OverwriteRecord>>,
    writer: Arc<dyn DocumentWriter>,
    clock: Arc<dyn MonotonicClock>,
}

impl Default for DocumentSaveCoordinator {
    fn default() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            writer: Arc::new(DurableDocumentWriter),
            clock: Arc::new(SystemMonotonicClock),
        }
    }
}

impl DocumentSaveCoordinator {
    pub(crate) fn save_expected(
        &self,
        authorization: &FileAuthorizationSession,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        expected_version: FileVersion,
        operation_id: &str,
        owner: &str,
    ) -> Result<DocumentSaveDisposition, String> {
        self.save_expected_inner(
            authorization,
            destination.as_ref(),
            bytes,
            ExpectedFileState::Exact {
                version: expected_version,
            },
            operation_id,
            owner,
            None,
        )
    }

    pub(crate) fn save_as_expected(
        &self,
        authorization: &FileAuthorizationSession,
        pending: &PendingSaveAuthority,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
    ) -> Result<DocumentSaveDisposition, String> {
        self.save_expected_inner(
            authorization,
            destination.as_ref(),
            bytes,
            ExpectedFileState::Absent,
            operation_id,
            owner,
            Some(pending),
        )
    }

    fn save_expected_inner(
        &self,
        authorization: &FileAuthorizationSession,
        destination: &Path,
        bytes: &[u8],
        expected: ExpectedFileState,
        operation_id: &str,
        owner: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<DocumentSaveDisposition, String> {
        ensure_main_save_owner(owner)?;
        validate_operation_id(operation_id)?;
        authorization.with_save_authorization_scope(destination, |scope| {
            save_flow::require_exact_write_authority(scope, pending)?;
            if let Some(disposition) =
                self.conflict_if_destination_exists(scope, bytes, operation_id, pending)?
            {
                return Ok(disposition);
            }
            let identity_origins = scope.capture_identity_origins()?;
            let outcome = self.writer.write(scope.path(), bytes, &expected);
            if pending.is_some() {
                if let Ok(DurableWriteOutcome::Conflict {
                    current_version: Some(current_version),
                    recovery_path,
                }) = outcome
                {
                    let overwrite_token = self.insert_overwrite_token(
                        scope,
                        current_version.clone(),
                        bytes,
                        operation_id,
                        pending,
                    )?;
                    return Ok(DocumentSaveDisposition::Conflict {
                        current_version: Some(current_version),
                        recovery_path,
                        overwrite_token: Some(overwrite_token),
                    });
                }
            }
            self.finish_write(scope, pending, &identity_origins, outcome)
        })
    }

}

fn sha256(bytes: &[u8]) -> String {
    lowercase_hex(&Sha256::digest(bytes))
}

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Operation identifier must contain 1 to 128 printable ASCII bytes".into());
    }
    Ok(())
}

fn random_token_id() -> Result<String, String> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Cannot create overwrite token: {error}"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}


mod overwrite;
mod ports;
mod save_flow;

use ports::{DocumentWriter, DurableDocumentWriter, MonotonicClock, SystemMonotonicClock};


#[cfg(test)]
mod save_tests;
#[cfg(test)]
mod conflict_tests;
#[cfg(test)]
mod token_tests;
#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod retry_tests;
#[cfg(test)]
mod cancel_tests;
#[cfg(test)]
mod test_prelude;
#[cfg(test)]
mod wire_tests;
