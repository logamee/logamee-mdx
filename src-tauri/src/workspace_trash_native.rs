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
        platform::move_to_trash(source, kind, source_identity)
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

#[cfg(unix)]
fn capture_source_identity(
    path: &Path,
    kind: TrashEntryKind,
) -> Result<NativeSourceIdentity, NativeTrashError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash source identity", error))?;
    validate_source_type(&metadata, kind)?;
    use std::os::unix::fs::MetadataExt;
    #[cfg(target_os = "linux")]
    let inode_lease = {
        use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt, sync::Arc};

        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|error| NativeTrashError::new("pin trash source identity", error))?;
        let pinned = file.metadata().map_err(|error| {
            NativeTrashError::new("inspect pinned trash source identity", error)
        })?;
        validate_source_type(&pinned, kind)?;
        if pinned.dev() != metadata.dev() || pinned.ino() != metadata.ino() {
            return Err(NativeTrashError::new(
                "pin trash source identity",
                "source changed while its filesystem identity was being retained",
            ));
        }
        LinuxInodeLease {
            _file: Arc::new(file),
        }
    };
    Ok(NativeSourceIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
        kind,
        #[cfg(target_os = "linux")]
        inode_lease,
    })
}

#[cfg(windows)]
fn capture_source_identity(
    path: &Path,
    kind: TrashEntryKind,
) -> Result<NativeSourceIdentity, NativeTrashError> {
    use std::os::windows::fs::MetadataExt;
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeTrashError::new("inspect trash source identity", error))?;
    validate_source_type(&metadata, kind)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "symbolic links and reparse points cannot be moved to Trash",
        ));
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(NativeTrashError::new(
            "open trash source identity",
            io::Error::last_os_error(),
        ));
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    let information_error = (result == 0).then(io::Error::last_os_error);
    let close_result = unsafe { CloseHandle(handle) };
    let close_error = (close_result == 0).then(io::Error::last_os_error);
    if let Some(error) = information_error {
        let message = match close_error {
            Some(close) => {
                format!("{error}; additionally failed to close identity handle: {close}")
            }
            None => error.to_string(),
        };
        return Err(NativeTrashError::new("read trash source identity", message));
    }
    if let Some(error) = close_error {
        return Err(NativeTrashError::new("close trash source identity", error));
    }
    validate_windows_handle_attributes(
        information.dwFileAttributes,
        kind,
        FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_DEVICE,
    )?;
    Ok(NativeSourceIdentity::Windows {
        volume: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        kind,
    })
}

#[cfg(windows)]
fn validate_windows_handle_attributes(
    attributes: u32,
    kind: TrashEntryKind,
    reparse_flag: u32,
    directory_flag: u32,
    device_flag: u32,
) -> Result<(), NativeTrashError> {
    if attributes & (reparse_flag | device_flag) != 0 {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "reparse points and special device objects cannot be moved to Trash",
        ));
    }
    let is_directory = attributes & directory_flag != 0;
    if is_directory != (kind == TrashEntryKind::Directory) {
        return Err(NativeTrashError::new(
            "validate trash source kind",
            "authoritative file-handle kind does not match the requested kind",
        ));
    }
    Ok(())
}

fn validate_source_type(
    metadata: &fs::Metadata,
    kind: TrashEntryKind,
) -> Result<(), NativeTrashError> {
    let file_type = metadata.file_type();
    if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
        return Err(NativeTrashError::new(
            "validate trash source identity",
            "symbolic links and special files cannot be moved to Trash",
        ));
    }
    if !verify_kind(metadata, kind) {
        return Err(NativeTrashError::new(
            "validate trash source kind",
            "source kind changed before trash operation",
        ));
    }
    Ok(())
}

fn verify_receipt_identity(receipt: &NativeTrashReceipt) -> Result<bool, NativeTrashError> {
    let metadata = fs::symlink_metadata(&receipt.destination)
        .map_err(|error| NativeTrashError::new("observe trashed entry identity", error))?;
    drop(metadata);
    Ok(capture_source_identity(&receipt.destination, receipt.kind)? == receipt.source_identity)
}

fn ensure_identity_unchanged(
    path: &Path,
    expected: &NativeSourceIdentity,
) -> Result<(), NativeTrashError> {
    if capture_source_identity(path, expected.kind())? == *expected {
        Ok(())
    } else {
        Err(NativeTrashError::new(
            "revalidate trash source identity",
            "source changed between authorization and platform mutation",
        ))
    }
}

fn verify_kind(metadata: &fs::Metadata, kind: TrashEntryKind) -> bool {
    match kind {
        TrashEntryKind::File => !metadata.file_type().is_dir(),
        TrashEntryKind::Directory => metadata.file_type().is_dir(),
    }
}

#[cfg(any(windows, test))]
fn windows_shell_parsing_name_from_wide(path: &[u16]) -> Result<Vec<u16>, &'static str> {
    // Rust canonicalization returns verbatim names; Shell expects a display name.
    const BACKSLASH: u16 = b'\\' as u16;
    const VERBATIM_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'?' as u16, BACKSLASH];
    const VERBATIM_UNC_PREFIX: [u16; 8] = [
        BACKSLASH,
        BACKSLASH,
        b'?' as u16,
        BACKSLASH,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        BACKSLASH,
    ];
    const DEVICE_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'.' as u16, BACKSLASH];

    if path.starts_with(&VERBATIM_UNC_PREFIX) {
        return Err("Windows UNC paths are not supported for Shell Trash");
    }
    if let Some(rest) = path.strip_prefix(&VERBATIM_PREFIX) {
        let drive_letter = rest.first().copied().is_some_and(|value| {
            (b'A' as u16..=b'Z' as u16).contains(&value)
                || (b'a' as u16..=b'z' as u16).contains(&value)
        });
        if drive_letter && rest.get(1) == Some(&(b':' as u16)) && rest.get(2) == Some(&BACKSLASH) {
            return Ok(rest.to_vec());
        }
        return Err("unsupported Windows verbatim path for Shell parsing");
    }
    if path.starts_with(&DEVICE_PREFIX) {
        return Err("unsupported Windows device path for Shell parsing");
    }
    if path.starts_with(&[BACKSLASH, BACKSLASH]) {
        return Err("Windows UNC paths are not supported for Shell Trash");
    }
    Ok(path.to_vec())
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn windows_shell_parsing_name_converts_a_supported_verbatim_drive_path() {
        assert_eq!(
            windows_shell_parsing_name_from_wide(&wide(
                r"\\?\C:\Users\runneradmin\AppData\Local\Temp\note.md"
            ))
            .unwrap(),
            wide(r"C:\Users\runneradmin\AppData\Local\Temp\note.md"),
        );
    }

    #[test]
    fn windows_shell_parsing_name_rejects_unc_and_device_namespaces() {
        for value in [r"C:\Users\runneradmin\AppData\Local\Temp\note.md"] {
            assert_eq!(
                windows_shell_parsing_name_from_wide(&wide(value)).unwrap(),
                wide(value),
            );
        }
        for value in [
            r"\\?\UNC\server\share\folder\note.md",
            r"\\server\share\folder\note.md",
        ] {
            assert_eq!(
                windows_shell_parsing_name_from_wide(&wide(value)),
                Err("Windows UNC paths are not supported for Shell Trash"),
            );
        }
        assert_eq!(
            windows_shell_parsing_name_from_wide(&wide(
                r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\note.md"
            )),
            Err("unsupported Windows verbatim path for Shell parsing"),
        );
        assert_eq!(
            windows_shell_parsing_name_from_wide(&wide(r"\\.\PhysicalDrive0")),
            Err("unsupported Windows device path for Shell parsing"),
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonical_verbatim_source_uses_an_equivalent_dos_shell_name() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::Component};

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "content").unwrap();
        let canonical = fs::canonicalize(&source).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));

        let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
        let shell_name = platform::shell_parsing_name(&canonical, &expected).unwrap();
        assert_eq!(shell_name.last(), Some(&0));
        let shell_path =
            std::path::PathBuf::from(OsString::from_wide(&shell_name[..shell_name.len() - 1]));
        assert!(!shell_path.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(fs::canonicalize(shell_path).unwrap(), canonical);
    }

    #[cfg(windows)]
    #[test]
    fn canonical_shell_name_rejects_a_same_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "authorized").unwrap();
        let canonical = fs::canonicalize(&source).unwrap();
        let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
        fs::remove_file(&source).unwrap();
        fs::write(&source, "replacement").unwrap();

        let error = platform::shell_parsing_name(&canonical, &expected).unwrap_err();
        assert_eq!(error.operation, "revalidate trash source identity");
        assert!(error.message.contains("source changed"));
        assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
    }

    #[cfg(windows)]
    #[test]
    fn pre_delete_identity_guard_keeps_a_replacement_unmoved_and_uncommitted() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "authorized").unwrap();
        let mut port = NativeTrashPort {
            source_identity: None,
            injected_move: Some(Box::new(|source, _, expected| {
                fs::remove_file(source).unwrap();
                fs::write(source, "replacement").unwrap();
                match platform::validate_pre_delete_identity(source, &expected) {
                    Ok(()) => panic!("same-path replacement must fail the pre-delete guard"),
                    Err(error) => MoveToTrash::Rejected { error },
                }
            })),
        };

        let classification =
            crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File);

        assert!(matches!(
            classification,
            crate::workspace_trash::TrashClassification::Indeterminate { .. }
        ));
        assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
    }

    #[test]
    fn recreated_source_is_unobservable_instead_of_present() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "first").unwrap();
        let identity = capture_source_identity(&source, TrashEntryKind::File).unwrap();
        let mut port = NativeTrashPort {
            source_identity: Some(identity),
            injected_move: None,
        };
        fs::remove_file(&source).unwrap();
        fs::write(&source, "replacement").unwrap();

        assert!(matches!(
            port.observe_source(&source),
            SourceObservation::Unobservable { .. }
        ));
    }

    #[test]
    fn destination_substitution_fails_exact_receipt_verification() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("trashed.md");
        fs::write(&destination, "original").unwrap();
        let source_identity = capture_source_identity(&destination, TrashEntryKind::File).unwrap();
        fs::remove_file(&destination).unwrap();
        fs::write(&destination, "substitute").unwrap();
        let receipt = NativeTrashReceipt {
            destination,
            kind: TrashEntryKind::File,
            source_identity,
            #[cfg(target_os = "linux")]
            trash_info: temp.path().join("unused.trashinfo"),
            #[cfg(target_os = "linux")]
            expected_trash_info: Vec::new(),
        };

        assert_eq!(verify_receipt_identity(&receipt).unwrap(), false);
    }

    #[test]
    #[cfg(unix)]
    fn rejects_symbolic_links_before_any_platform_mutation() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.md");
        let link = temp.path().join("link.md");
        fs::write(&target, "content").unwrap();
        symlink(&target, &link).unwrap();

        assert!(capture_source_identity(&link, TrashEntryKind::File).is_err());
        assert!(target.exists());
    }

    #[test]
    #[cfg(windows)]
    fn authoritative_windows_attributes_reject_reparse_device_and_kind_mismatch() {
        const REPARSE: u32 = 0x400;
        const DIRECTORY: u32 = 0x10;
        const DEVICE: u32 = 0x40;

        assert!(validate_windows_handle_attributes(
            REPARSE,
            TrashEntryKind::File,
            REPARSE,
            DIRECTORY,
            DEVICE,
        )
        .is_err());
        assert!(validate_windows_handle_attributes(
            DEVICE,
            TrashEntryKind::File,
            REPARSE,
            DIRECTORY,
            DEVICE,
        )
        .is_err());
        assert!(validate_windows_handle_attributes(
            DIRECTORY,
            TrashEntryKind::File,
            REPARSE,
            DIRECTORY,
            DEVICE,
        )
        .is_err());
        assert!(validate_windows_handle_attributes(
            DIRECTORY,
            TrashEntryKind::Directory,
            REPARSE,
            DIRECTORY,
            DEVICE,
        )
        .is_ok());
    }

    #[test]
    fn injected_unavailable_and_read_only_failures_leave_source_confirmed_not_committed() {
        for message in ["Trash unavailable", "Trash is read-only"] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("note.md");
            fs::write(&source, "content").unwrap();
            let injected_message = message.to_string();
            let mut port = NativeTrashPort {
                source_identity: None,
                injected_move: Some(Box::new(move |_, _, _| MoveToTrash::Rejected {
                    error: NativeTrashError::new("injected Trash failure", injected_message),
                })),
            };

            assert!(matches!(
                crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
                crate::workspace_trash::TrashClassification::ConfirmedNotCommitted { .. }
            ));
            assert!(source.exists());
        }
    }

    #[test]
    fn injected_post_move_error_with_receipt_is_reconciled_as_committed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        let destination = temp.path().join("trash-note.md");
        fs::write(&source, "content").unwrap();
        let destination_for_move = destination.clone();
        let mut port = NativeTrashPort {
            source_identity: None,
            injected_move: Some(Box::new(move |source, kind, source_identity| {
                fs::rename(source, &destination_for_move).unwrap();
                #[cfg(target_os = "linux")]
                let (trash_info, expected_trash_info) = {
                    let trash_info = destination_for_move.with_extension("trashinfo");
                    let expected = b"injected receipt".to_vec();
                    fs::write(&trash_info, &expected).unwrap();
                    (trash_info, expected)
                };
                MoveToTrash::PossiblyMoved {
                    recovery_receipt: Some(NativeTrashReceipt {
                        destination: destination_for_move,
                        kind,
                        source_identity,
                        #[cfg(target_os = "linux")]
                        trash_info,
                        #[cfg(target_os = "linux")]
                        expected_trash_info,
                    }),
                    error: NativeTrashError::new("injected post-move failure", "sync failed"),
                }
            })),
        };

        assert!(matches!(
            crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
            crate::workspace_trash::TrashClassification::ConfirmedCommitted { .. }
        ));
    }

    #[test]
    fn injected_post_move_error_without_receipt_stays_indeterminate() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        let destination = temp.path().join("unknown-location.md");
        fs::write(&source, "content").unwrap();
        let mut port = NativeTrashPort {
            source_identity: None,
            injected_move: Some(Box::new(move |source, _, _| {
                fs::rename(source, destination).unwrap();
                MoveToTrash::PossiblyMoved {
                    recovery_receipt: None,
                    error: NativeTrashError::new("injected post-move failure", "receipt lost"),
                }
            })),
        };

        assert!(matches!(
            crate::workspace_trash::classify_trash(&mut port, &source, TrashEntryKind::File,),
            crate::workspace_trash::TrashClassification::Indeterminate {
                recovery_receipt: None,
                ..
            }
        ));
    }

    #[test]
    #[ignore = "moves real entries through the platform Trash; opt in explicitly"]
    fn real_native_trash_round_trip_for_file_and_non_empty_directory() {
        assert_eq!(
            std::env::var_os("MMD_RUN_NATIVE_TRASH_SMOKE").as_deref(),
            Some(std::ffi::OsStr::new("1")),
            "native Trash smoke requires MMD_RUN_NATIVE_TRASH_SMOKE=1",
        );
        let temp = tempfile::Builder::new()
            .prefix("mmd-native-trash-smoke-")
            .tempdir()
            .unwrap();
        #[cfg(windows)]
        crate::crash_drafts::make_directory_private(temp.path()).unwrap();
        for (name, kind) in [
            ("smoke-file.md", TrashEntryKind::File),
            ("smoke-directory", TrashEntryKind::Directory),
        ] {
            let source = temp.path().join(name);
            match kind {
                TrashEntryKind::File => fs::write(&source, "smoke").unwrap(),
                TrashEntryKind::Directory => {
                    fs::create_dir(&source).unwrap();
                    #[cfg(windows)]
                    crate::crash_drafts::make_directory_private(&source).unwrap();
                    fs::write(source.join("child.md"), "smoke").unwrap();
                }
            }
            #[cfg(windows)]
            let trash_source = {
                use std::path::Component;

                let canonical = fs::canonicalize(&source).unwrap();
                assert!(matches!(
                    canonical.components().next(),
                    Some(Component::Prefix(prefix))
                        if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
                ));
                canonical
            };
            #[cfg(not(windows))]
            let trash_source = source.clone();
            let mut port = NativeTrashPort::default();
            let receipt =
                match crate::workspace_trash::classify_trash(&mut port, &trash_source, kind) {
                    crate::workspace_trash::TrashClassification::ConfirmedCommitted {
                        recovery_receipt,
                        warnings,
                    } => {
                        assert!(
                            warnings.is_empty(),
                            "native Trash smoke warnings: {warnings:?}"
                        );
                        recovery_receipt
                    }
                    other => panic!("native Trash smoke was not committed: {other:?}"),
                };
            fs::rename(&receipt.destination, &source).unwrap();
            #[cfg(target_os = "linux")]
            fs::remove_file(&receipt.trash_info).unwrap();
            assert!(source.exists());
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        env,
        ffi::{CString, OsStr},
        fs::{self, File, OpenOptions},
        io::{self, Write},
        os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
        path::{Path, PathBuf},
    };

    use percent_encoding::{percent_encode, AsciiSet, CONTROLS};

    use super::*;

    const TRASH_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');

    pub(super) fn move_to_trash(
        source: &Path,
        kind: TrashEntryKind,
        source_identity: NativeSourceIdentity,
    ) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
        match move_to_trash_inner(source, kind, source_identity) {
            Ok((receipt, warning)) => match warning {
                Some(error) => MoveToTrash::PossiblyMoved {
                    recovery_receipt: Some(receipt),
                    error,
                },
                None => MoveToTrash::Placed {
                    recovery_receipt: receipt,
                },
            },
            Err(error) => MoveToTrash::Rejected { error },
        }
    }

    fn move_to_trash_inner(
        source: &Path,
        kind: TrashEntryKind,
        source_identity: NativeSourceIdentity,
    ) -> Result<(NativeTrashReceipt, Option<NativeTrashError>), NativeTrashError> {
        if !source.is_absolute() {
            return Err(NativeTrashError::new(
                "validate trash source",
                "source path must be absolute",
            ));
        }
        ensure_identity_unchanged(source, &source_identity)?;

        let parent = source.parent().ok_or_else(|| {
            NativeTrashError::new("locate trash source parent", "source has no parent")
        })?;
        let source_device = match source_identity {
            NativeSourceIdentity::Unix { device, .. } => device,
        };
        let mount_root = mount_root(parent, source_device)
            .map_err(|error| NativeTrashError::new("locate source mount", error))?;
        let (trash_root, home_trash) = select_trash_root(&mount_root, source_device)?;
        let files_dir = trash_root.join("files");
        let info_dir = trash_root.join("info");
        create_private_directory(&trash_root)?;
        create_private_directory(&files_dir)?;
        create_private_directory(&info_dir)?;
        ensure_same_device(&files_dir, source_device)?;
        ensure_same_device(&info_dir, source_device)?;

        let base_name = source
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| NativeTrashError::new("name trash entry", "source has no file name"))?;
        let trash_info_path = if home_trash {
            source
        } else {
            source.strip_prefix(&mount_root).map_err(|_| {
                NativeTrashError::new(
                    "record trash recovery path",
                    "source is outside its detected mount root",
                )
            })?
        };
        let trash_info = trash_info_contents(trash_info_path)?;
        let (destination, info_path, mut info_file) =
            reserve_unique_entry(&files_dir, &info_dir, base_name)?;
        if let Err(error) = write_and_sync(&mut info_file, &trash_info) {
            drop(info_file);
            return Err(error_with_reserved_info_cleanup(
                "write trash recovery metadata",
                error,
                &info_path,
            ));
        }
        drop(info_file);

        if let Err(error) = rename_no_replace(source, &destination) {
            return Err(error_with_reserved_info_cleanup(
                "rename source into trash",
                error,
                &info_path,
            ));
        }

        let receipt = NativeTrashReceipt {
            destination,
            kind,
            trash_info: info_path,
            expected_trash_info: trash_info,
            source_identity,
        };
        let warning = sync_commit_directories(&files_dir, &info_dir)
            .err()
            .map(|error| NativeTrashError::new("sync trash placement", error));
        Ok((receipt, warning))
    }

    pub(super) fn verify_placement(
        receipt: &NativeTrashReceipt,
    ) -> PlacementVerification<NativeTrashError> {
        let metadata = match fs::symlink_metadata(&receipt.destination) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return PlacementVerification::Missing
            }
            Err(error) => {
                return PlacementVerification::Unobservable {
                    error: NativeTrashError::new("observe trashed entry", error),
                }
            }
        };
        if !verify_kind(&metadata, receipt.kind) {
            return PlacementVerification::Mismatch;
        }
        match verify_receipt_identity(receipt) {
            Ok(true) => {}
            Ok(false) => return PlacementVerification::Mismatch,
            Err(error) => return PlacementVerification::Unobservable { error },
        }
        match fs::read(&receipt.trash_info) {
            Ok(contents) if contents == receipt.expected_trash_info => {
                PlacementVerification::Proven
            }
            Ok(_) => PlacementVerification::Mismatch,
            Err(error) if error.kind() == io::ErrorKind::NotFound => PlacementVerification::Missing,
            Err(error) => PlacementVerification::Unobservable {
                error: NativeTrashError::new("read trash recovery metadata", error),
            },
        }
    }

    fn trash_info_contents(source: &Path) -> Result<Vec<u8>, NativeTrashError> {
        let encoded = percent_encode(source.as_os_str().as_bytes(), TRASH_PATH_ENCODE_SET);
        let deletion_date = deletion_date()?;
        Ok(format!("[Trash Info]\nPath={encoded}\nDeletionDate={deletion_date}\n").into_bytes())
    }

    fn deletion_date() -> Result<String, NativeTrashError> {
        let timestamp = unsafe { libc::time(std::ptr::null_mut()) };
        let mut local = unsafe { std::mem::zeroed::<libc::tm>() };
        if unsafe { libc::localtime_r(&timestamp, &mut local) }.is_null() {
            return Err(NativeTrashError::new(
                "create trash deletion timestamp",
                io::Error::last_os_error(),
            ));
        }
        Ok(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            local.tm_year + 1900,
            local.tm_mon + 1,
            local.tm_mday,
            local.tm_hour,
            local.tm_min,
            local.tm_sec
        ))
    }

    fn mount_root(start: &Path, device: u64) -> io::Result<PathBuf> {
        let mut current = start.to_path_buf();
        loop {
            let Some(parent) = current.parent() else {
                return Ok(current);
            };
            if fs::metadata(parent)?.dev() != device {
                return Ok(current);
            }
            current = parent.to_path_buf();
        }
    }

    fn select_trash_root(
        mount_root: &Path,
        source_device: u64,
    ) -> Result<(PathBuf, bool), NativeTrashError> {
        if let Some(data_home) = xdg_data_home() {
            let home_trash = data_home.join("Trash");
            if nearest_existing_device(&home_trash) == Some(source_device) {
                return Ok((home_trash, true));
            }
        }

        let uid = unsafe { libc::geteuid() };
        let shared = mount_root.join(".Trash");
        if let Ok(metadata) = fs::symlink_metadata(&shared) {
            let mode = metadata.permissions().mode();
            if metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.dev() == source_device
                && mode & libc::S_ISVTX != 0
            {
                return Ok((shared.join(uid.to_string()), false));
            }
        }
        Ok((mount_root.join(format!(".Trash-{uid}")), false))
    }

    fn xdg_data_home() -> Option<PathBuf> {
        match env::var_os("XDG_DATA_HOME") {
            Some(path) if Path::new(&path).is_absolute() => Some(path.into()),
            _ => env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")),
        }
    }

    fn nearest_existing_device(path: &Path) -> Option<u64> {
        path.ancestors()
            .find_map(|candidate| fs::metadata(candidate).ok().map(|metadata| metadata.dev()))
    }

    fn create_private_directory(path: &Path) -> Result<(), NativeTrashError> {
        fs::create_dir_all(path)
            .map_err(|error| NativeTrashError::new("create trash directory", error))?;
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| NativeTrashError::new("inspect trash directory", error))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(NativeTrashError::new(
                "validate trash directory",
                "trash directory is not a real directory",
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| NativeTrashError::new("secure trash directory", error))
    }

    fn ensure_same_device(path: &Path, expected_device: u64) -> Result<(), NativeTrashError> {
        let actual = fs::metadata(path)
            .map_err(|error| NativeTrashError::new("inspect trash filesystem", error))?
            .dev();
        if actual == expected_device {
            Ok(())
        } else {
            Err(NativeTrashError::new(
                "validate trash filesystem",
                "trash directory is on a different filesystem; copy/delete fallback is forbidden",
            ))
        }
    }

    fn reserve_unique_entry(
        files_dir: &Path,
        info_dir: &Path,
        base_name: &OsStr,
    ) -> Result<(PathBuf, PathBuf, File), NativeTrashError> {
        for suffix in 0_u32..10_000 {
            let candidate = unique_name(base_name, suffix);
            let destination = files_dir.join(&candidate);
            if fs::symlink_metadata(&destination).is_ok() {
                continue;
            }
            let mut info_name = candidate;
            info_name.push(".trashinfo");
            let info_path = info_dir.join(info_name);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&info_path)
            {
                Ok(file) => return Ok((destination, info_path, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(NativeTrashError::new(
                        "reserve trash recovery metadata",
                        error,
                    ))
                }
            }
        }
        Err(NativeTrashError::new(
            "name trash entry",
            "could not allocate a unique trash name",
        ))
    }

    fn unique_name(base_name: &OsStr, suffix: u32) -> std::ffi::OsString {
        let mut name = base_name.to_os_string();
        if suffix != 0 {
            name.push(format!(".{suffix}"));
        }
        name
    }

    fn write_and_sync(file: &mut File, contents: &[u8]) -> io::Result<()> {
        file.write_all(contents)?;
        file.sync_all()
    }

    fn error_with_reserved_info_cleanup(
        operation: &'static str,
        primary: io::Error,
        info_path: &Path,
    ) -> NativeTrashError {
        let message = match fs::remove_file(info_path) {
            Ok(()) => primary.to_string(),
            Err(cleanup) => format!(
                "{primary}; additionally failed to remove reserved recovery metadata {}: {cleanup}",
                info_path.display()
            ),
        };
        NativeTrashError::new(operation, message)
    }

    fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in source path"))?;
        let destination = CString::new(destination.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in trash path"))?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn sync_commit_directories(files_dir: &Path, info_dir: &Path) -> io::Result<()> {
        File::open(files_dir)?.sync_all()?;
        File::open(info_dir)?.sync_all()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn percent_encodes_paths_without_destroying_path_separators() {
            let contents = trash_info_contents(Path::new("/tmp/a b#c%25/文.md")).unwrap();
            let text = String::from_utf8(contents).unwrap();
            assert!(text.contains("Path=/tmp/a%20b%23c%2525/%E6%96%87.md\n"));
        }

        #[test]
        fn top_directory_trash_records_a_relative_recovery_path() {
            let mount_root = Path::new("/media/archive");
            let source = Path::new("/media/archive/docs/note.md");
            let relative = source.strip_prefix(mount_root).unwrap();
            let text = String::from_utf8(trash_info_contents(relative).unwrap()).unwrap();
            assert!(text.contains("Path=docs/note.md\n"));
            assert!(!text.contains("Path=/media/archive"));
        }

        #[test]
        fn unique_names_preserve_non_utf8_bytes() {
            let base = OsStr::from_bytes(b"note-\xff.md");
            assert_eq!(unique_name(base, 0).as_bytes(), b"note-\xff.md");
            assert_eq!(unique_name(base, 3).as_bytes(), b"note-\xff.md.3");
        }

        #[test]
        fn mount_root_stops_at_a_device_boundary() {
            let root_device = fs::metadata("/").unwrap().dev();
            assert_eq!(
                mount_root(Path::new("/"), root_device).unwrap(),
                Path::new("/")
            );
        }

        #[test]
        fn preserves_reserved_metadata_cleanup_failure_with_primary_error() {
            let temp = tempfile::tempdir().unwrap();
            let missing = temp.path().join("missing.trashinfo");
            let primary = io::Error::from_raw_os_error(libc::EXDEV);
            let primary_message = primary.to_string();
            let error =
                error_with_reserved_info_cleanup("rename source into trash", primary, &missing);

            assert!(error.message.contains(&primary_message));
            assert!(error
                .message
                .contains("failed to remove reserved recovery metadata"));
        }

        #[test]
        fn collision_reservation_keeps_existing_entry_and_uses_suffix() {
            let temp = tempfile::tempdir().unwrap();
            let files = temp.path().join("files");
            let info = temp.path().join("info");
            create_private_directory(&files).unwrap();
            create_private_directory(&info).unwrap();
            fs::write(files.join("note.md"), "existing").unwrap();
            fs::write(info.join("note.md.trashinfo"), "existing-info").unwrap();

            let (destination, info_path, _reservation) =
                reserve_unique_entry(&files, &info, OsStr::new("note.md")).unwrap();

            assert_eq!(destination.file_name().unwrap(), "note.md.1");
            assert_eq!(info_path.file_name().unwrap(), "note.md.1.trashinfo");
            assert_eq!(
                fs::read_to_string(files.join("note.md")).unwrap(),
                "existing"
            );
        }

        #[test]
        fn moves_files_and_reobserves_the_recovery_receipt() {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("note.md");
            fs::write(&source, "draft").unwrap();
            let source_identity = capture_source_identity(&source, TrashEntryKind::File).unwrap();
            let trash_root = temp.path().join("trash");
            let files = trash_root.join("files");
            let info = trash_root.join("info");
            create_private_directory(&files).unwrap();
            create_private_directory(&info).unwrap();
            let contents = trash_info_contents(&source).unwrap();
            let (destination, trash_info, mut file) =
                reserve_unique_entry(&files, &info, source.file_name().unwrap()).unwrap();
            write_and_sync(&mut file, &contents).unwrap();
            drop(file);
            rename_no_replace(&source, &destination).unwrap();
            let receipt = NativeTrashReceipt {
                destination,
                kind: TrashEntryKind::File,
                trash_info,
                expected_trash_info: contents,
                source_identity,
            };

            assert_eq!(verify_placement(&receipt), PlacementVerification::Proven);
            assert!(!source.exists());
        }

        #[test]
        fn verifies_non_empty_directories_without_copying() {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("folder");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("child.md"), "content").unwrap();
            let source_identity =
                capture_source_identity(&source, TrashEntryKind::Directory).unwrap();
            let files = temp.path().join("trash/files");
            let info = temp.path().join("trash/info");
            create_private_directory(&files).unwrap();
            create_private_directory(&info).unwrap();
            let contents = trash_info_contents(&source).unwrap();
            let (destination, trash_info, mut file) =
                reserve_unique_entry(&files, &info, source.file_name().unwrap()).unwrap();
            write_and_sync(&mut file, &contents).unwrap();
            drop(file);
            rename_no_replace(&source, &destination).unwrap();
            let receipt = NativeTrashReceipt {
                destination,
                kind: TrashEntryKind::Directory,
                trash_info,
                expected_trash_info: contents,
                source_identity,
            };

            assert_eq!(verify_placement(&receipt), PlacementVerification::Proven);
            assert!(receipt.destination.join("child.md").is_file());
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{
        ffi::{CStr, CString},
        io,
        os::unix::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
        ptr::NonNull,
    };

    use objc2_foundation::{NSFileManager, NSURL};

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
}

#[cfg(windows)]
mod platform {
    use std::{
        ffi::OsString,
        io,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
        sync::{Arc, Mutex},
        thread,
    };

    use windows::{
        core::{implement, Ref, Result as WinResult, HRESULT, PCWSTR},
        Win32::{
            Foundation::{E_ABORT, E_FAIL},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IFileOperationProgressSink,
                IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI,
                FOF_SILENT, SIGDN_FILESYSPATH,
            },
        },
    };

    use super::*;

    pub(super) fn shell_parsing_name(
        source: &Path,
        expected_identity: &NativeSourceIdentity,
    ) -> Result<Vec<u16>, NativeTrashError> {
        if !source.is_absolute() {
            return Err(NativeTrashError::new(
                "prepare Windows shell item path",
                "Trash source path must be absolute",
            ));
        }
        let source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
        let shell_wide = windows_shell_parsing_name_from_wide(&source_wide)
            .map_err(|error| NativeTrashError::new("prepare Windows shell item path", error))?;
        let shell_source = PathBuf::from(OsString::from_wide(&shell_wide));
        let canonical_source = fs::canonicalize(source).map_err(|error| {
            NativeTrashError::new("revalidate Windows shell item source", error)
        })?;
        let canonical_shell_source = fs::canonicalize(&shell_source).map_err(|error| {
            NativeTrashError::new("revalidate Windows shell parsing path", error)
        })?;
        if canonical_shell_source != canonical_source {
            return Err(NativeTrashError::new(
                "revalidate Windows shell parsing path",
                "Shell path does not resolve to the authorized source",
            ));
        }
        ensure_identity_unchanged(&canonical_shell_source, expected_identity)?;

        let mut terminated = shell_wide;
        terminated.push(0);
        Ok(terminated)
    }

    #[derive(Default)]
    struct SinkState {
        destination: Option<PathBuf>,
        post_delete_error: Option<String>,
    }

    impl SinkState {
        fn record_error(&mut self, error: impl fmt::Display) {
            let error = error.to_string();
            self.post_delete_error = Some(match self.post_delete_error.take() {
                Some(existing) => format!("{existing}; {error}"),
                None => error,
            });
        }
    }

    #[implement(IFileOperationProgressSink)]
    struct ProgressSink {
        state: Arc<Mutex<SinkState>>,
        expected_source_identity: NativeSourceIdentity,
    }

    pub(super) fn validate_pre_delete_identity(
        item_path: &Path,
        expected_identity: &NativeSourceIdentity,
    ) -> Result<(), NativeTrashError> {
        ensure_identity_unchanged(item_path, expected_identity)
    }

    fn record_pre_delete_validation(
        state: &Arc<Mutex<SinkState>>,
        validation: Result<(), NativeTrashError>,
    ) -> WinResult<()> {
        match validation {
            Ok(()) => Ok(()),
            Err(error) => {
                state
                    .lock()
                    .map_err(|_| windows::core::Error::from(E_FAIL))?
                    .record_error(error);
                Err(windows::core::Error::from(E_ABORT))
            }
        }
    }

    fn operation_error_with_sink_detail(
        operation: &'static str,
        error: impl fmt::Display,
        state: &Arc<Mutex<SinkState>>,
    ) -> NativeTrashError {
        let mut message = error.to_string();
        if let Some(callback_error) = state
            .lock()
            .ok()
            .and_then(|state| state.post_delete_error.clone())
        {
            message.push_str("; pre-delete validation: ");
            message.push_str(&callback_error);
        }
        NativeTrashError::new(operation, message)
    }

    #[allow(non_snake_case)]
    impl IFileOperationProgressSink_Impl for ProgressSink_Impl {
        fn StartOperations(&self) -> WinResult<()> {
            Ok(())
        }
        fn FinishOperations(&self, result: HRESULT) -> WinResult<()> {
            if result.is_err() {
                self.state
                    .lock()
                    .map_err(|_| windows::core::Error::from(E_FAIL))?
                    .record_error(format!("FinishOperations failed: {result:?}"));
            }
            Ok(())
        }
        fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PostCopyItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, _: u32, item: Ref<'_, IShellItem>) -> WinResult<()> {
            let validation = match item.as_ref() {
                Some(item) => unsafe { shell_item_path(item) }
                    .map_err(|error| {
                        NativeTrashError::new("resolve Windows shell item before deletion", error)
                    })
                    .and_then(|item_path| {
                        validate_pre_delete_identity(&item_path, &self.expected_source_identity)
                    }),
                None => Err(NativeTrashError::new(
                    "resolve Windows shell item before deletion",
                    "Shell did not provide the item queued for deletion",
                )),
            };
            record_pre_delete_validation(&self.state, validation)
        }
        fn PostDeleteItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            result: HRESULT,
            recycled: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            let mut state = self
                .state
                .lock()
                .map_err(|_| windows::core::Error::from(E_FAIL))?;
            if result.is_err() {
                state.record_error(format!("PostDeleteItem failed: {result:?}"));
            }
            if let Some(recycled) = recycled.as_ref() {
                match unsafe { shell_item_path(recycled) } {
                    Ok(path) => state.destination = Some(path),
                    Err(error) => state.record_error(error),
                }
            } else if state.post_delete_error.is_none() {
                state.record_error("PostDeleteItem returned no recycled item");
            }
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: &PCWSTR,
            _: u32,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> WinResult<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> WinResult<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> WinResult<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> WinResult<()> {
            Ok(())
        }
    }

    pub(super) fn move_to_trash(
        source: &Path,
        kind: TrashEntryKind,
        source_identity: NativeSourceIdentity,
    ) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
        let source = source.to_path_buf();
        let result =
            match thread::spawn(move || unsafe { move_on_sta(source, kind, source_identity) })
                .join()
            {
                Ok(result) => result,
                Err(_) => MoveToTrash::Rejected {
                    error: NativeTrashError::new(
                        "start Windows Trash operation",
                        "STA thread panicked",
                    ),
                },
            };
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

    unsafe fn move_on_sta(
        source: PathBuf,
        kind: TrashEntryKind,
        source_identity: NativeSourceIdentity,
    ) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
        if let Err(error) = ensure_identity_unchanged(&source, &source_identity) {
            return MoveToTrash::Rejected { error };
        }
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() {
            return MoveToTrash::Rejected {
                error: NativeTrashError::new(
                    "initialize Windows Trash STA",
                    format!("{initialized:?}"),
                ),
            };
        }
        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _guard = ComGuard;
        let path = match shell_parsing_name(&source, &source_identity) {
            Ok(path) => path,
            Err(error) => return MoveToTrash::Rejected { error },
        };
        let item: IShellItem = match SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) {
            Ok(item) => item,
            Err(error) => {
                return MoveToTrash::Rejected {
                    error: NativeTrashError::new("open Windows shell item", error),
                }
            }
        };
        let operation: IFileOperation =
            match CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) {
                Ok(operation) => operation,
                Err(error) => {
                    return MoveToTrash::Rejected {
                        error: NativeTrashError::new("create Windows Trash operation", error),
                    }
                }
            };
        let flags = FOFX_RECYCLEONDELETE
            | FOFX_EARLYFAILURE
            | FOF_NOCONFIRMATION
            | FOF_NOERRORUI
            | FOF_SILENT;
        if let Err(error) = operation.SetOperationFlags(flags) {
            return MoveToTrash::Rejected {
                error: NativeTrashError::new("configure Windows Trash operation", error),
            };
        }
        let state = Arc::new(Mutex::new(SinkState::default()));
        let sink: IFileOperationProgressSink = ProgressSink {
            state: Arc::clone(&state),
            expected_source_identity: source_identity.clone(),
        }
        .into();
        if let Err(error) = operation.DeleteItem(&item, &sink) {
            return MoveToTrash::Rejected {
                error: NativeTrashError::new("queue Windows Trash operation", error),
            };
        }
        if let Err(error) = operation.PerformOperations() {
            return MoveToTrash::PossiblyMoved {
                recovery_receipt: receipt_from_state(&state, kind, &source_identity),
                error: operation_error_with_sink_detail(
                    "perform Windows Trash operation",
                    error,
                    &state,
                ),
            };
        }
        match operation.GetAnyOperationsAborted() {
            Ok(aborted) if aborted.as_bool() => {
                return MoveToTrash::PossiblyMoved {
                    recovery_receipt: receipt_from_state(&state, kind, &source_identity),
                    error: operation_error_with_sink_detail(
                        "perform Windows Trash operation",
                        "operation was aborted",
                        &state,
                    ),
                }
            }
            Err(error) => {
                return MoveToTrash::PossiblyMoved {
                    recovery_receipt: receipt_from_state(&state, kind, &source_identity),
                    error: operation_error_with_sink_detail(
                        "inspect Windows Trash completion",
                        error,
                        &state,
                    ),
                }
            }
            _ => {}
        }
        let state = match state.lock() {
            Ok(state) => state,
            Err(_) => {
                return MoveToTrash::PossiblyMoved {
                    recovery_receipt: None,
                    error: NativeTrashError::new(
                        "obtain Windows recycle-bin receipt",
                        "progress sink state was unavailable",
                    ),
                }
            }
        };
        match (&state.destination, &state.post_delete_error) {
            (Some(destination), None) => MoveToTrash::Placed {
                recovery_receipt: NativeTrashReceipt {
                    destination: destination.clone(),
                    kind,
                    source_identity,
                },
            },
            (destination, error) => MoveToTrash::PossiblyMoved {
                recovery_receipt: destination.as_ref().map(|destination| NativeTrashReceipt {
                    destination: destination.clone(),
                    kind,
                    source_identity: source_identity.clone(),
                }),
                error: NativeTrashError::new(
                    "obtain Windows recycle-bin receipt",
                    error.as_deref().unwrap_or("no recycled item was reported"),
                ),
            },
        }
    }

    fn receipt_from_state(
        state: &Arc<Mutex<SinkState>>,
        kind: TrashEntryKind,
        source_identity: &NativeSourceIdentity,
    ) -> Option<NativeTrashReceipt> {
        state
            .lock()
            .ok()
            .and_then(|state| state.destination.clone())
            .map(|destination| NativeTrashReceipt {
                destination,
                kind,
                source_identity: source_identity.clone(),
            })
    }

    unsafe fn shell_item_path(item: &IShellItem) -> WinResult<PathBuf> {
        let value = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = value.to_string();
        CoTaskMemFree(Some(value.0.cast()));
        Ok(PathBuf::from(path?))
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
                error: NativeTrashError::new("observe Windows recycle-bin receipt", error),
            },
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pre_delete_callback_aborts_a_replacement_and_retains_its_reason() {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("note.md");
            fs::write(&source, "authorized").unwrap();
            let canonical = fs::canonicalize(&source).unwrap();
            let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
            let source_for_callback = source.clone();
            let (code, recorded, propagated) = thread::spawn(move || unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
                struct TestComGuard;
                impl Drop for TestComGuard {
                    fn drop(&mut self) {
                        unsafe { CoUninitialize() }
                    }
                }
                let _guard = TestComGuard;
                let shell_name = shell_parsing_name(&canonical, &expected).unwrap();
                let item: IShellItem =
                    SHCreateItemFromParsingName(PCWSTR(shell_name.as_ptr()), None).unwrap();
                fs::remove_file(&source_for_callback).unwrap();
                fs::write(&source_for_callback, "replacement").unwrap();
                let state = Arc::new(Mutex::new(SinkState::default()));
                let sink: IFileOperationProgressSink = ProgressSink {
                    state: Arc::clone(&state),
                    expected_source_identity: expected,
                }
                .into();

                let error = sink.PreDeleteItem(0, &item).unwrap_err();
                let recorded = state.lock().unwrap().post_delete_error.clone().unwrap();
                let propagated = operation_error_with_sink_detail(
                    "perform Windows Trash operation",
                    "operation was aborted",
                    &state,
                );
                (error.code(), recorded, propagated)
            })
            .join()
            .unwrap();

            assert_eq!(code, E_ABORT);
            assert!(recorded.contains("source changed"));
            assert!(propagated.message.contains(&recorded));
            assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
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
}
