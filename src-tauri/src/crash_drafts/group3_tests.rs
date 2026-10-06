use super::test_prelude::*;

#[cfg(windows)]
#[test]
fn windows_private_dacl_smoke_for_directory_and_file() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("private-directory");
    fs::create_dir(&directory).unwrap();
    make_directory_private(&directory).unwrap();
    let file = directory.join("private-file");
    fs::write(&file, b"private").unwrap();
    make_file_private(&file).unwrap();
}
#[cfg(not(any(unix, windows)))]
#[test]
fn unsupported_private_acl_backend_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        make_directory_private(temp.path()).unwrap_err().kind(),
        io::ErrorKind::Unsupported
    );
    assert_eq!(
        make_file_private(&temp.path().join("draft"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::Unsupported
    );
}
#[test]
fn privacy_repair_receipt_never_classifies_live_destination_as_recovery_material() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("authoritative-draft.json");
    let error = committed_needs_repair(
        CrashDraftRepairRequired::PrivacyRepair,
        Vec::new(),
        std::slice::from_ref(&destination),
    );
    assert!(error.recovery_paths.is_empty());
    assert_eq!(
        error.repair_required,
        Some(CrashDraftRepairRequired::PrivacyRepair)
    );
    assert_opaque_receipt(error.repair_receipt.as_deref().unwrap());
    assert_serialization_hides_paths(&error, temp.path());
}
#[derive(Clone)]
struct BlockingWriter {
    inner: TestWriter,
    entered: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
}
impl DraftWritePort for BlockingWriter {
    type Version = String;

    fn observe(&self, path: &Path, max: usize) -> Result<DraftObservation<String>, String> {
        self.inner.observe(path, max)
    }

    fn persist(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: ExpectedDraftState<String>,
    ) -> DraftWriteOutcome<String> {
        if let Some(sender) = self.entered.lock().unwrap().take() {
            sender.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        self.inner.persist(path, bytes, expected)
    }

    fn remove_exact(&self, path: &Path, expected: &String) -> DraftDeleteOutcome<String> {
        self.inner.remove_exact(path, expected)
    }
}
#[test]
fn two_store_instances_serialize_on_the_filesystem_lock() {
    let temp = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer = BlockingWriter {
        inner: TestWriter::default(),
        entered: Arc::new(Mutex::new(Some(entered_tx))),
        release: Arc::new(Mutex::new(release_rx)),
    };
    let first = CrashDraftStore::new(temp.path(), writer.clone(), TestClock::new(10));
    let second = CrashDraftStore::new(temp.path(), writer, TestClock::new(10));
    let first_thread = thread::spawn(move || first.write(request(1, 1, "a")));
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let (listed_tx, listed_rx) = mpsc::channel();
    let second_thread = thread::spawn(move || listed_tx.send(second.list()).unwrap());
    assert!(listed_rx.recv_timeout(Duration::from_millis(50)).is_err());
    release_tx.send(()).unwrap();
    first_thread.join().unwrap().unwrap();
    listed_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    second_thread.join().unwrap();
}
