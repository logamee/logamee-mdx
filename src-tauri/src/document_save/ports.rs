//! Write and clock ports for the save coordinator.
use std::time::Instant;

use super::*;

pub(crate) trait DocumentWriter: Send + Sync {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome>;
}

pub(crate) struct DurableDocumentWriter;

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

pub(crate) trait MonotonicClock: Send + Sync {
    fn now(&self) -> Instant;
}

pub(crate) struct SystemMonotonicClock;

impl MonotonicClock for SystemMonotonicClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}
