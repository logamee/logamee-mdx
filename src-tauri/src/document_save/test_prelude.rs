//! Shared test imports for document_save test modules.
pub(super) use super::*;
pub(super) use crate::{
    path_auth::{
        authorize_directory_root_inner, authorize_workspace_file_inner,
        ensure_authorized_write_file_inner,
    },
    state::AppState,
};
pub(super) use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier,
    },
    thread,
};
pub(super) use tempfile::tempdir;
pub(super) struct FakeClock {
    pub(super) now: Mutex<Instant>,
}
impl FakeClock {
    pub(super) fn new() -> Self {
        Self {
            now: Mutex::new(Instant::now()),
        }
    }
    pub(super) fn advance(&self, duration: Duration) {
        let mut now = self.now.lock().unwrap();
        *now += duration;
    }
}
impl MonotonicClock for FakeClock {
    fn now(&self) -> Instant {
        *self.now.lock().unwrap()
    }
}
pub(super) struct CountingWriter {
    pub(super) calls: AtomicUsize,
}
pub(super) struct IndeterminateWriter {
    pub(super) calls: AtomicUsize,
}
pub(super) struct NotCommittedWriter;
pub(super) struct CommitThenRemoveWriter;
pub(super) struct CommitThenReplaceWriter;
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
pub(super) struct AuthorizationAssertingWriter;
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
    pub(super) fn new() -> Self {
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
pub(super) fn authorized_file(path: &Path) -> FileAuthorizationSession {
    let authorization = FileAuthorizationSession::default();
    authorization
        .open_standalone_file(path, |_| Ok(()), |_| Ok(()))
        .unwrap();
    authorization
}
