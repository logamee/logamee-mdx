use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use crate::{
    durable_write::{
        capture_file_version, durable_write, DurableWriteOutcome, ExpectedFileState, FileVersion,
    },
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

trait DocumentWriter: Send + Sync {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome>;
}

struct DurableDocumentWriter;

impl DocumentWriter for DurableDocumentWriter {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome> {
        durable_write(destination, bytes, expected)
    }
}

trait MonotonicClock: Send + Sync {
    fn now(&self) -> Instant;
}

struct SystemMonotonicClock;

impl MonotonicClock for SystemMonotonicClock {
    fn now(&self) -> Instant {
        Instant::now()
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
        if owner != MAIN_SAVE_OWNER {
            return Err("Document saves are owned by the main window".into());
        }
        validate_operation_id(operation_id)?;
        authorization.with_save_authorization_scope(destination, |scope| {
            if let Some(pending) = pending {
                if !scope.matches_pending(pending) {
                    scope.invalidate_pending(pending);
                    return Err("Destination does not have current exact write authority".into());
                }
            } else if !scope.has_exact_write_authority() {
                return Err("Destination does not have current exact write authority".into());
            }
            if let Some(current_version) = pending
                .is_some()
                .then(|| {
                    capture_file_version(scope.path())
                        .map_err(|error| format!("Cannot observe save-as destination: {error}"))
                })
                .transpose()?
                .flatten()
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
                    recovery_path: scope.path().to_path_buf(),
                    overwrite_token: Some(overwrite_token),
                });
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

    pub(crate) fn issue_overwrite_token(
        &self,
        authorization: &FileAuthorizationSession,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<OverwriteToken, String> {
        if owner != MAIN_SAVE_OWNER {
            return Err("Document saves are owned by the main window".into());
        }
        validate_operation_id(operation_id)?;
        authorization.with_save_authorization_scope(destination, |scope| {
            if let Some(pending) = pending {
                if !scope.matches_pending(pending) {
                    scope.invalidate_pending(pending);
                    return Err("Destination does not have current exact write authority".into());
                }
            } else if !scope.has_exact_write_authority() {
                return Err("Destination does not have current exact write authority".into());
            }
            let observed_version = capture_file_version(scope.path())
                .map_err(|error| format!("Cannot observe overwrite destination: {error}"))?
                .ok_or_else(|| {
                    "Cannot issue an overwrite token for a missing destination".to_string()
                })?;
            self.insert_overwrite_token(scope, observed_version, bytes, operation_id, pending)
        })
    }

    fn insert_overwrite_token(
        &self,
        scope: &mut SaveAuthorizationScope<'_>,
        observed_version: FileVersion,
        bytes: &[u8],
        operation_id: &str,
        pending: Option<&PendingSaveAuthority>,
    ) -> Result<OverwriteToken, String> {
        let now = self.clock.now();
        let mut tokens = self
            .tokens
            .lock()
            .map_err(|_| "Overwrite token store is poisoned".to_string())?;
        let expired = tokens
            .iter()
            .filter(|(_, record)| record.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(record) = tokens.remove(&id) {
                if let Some(pending) = record.pending_save_as.as_ref() {
                    scope.invalidate_pending(pending);
                }
            }
        }
        if tokens.len() >= MAX_OVERWRITE_TOKENS {
            if let Some(oldest) = tokens
                .iter()
                .min_by_key(|(_, record)| record.expires_at)
                .map(|(id, _)| id.clone())
            {
                if let Some(record) = tokens.remove(&oldest) {
                    if let Some(pending) = record.pending_save_as.as_ref() {
                        scope.invalidate_pending(pending);
                    }
                }
            }
        }
        if pending.is_some_and(|pending| !scope.matches_pending(pending)) {
            return Err("Pending save-as authorization expired or was evicted".into());
        }
        let id = (0..8)
            .map(|_| random_token_id())
            .find_map(|candidate| match candidate {
                Ok(candidate) if !tokens.contains_key(&candidate) => Some(Ok(candidate)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .transpose()?
            .ok_or_else(|| "Cannot allocate a unique overwrite token".to_string())?;
        tokens.insert(
            id.clone(),
            OverwriteRecord {
                destination: scope.path().to_path_buf(),
                observed_version,
                intended_sha256: sha256(bytes),
                operation_id: operation_id.to_string(),
                expires_at: now + OVERWRITE_TOKEN_TTL,
                authorization_generation: scope.generation(),
                pending_save_as: pending.cloned(),
                main_owner: true,
            },
        );
        Ok(OverwriteToken(id))
    }

    pub(crate) fn cancel_overwrite_token(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        owner: &str,
    ) -> Result<(), String> {
        let record = self.take_overwrite_record(token)?;
        if let Some(pending) = record.pending_save_as.as_ref() {
            let _ = authorization.cancel_pending_save_authority(pending);
        }
        if owner != MAIN_SAVE_OWNER {
            return Err("Document saves are owned by the main window".into());
        }
        authorization.with_save_authorization_scope(destination, |scope| {
            if record.destination != scope.path() {
                return Err("Overwrite token does not match the requested destination".into());
            }
            Ok(())
        })
    }

    pub(crate) fn retry_with_token<F>(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        preflight: F,
    ) -> Result<DocumentSaveDisposition, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        self.retry_with_token_and_path(
            authorization,
            token,
            destination,
            bytes,
            operation_id,
            owner,
            preflight,
        )
        .map(|(_, disposition)| disposition)
    }

    pub(crate) fn retry_with_token_and_path<F>(
        &self,
        authorization: &FileAuthorizationSession,
        token: &OverwriteToken,
        destination: impl AsRef<Path>,
        bytes: &[u8],
        operation_id: &str,
        owner: &str,
        preflight: F,
    ) -> Result<(PathBuf, DocumentSaveDisposition), String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let record = self.take_overwrite_record(token)?;
        let pending = record.pending_save_as.clone();
        let result = (|| {
            let mismatch = record.expires_at <= self.clock.now()
                || record.intended_sha256 != sha256(bytes)
                || record.operation_id != operation_id
                || validate_operation_id(operation_id).is_err()
                || !record.main_owner
                || owner != MAIN_SAVE_OWNER;
            if mismatch {
                return Err(
                    "Overwrite token no longer matches the authorized save operation".into(),
                );
            }
            authorization.with_save_authorization_scope(destination, |scope| {
                let mismatch = record.destination != scope.path()
                    || record.authorization_generation != scope.generation()
                    || pending
                        .as_ref()
                        .is_some_and(|pending| !scope.matches_pending(pending))
                    || (pending.is_none() && !scope.has_exact_write_authority());
                if mismatch {
                    return Err(
                        "Overwrite token no longer matches the authorized save operation".into(),
                    );
                }
                preflight(scope.path())?;
                let expected = ExpectedFileState::Exact {
                    version: record.observed_version,
                };
                let path = scope.path().to_path_buf();
                let identity_origins = scope.capture_identity_origins()?;
                let outcome = self.writer.write(scope.path(), bytes, &expected);
                self.finish_write(scope, pending.as_ref(), &identity_origins, outcome)
                    .map(|disposition| (path, disposition))
            })
        })();
        if result.is_err() {
            if let Some(pending) = pending.as_ref() {
                let _ = authorization.cancel_pending_save_authority(pending);
            }
        }
        result
    }

    fn take_overwrite_record(&self, token: &OverwriteToken) -> Result<OverwriteRecord, String> {
        self.tokens
            .lock()
            .map_err(|_| "Overwrite token store is poisoned".to_string())?
            .remove(token.as_str())
            .ok_or_else(|| "Overwrite token is unknown or has already been consumed".to_string())
    }

    fn finish_write(
        &self,
        scope: &mut SaveAuthorizationScope<'_>,
        pending: Option<&PendingSaveAuthority>,
        identity_origins: &SaveIdentityOrigins,
        outcome: io::Result<DurableWriteOutcome>,
    ) -> Result<DocumentSaveDisposition, String> {
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => DurableWriteOutcome::Indeterminate {
                message: format!("The durable writer failed without a proven disposition: {error}"),
                recovery_paths: Vec::new(),
            },
        };
        match &outcome {
            DurableWriteOutcome::ConfirmedCommitted { version, .. } => {
                if let Some(pending) = pending {
                    scope.publish_pending(pending);
                }
                scope.settle_identity_origins(identity_origins, version.platform_identity());
            }
            DurableWriteOutcome::Indeterminate { .. } => {
                if let Some(pending) = pending {
                    scope.invalidate_pending(pending);
                }
            }
            DurableWriteOutcome::ConfirmedNotCommitted { .. }
            | DurableWriteOutcome::Conflict { .. } => {
                if let Some(pending) = pending {
                    scope.invalidate_pending(pending);
                }
            }
        }
        Ok(outcome.into())
    }

    #[cfg(test)]
    fn with_ports(writer: Arc<dyn DocumentWriter>, clock: Arc<dyn MonotonicClock>) -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            writer,
            clock,
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        path_auth::{
            authorize_directory_root_inner, authorize_workspace_file_inner,
            ensure_authorized_write_file_inner,
        },
        state::AppState,
    };
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
        thread,
    };
    use tempfile::tempdir;

    struct FakeClock {
        now: Mutex<Instant>,
    }

    impl FakeClock {
        fn new() -> Self {
            Self {
                now: Mutex::new(Instant::now()),
            }
        }

        fn advance(&self, duration: Duration) {
            let mut now = self.now.lock().unwrap();
            *now += duration;
        }
    }

    impl MonotonicClock for FakeClock {
        fn now(&self) -> Instant {
            *self.now.lock().unwrap()
        }
    }

    struct CountingWriter {
        calls: AtomicUsize,
    }

    struct IndeterminateWriter {
        calls: AtomicUsize,
    }

    struct NotCommittedWriter;

    struct CommitThenRemoveWriter;

    struct CommitThenReplaceWriter;

    impl DocumentWriter for NotCommittedWriter {
        fn write(
            &self,
            destination: &Path,
            _bytes: &[u8],
            _expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            Ok(DurableWriteOutcome::ConfirmedNotCommitted {
                current_version: capture_file_version(destination)?,
                recovery_paths: Vec::new(),
                message: "not committed".into(),
            })
        }
    }

    impl DocumentWriter for CommitThenRemoveWriter {
        fn write(
            &self,
            destination: &Path,
            bytes: &[u8],
            _expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            fs::write(destination, bytes)?;
            let version = capture_file_version(destination)?.unwrap();
            fs::remove_file(destination)?;
            Ok(DurableWriteOutcome::ConfirmedCommitted {
                version,
                displaced_path: None,
            })
        }
    }

    impl DocumentWriter for CommitThenReplaceWriter {
        fn write(
            &self,
            destination: &Path,
            bytes: &[u8],
            expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            let outcome = durable_write(destination, bytes, expected)?;
            let displaced = destination.with_extension("committed");
            fs::rename(destination, displaced)?;
            fs::write(destination, b"external replacement")?;
            Ok(outcome)
        }
    }

    impl DocumentWriter for IndeterminateWriter {
        fn write(
            &self,
            _destination: &Path,
            _bytes: &[u8],
            _expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("unknown mutation state"))
        }
    }

    struct AuthorizationAssertingWriter;

    impl DocumentWriter for AuthorizationAssertingWriter {
        fn write(
            &self,
            destination: &Path,
            bytes: &[u8],
            expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            crate::path_auth::lock_order_test_probe::assert_authorization_held_without_html_sites();
            durable_write(destination, bytes, expected)
        }
    }

    impl CountingWriter {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl DocumentWriter for CountingWriter {
        fn write(
            &self,
            destination: &Path,
            bytes: &[u8],
            expected: &ExpectedFileState,
        ) -> io::Result<DurableWriteOutcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            durable_write(destination, bytes, expected)
        }
    }

    fn authorized_file(path: &Path) -> FileAuthorizationSession {
        let authorization = FileAuthorizationSession::default();
        authorization
            .open_standalone_file(path, |_| Ok(()), |_| Ok(()))
            .unwrap();
        authorization
    }

    #[test]
    fn expected_exact_save_commits_and_stale_exact_conflicts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = authorized_file(&path);
        let expected = capture_file_version(&path).unwrap().unwrap();
        let coordinator = DocumentSaveCoordinator::default();
        let committed = coordinator
            .save_expected(
                &authorization,
                &path,
                b"new",
                expected.clone(),
                "op-1",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert!(matches!(
            committed,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
        let conflict = coordinator
            .save_expected(
                &authorization,
                &path,
                b"again",
                expected,
                "op-2",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
    }

    #[test]
    fn workspace_document_identity_rebinds_after_each_confirmed_save() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
        authorize_workspace_file_inner(&state, &path).unwrap();
        let authorization = state.file_authorization();
        let coordinator = DocumentSaveCoordinator::default();

        for (index, bytes) in [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .enumerate()
        {
            let expected = capture_file_version(&path).unwrap().unwrap();
            let outcome = coordinator
                .save_expected(
                    authorization,
                    &path,
                    bytes,
                    expected,
                    &format!("op-{index}"),
                    MAIN_SAVE_OWNER,
                )
                .unwrap();
            assert!(matches!(
                outcome,
                DocumentSaveDisposition::ConfirmedCommitted { .. }
            ));
        }

        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn workspace_identity_settlement_reserves_its_terminal_generation_before_writing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
        authorize_workspace_file_inner(&state, &path).unwrap();
        let authorization = state.file_authorization();
        let expected = capture_file_version(&path).unwrap().unwrap();
        authorization
            .set_authorization_generation_for_test(u64::MAX - 1)
            .unwrap();

        let outcome = DocumentSaveCoordinator::default()
            .save_expected(
                authorization,
                &path,
                b"new",
                expected,
                "generation-limit",
                MAIN_SAVE_OWNER,
            )
            .unwrap();

        assert!(matches!(
            outcome,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
        assert_eq!(authorization.authorization_generation().unwrap(), u64::MAX);
        assert_eq!(fs::read(path).unwrap(), b"new");
    }

    #[test]
    fn exhausted_workspace_identity_generation_fails_before_the_writer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
        authorize_workspace_file_inner(&state, &path).unwrap();
        let authorization = state.file_authorization();
        let expected = capture_file_version(&path).unwrap().unwrap();
        authorization
            .set_authorization_generation_for_test(u64::MAX)
            .unwrap();
        let writer = Arc::new(CountingWriter::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));

        assert!(coordinator
            .save_expected(
                authorization,
                &path,
                b"new",
                expected,
                "generation-exhausted",
                MAIN_SAVE_OWNER,
            )
            .is_err());
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(path).unwrap(), b"old");
    }

    #[test]
    fn confirmed_save_does_not_bind_authority_to_a_post_commit_replacement() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
        authorize_workspace_file_inner(&state, &path).unwrap();
        let authorization = state.file_authorization();
        let generation_before = authorization.authorization_generation().unwrap();
        let expected = capture_file_version(&path).unwrap().unwrap();
        let coordinator = DocumentSaveCoordinator::with_ports(
            Arc::new(CommitThenReplaceWriter),
            Arc::new(SystemMonotonicClock),
        );

        let outcome = coordinator
            .save_expected(
                authorization,
                &path,
                b"committed content",
                expected,
                "op-replaced",
                MAIN_SAVE_OWNER,
            )
            .unwrap();

        assert!(matches!(
            outcome,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"external replacement");
        assert!(ensure_authorized_write_file_inner(&state, &path).is_err());
        assert!(authorization.authorization_generation().unwrap() > generation_before);
    }

    #[test]
    fn pending_save_as_can_create_expected_absent_and_publishes_exact_grant() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new.md");
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let outcome = DocumentSaveCoordinator::default()
            .save_as_expected(
                &authorization,
                &pending,
                &path,
                b"new",
                "op",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert!(matches!(
            outcome,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
        assert!(authorization
            .with_exact_write_authority(&path, |_, _| Ok(()))
            .is_ok());
        assert!(!authorization
            .with_save_authorization_scope(&path, |scope| Ok(scope.matches_pending(&pending)))
            .unwrap());
    }

    #[test]
    fn save_as_absent_to_existing_race_returns_single_use_confirmation_without_writing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let writer = Arc::new(CountingWriter::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
        let conflict = coordinator
            .save_as_expected(
                &authorization,
                &pending,
                &path,
                b"new",
                "op",
                MAIN_SAVE_OWNER,
            )
            .unwrap();
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        let DocumentSaveDisposition::Conflict {
            overwrite_token: Some(token),
            ..
        } = conflict
        else {
            panic!("save-as race must return a confirmation token");
        };
        let committed = coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"new",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();
        assert!(matches!(
            committed,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"new",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .is_err());
    }

    #[test]
    fn confirmed_not_committed_invalidates_pending_authority() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let coordinator = DocumentSaveCoordinator::with_ports(
            Arc::new(NotCommittedWriter),
            Arc::new(SystemMonotonicClock),
        );
        let token = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
        let outcome = coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();
        assert!(matches!(
            outcome,
            DocumentSaveDisposition::ConfirmedNotCommitted { .. }
        ));
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op-2",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .is_err());
        assert_eq!(
            authorization
                .pending_save_authority_count_for_test()
                .unwrap(),
            0
        );
    }

    #[test]
    fn terminal_pending_transitions_are_infallible_at_generation_limit() {
        for indeterminate in [false, true] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("note.md");
            fs::write(&path, b"old").unwrap();
            let authorization = FileAuthorizationSession::default();
            authorization
                .set_authorization_generation_for_test(u64::MAX - 2)
                .unwrap();
            let pending = authorization.reserve_pending_save_authority(&path).unwrap();
            let writer: Arc<dyn DocumentWriter> = if indeterminate {
                Arc::new(IndeterminateWriter {
                    calls: AtomicUsize::new(0),
                })
            } else {
                Arc::new(CountingWriter::new())
            };
            let coordinator =
                DocumentSaveCoordinator::with_ports(writer, Arc::new(SystemMonotonicClock));
            let token = coordinator
                .issue_overwrite_token(
                    &authorization,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    Some(&pending),
                )
                .unwrap();
            let outcome = coordinator
                .retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                )
                .unwrap();
            if indeterminate {
                assert!(matches!(
                    outcome,
                    DocumentSaveDisposition::Indeterminate { .. }
                ));
            } else {
                assert!(matches!(
                    outcome,
                    DocumentSaveDisposition::ConfirmedCommitted { .. }
                ));
            }
            assert_eq!(authorization.authorization_generation().unwrap(), u64::MAX);
        }
    }

    #[test]
    fn overwrite_token_observes_fresh_version_and_is_single_use() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"v1").unwrap();
        let authorization = authorized_file(&path);
        let coordinator = DocumentSaveCoordinator::default();
        let token = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();
        fs::write(&path, b"v2").unwrap();
        let conflict = coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();
        assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
    }

    #[test]
    fn token_expires_at_exactly_sixty_seconds_and_mismatch_consumes_without_writer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"v1").unwrap();
        let authorization = authorized_file(&path);
        let clock = Arc::new(FakeClock::new());
        let writer = Arc::new(CountingWriter::new());
        let coordinator = DocumentSaveCoordinator::with_ports(writer.clone(), clock.clone());
        let token_before_boundary = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();
        clock.advance(Duration::from_secs(59));
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token_before_boundary,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_ok());
        let token = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"next",
                "op-2",
                MAIN_SAVE_OWNER,
                None,
            )
            .unwrap();
        clock.advance(Duration::from_secs(60));
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"next",
                "op-2",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
        assert_eq!(writer.calls.load(Ordering::SeqCst), 1);
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
    }

    #[test]
    fn digest_operation_owner_and_path_mismatches_each_consume_token() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let other = dir.path().join("other.md");
        fs::write(&path, b"v1").unwrap();
        fs::write(&other, b"v1").unwrap();
        let authorization = FileAuthorizationSession::default();
        authorization
            .open_standalone_file(&path, |_| Ok(()), |_| Ok(()))
            .unwrap();
        authorization
            .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
            .unwrap();
        let writer = Arc::new(CountingWriter::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
        for mismatch in 0..4 {
            let token = coordinator
                .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
                .unwrap();
            let result = match mismatch {
                0 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"different",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                1 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "other-op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                2 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    "preview",
                    |_| Ok(()),
                ),
                _ => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &other,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
            };
            assert!(result.is_err());
            assert!(coordinator
                .retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(())
                )
                .is_err());
        }
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn missing_destination_cannot_issue_overwrite_token() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new.md");
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        assert!(DocumentSaveCoordinator::default()
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                Some(&pending)
            )
            .is_err());
    }

    #[test]
    fn cancellation_consumes_token_and_invalidates_pending_save_as() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let coordinator = DocumentSaveCoordinator::default();
        let token = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
        coordinator
            .cancel_overwrite_token(&authorization, &token, &path, MAIN_SAVE_OWNER)
            .unwrap();
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .is_err());
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op-2",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .is_err());
    }

    #[test]
    fn overwrite_token_store_is_capped_and_evicts_the_oldest_token() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = authorized_file(&path);
        let clock = Arc::new(FakeClock::new());
        let writer = Arc::new(CountingWriter::new());
        let coordinator = DocumentSaveCoordinator::with_ports(writer.clone(), clock.clone());
        let mut issued = Vec::new();
        for index in 0..=MAX_OVERWRITE_TOKENS {
            issued.push(
                coordinator
                    .issue_overwrite_token(
                        &authorization,
                        &path,
                        b"ours",
                        &format!("op-{index}"),
                        MAIN_SAVE_OWNER,
                        None,
                    )
                    .unwrap(),
            );
            clock.advance(Duration::from_millis(1));
        }
        assert_eq!(
            coordinator.tokens.lock().unwrap().len(),
            MAX_OVERWRITE_TOKENS
        );
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &issued[0],
                &path,
                b"ours",
                "op-0",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .is_err());
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn invalid_operation_ids_are_rejected_before_token_insertion() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = authorized_file(&path);
        let coordinator = DocumentSaveCoordinator::default();
        for operation_id in ["", "contains space", &"x".repeat(129)] {
            assert!(coordinator
                .issue_overwrite_token(
                    &authorization,
                    &path,
                    b"ours",
                    operation_id,
                    MAIN_SAVE_OWNER,
                    None,
                )
                .is_err());
        }
        assert!(coordinator.tokens.lock().unwrap().is_empty());
    }

    #[test]
    fn invalid_operation_ids_are_rejected_by_direct_saves_before_writer_or_auth_mutation() {
        let dir = tempdir().unwrap();
        let existing = dir.path().join("existing.md");
        let new_path = dir.path().join("new.md");
        fs::write(&existing, b"old").unwrap();
        let authorization = authorized_file(&existing);
        let pending = authorization
            .reserve_pending_save_authority(&new_path)
            .unwrap();
        let generation = authorization.authorization_generation().unwrap();
        let writer = Arc::new(CountingWriter::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
        let expected = capture_file_version(&existing).unwrap().unwrap();

        assert!(coordinator
            .save_expected(
                &authorization,
                &existing,
                b"ours",
                expected,
                "contains space",
                MAIN_SAVE_OWNER,
            )
            .is_err());
        assert!(coordinator
            .save_as_expected(
                &authorization,
                &pending,
                &new_path,
                b"ours",
                "",
                MAIN_SAVE_OWNER,
            )
            .is_err());
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            authorization.authorization_generation().unwrap(),
            generation
        );
        assert!(authorization
            .with_save_authorization_scope(&new_path, |scope| Ok(scope.matches_pending(&pending)))
            .unwrap());
    }

    #[test]
    fn abandoned_pending_save_authorities_are_bounded_and_cancellable_before_token_issue() {
        let dir = tempdir().unwrap();
        let authorization = FileAuthorizationSession::default();
        let mut previous = None;
        for index in 0..256 {
            let pending = authorization
                .reserve_pending_save_authority(dir.path().join(format!("note-{index}.md")))
                .unwrap();
            assert_eq!(
                authorization
                    .pending_save_authority_count_for_test()
                    .unwrap(),
                1
            );
            if let Some(previous) = previous.replace(pending) {
                assert!(!authorization
                    .cancel_pending_save_authority(&previous)
                    .unwrap());
            }
        }
        let active = previous.unwrap();
        assert!(authorization
            .cancel_pending_save_authority(&active)
            .unwrap());
        assert_eq!(
            authorization
                .pending_save_authority_count_for_test()
                .unwrap(),
            0
        );
        assert!(!authorization
            .cancel_pending_save_authority(&active)
            .unwrap());
    }

    #[test]
    fn overwrite_token_wire_parser_accepts_only_canonical_random_id_shape() {
        let valid = "a".repeat(64);
        assert_eq!(OverwriteToken::from_wire(&valid).unwrap().as_str(), valid);
        for invalid in ["", "a", &"A".repeat(64), &"g".repeat(64), &"a".repeat(65)] {
            assert!(OverwriteToken::from_wire(invalid).is_err());
        }
    }

    #[test]
    fn expiry_and_capacity_eviction_invalidate_pending_authority() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();

        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let clock = Arc::new(FakeClock::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(Arc::new(CountingWriter::new()), clock.clone());
        let expired = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "expired",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
        clock.advance(OVERWRITE_TOKEN_TTL);
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &expired,
                &path,
                b"ours",
                "expired",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .is_err());
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "after-expiry",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .is_err());

        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let coordinator = DocumentSaveCoordinator::default();
        for index in 0..MAX_OVERWRITE_TOKENS {
            coordinator
                .issue_overwrite_token(
                    &authorization,
                    &path,
                    b"ours",
                    &format!("op-{index}"),
                    MAIN_SAVE_OWNER,
                    Some(&pending),
                )
                .unwrap();
        }
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "evict",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .is_err());
        assert_eq!(
            coordinator.tokens.lock().unwrap().len(),
            MAX_OVERWRITE_TOKENS - 1
        );
        assert!(authorization
            .with_save_authorization_scope(&path, |scope| Ok(scope.matches_pending(&pending)))
            .is_ok_and(|active| !active));
    }

    #[test]
    fn authorization_generation_mismatch_consumes_token_without_writer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let other = dir.path().join("other.md");
        fs::write(&path, b"old").unwrap();
        fs::write(&other, b"other").unwrap();
        let authorization = authorized_file(&path);
        let writer = Arc::new(CountingWriter::new());
        let coordinator =
            DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
        let token = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();
        authorization
            .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
            .unwrap();
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
        assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
    }

    #[test]
    fn pending_token_mismatches_consume_token_invalidate_authority_and_skip_writer() {
        for mismatch in 0..8 {
            let dir = tempdir().unwrap();
            let path = dir.path().join("note.md");
            let other = dir.path().join("other.md");
            fs::write(&path, b"old").unwrap();
            fs::write(&other, b"other").unwrap();
            let authorization = FileAuthorizationSession::default();
            if mismatch == 3 {
                authorization
                    .open_standalone_file(&other, |_| Ok(()), |_| Ok(()))
                    .unwrap();
            }
            let pending = authorization.reserve_pending_save_authority(&path).unwrap();
            let writer = Arc::new(CountingWriter::new());
            let coordinator =
                DocumentSaveCoordinator::with_ports(writer.clone(), Arc::new(SystemMonotonicClock));
            let token = coordinator
                .issue_overwrite_token(
                    &authorization,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    Some(&pending),
                )
                .unwrap();
            if mismatch == 7 {
                let generation = authorization.authorization_generation().unwrap();
                authorization
                    .set_authorization_generation_for_test(generation + 1)
                    .unwrap();
            }

            let result = match mismatch {
                0 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    "preview",
                    |_| Ok(()),
                ),
                1 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"different",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                2 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "other-op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                3 | 4 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &other,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                5 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    "relative.md",
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
                6 => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Err("invalid editable content".into()),
                ),
                _ => coordinator.retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                ),
            };
            assert!(result.is_err(), "mismatch case {mismatch} must fail");
            assert!(coordinator
                .retry_with_token(
                    &authorization,
                    &token,
                    &path,
                    b"ours",
                    "op",
                    MAIN_SAVE_OWNER,
                    |_| Ok(()),
                )
                .is_err());
            assert_eq!(
                authorization
                    .pending_save_authority_count_for_test()
                    .unwrap(),
                0
            );
            assert_eq!(writer.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn only_one_concurrent_retry_reaches_the_writer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = Arc::new(authorized_file(&path));
        let writer = Arc::new(CountingWriter::new());
        let coordinator = Arc::new(DocumentSaveCoordinator::with_ports(
            writer.clone(),
            Arc::new(SystemMonotonicClock),
        ));
        let token = Arc::new(
            coordinator
                .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
                .unwrap(),
        );
        let barrier = Arc::new(Barrier::new(3));
        let threads = (0..2)
            .map(|_| {
                let authorization = authorization.clone();
                let coordinator = coordinator.clone();
                let token = token.clone();
                let path = path.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    coordinator.retry_with_token(
                        &authorization,
                        &token,
                        path,
                        b"ours",
                        "op",
                        MAIN_SAVE_OWNER,
                        |_| Ok(()),
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(writer.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn conflict_and_indeterminate_retries_invalidate_pending_authority() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = FileAuthorizationSession::default();
        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let coordinator = DocumentSaveCoordinator::default();
        let token = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
        fs::write(&path, b"competitor").unwrap();
        let conflict = coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();
        assert!(matches!(conflict, DocumentSaveDisposition::Conflict { .. }));
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op-2",
                MAIN_SAVE_OWNER,
                Some(&pending)
            )
            .is_err());
        assert_eq!(
            authorization
                .pending_save_authority_count_for_test()
                .unwrap(),
            0
        );

        let pending = authorization.reserve_pending_save_authority(&path).unwrap();
        let failing = Arc::new(IndeterminateWriter {
            calls: AtomicUsize::new(0),
        });
        let coordinator =
            DocumentSaveCoordinator::with_ports(failing.clone(), Arc::new(SystemMonotonicClock));
        let token = coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op-3",
                MAIN_SAVE_OWNER,
                Some(&pending),
            )
            .unwrap();
        let outcome = coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op-3",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();
        assert!(matches!(
            outcome,
            DocumentSaveDisposition::Indeterminate { .. }
        ));
        assert_eq!(failing.calls.load(Ordering::SeqCst), 1);
        assert!(coordinator
            .issue_overwrite_token(
                &authorization,
                &path,
                b"ours",
                "op-4",
                MAIN_SAVE_OWNER,
                Some(&pending)
            )
            .is_err());
    }

    #[test]
    fn writer_runs_while_authorization_is_held_and_after_token_is_consumed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let authorization = authorized_file(&path);
        let coordinator = DocumentSaveCoordinator::with_ports(
            Arc::new(AuthorizationAssertingWriter),
            Arc::new(SystemMonotonicClock),
        );
        let token = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();
        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            coordinator.retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
        });
        assert!(result.is_ok());
        assert_eq!(
            events.first(),
            Some(&crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired)
        );
        assert_eq!(
            events.last(),
            Some(&crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased)
        );
        assert!(coordinator
            .retry_with_token(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(())
            )
            .is_err());
    }

    #[test]
    fn confirmed_retry_returns_prevalidated_path_without_post_commit_filesystem_checks() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let canonical_path = path.canonicalize().unwrap();
        let authorization = authorized_file(&path);
        let coordinator = DocumentSaveCoordinator::with_ports(
            Arc::new(CommitThenRemoveWriter),
            Arc::new(SystemMonotonicClock),
        );
        let token = coordinator
            .issue_overwrite_token(&authorization, &path, b"ours", "op", MAIN_SAVE_OWNER, None)
            .unwrap();

        let (response_path, disposition) = coordinator
            .retry_with_token_and_path(
                &authorization,
                &token,
                &path,
                b"ours",
                "op",
                MAIN_SAVE_OWNER,
                |_| Ok(()),
            )
            .unwrap();

        assert_eq!(response_path, canonical_path);
        assert!(matches!(
            disposition,
            DocumentSaveDisposition::ConfirmedCommitted { .. }
        ));
    }

    #[test]
    fn durable_outcome_mapping_preserves_all_four_dispositions() {
        let version: FileVersion = serde_json::from_value(serde_json::json!({
            "canonicalPath": "/tmp/note.md",
            "platformIdentity": "1:2",
            "length": "1",
            "modifiedNanos": "2",
            "sha256": "a".repeat(64),
        }))
        .unwrap();
        let recovery = PathBuf::from("recovery");
        let outcomes = vec![
            (
                DurableWriteOutcome::ConfirmedCommitted {
                    version: version.clone(),
                    displaced_path: Some(PathBuf::from("displaced")),
                },
                DocumentSaveDisposition::ConfirmedCommitted {
                    version: version.clone(),
                    displaced_path: Some(PathBuf::from("displaced")),
                },
            ),
            (
                DurableWriteOutcome::ConfirmedNotCommitted {
                    current_version: Some(version.clone()),
                    recovery_paths: vec![recovery.clone()],
                    message: "no".into(),
                },
                DocumentSaveDisposition::ConfirmedNotCommitted {
                    current_version: Some(version.clone()),
                    recovery_paths: vec![recovery.clone()],
                    message: "no".into(),
                },
            ),
            (
                DurableWriteOutcome::Conflict {
                    current_version: Some(version.clone()),
                    recovery_path: recovery.clone(),
                },
                DocumentSaveDisposition::Conflict {
                    current_version: Some(version.clone()),
                    recovery_path: recovery.clone(),
                    overwrite_token: None,
                },
            ),
            (
                DurableWriteOutcome::Indeterminate {
                    message: "unknown".into(),
                    recovery_paths: vec![recovery.clone()],
                },
                DocumentSaveDisposition::Indeterminate {
                    message: "unknown".into(),
                    recovery_paths: vec![recovery],
                },
            ),
        ];
        for (outcome, expected) in outcomes {
            assert_eq!(DocumentSaveDisposition::from(outcome), expected);
        }
    }
}
