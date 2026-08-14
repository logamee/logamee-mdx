use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

const STAGING_ATTEMPTS: usize = 32;
static DURABLE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersion {
    canonical_path: String,
    platform_identity: String,
    #[serde(serialize_with = "serialize_decimal")]
    length: u64,
    #[serde(serialize_with = "serialize_decimal")]
    modified_nanos: u128,
    sha256: String,
    #[serde(skip)]
    file_binding: Option<Arc<File>>,
}

impl PartialEq for FileVersion {
    fn eq(&self, other: &Self) -> bool {
        self.canonical_path == other.canonical_path
            && self.platform_identity == other.platform_identity
            && self.length == other.length
            && self.modified_nanos == other.modified_nanos
            && self.sha256 == other.sha256
    }
}

impl Eq for FileVersion {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileVersionWire {
    canonical_path: String,
    platform_identity: String,
    length: String,
    modified_nanos: String,
    sha256: String,
}

impl<'de> Deserialize<'de> for FileVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = FileVersionWire::deserialize(deserializer)?;
        if wire.canonical_path.is_empty() {
            return Err(D::Error::custom("canonicalPath must not be empty"));
        }
        if wire.platform_identity.is_empty() {
            return Err(D::Error::custom("platformIdentity must not be empty"));
        }
        if wire.sha256.len() != 64
            || !wire
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(D::Error::custom(
                "sha256 must contain exactly 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self {
            canonical_path: wire.canonical_path,
            platform_identity: wire.platform_identity,
            length: parse_decimal(&wire.length).map_err(D::Error::custom)?,
            modified_nanos: parse_decimal(&wire.modified_nanos).map_err(D::Error::custom)?,
            sha256: wire.sha256,
            file_binding: None,
        })
    }
}

fn serialize_decimal<T: ToString, S: Serializer>(
    value: &T,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

fn parse_decimal<T>(value: &str) -> Result<T, &'static str>
where
    T: std::str::FromStr,
{
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("decimal integers must use canonical unsigned digit strings");
    }
    value
        .parse()
        .map_err(|_| "decimal integer is outside the supported range")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ExpectedFileState {
    Absent,
    Exact { version: FileVersion },
}

impl ExpectedFileState {
    fn version(&self) -> Option<&FileVersion> {
        match self {
            Self::Absent => None,
            Self::Exact { version } => Some(version),
        }
    }
}

#[derive(Debug)]
pub(crate) struct VersionedFileBytes {
    pub(crate) bytes: Vec<u8>,
    pub(crate) version: FileVersion,
}

impl FileVersion {
    fn is_displaced_version_of(&self, expected: &Self) -> bool {
        self.platform_identity == expected.platform_identity
            && self.length == expected.length
            && self.modified_nanos == expected.modified_nanos
            && self.sha256 == expected.sha256
    }

    pub(crate) fn length(&self) -> u64 {
        self.length
    }

    pub(crate) fn platform_identity(&self) -> &str {
        &self.platform_identity
    }

    pub(crate) fn retained_file_binding(&self) -> Option<Arc<File>> {
        self.file_binding.clone()
    }

    pub(crate) fn opaque_token(&self) -> String {
        let mut digest = Sha256::new();
        let length = self.length.to_string();
        let modified_nanos = self.modified_nanos.to_string();
        for field in [
            self.canonical_path.as_bytes(),
            self.platform_identity.as_bytes(),
            length.as_bytes(),
            modified_nanos.as_bytes(),
            self.sha256.as_bytes(),
        ] {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field);
        }
        format!("{:x}", digest.finalize())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DurableDeleteOutcome {
    ConfirmedDeleted,
    ConfirmedNotDeleted {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}

pub(crate) fn durable_remove_exact(
    destination: &Path,
    expected: &FileVersion,
) -> DurableDeleteOutcome {
    durable_remove_exact_with_hooks(destination, expected, || {}, |_| {})
}

#[cfg(test)]
fn durable_remove_exact_with_hook(
    destination: &Path,
    expected: &FileVersion,
    at_mutation_boundary: impl FnOnce(),
) -> DurableDeleteOutcome {
    durable_remove_exact_with_hooks(destination, expected, at_mutation_boundary, |_| {})
}

fn durable_remove_exact_with_hooks(
    destination: &Path,
    expected: &FileVersion,
    at_mutation_boundary: impl FnOnce(),
    before_final_unlink: impl FnOnce(&Path),
) -> DurableDeleteOutcome {
    let _guard = match DURABLE_WRITE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            }
        }
    };
    let current = match capture_file_version(destination) {
        Ok(current) => current,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            }
        }
    };
    let Some(current) = current else {
        return DurableDeleteOutcome::ConfirmedNotDeleted {
            current_version: None,
            recovery_paths: Vec::new(),
        };
    };
    if current != *expected {
        return DurableDeleteOutcome::Conflict {
            current_version: Some(current),
            recovery_paths: Vec::new(),
        };
    }
    let quarantine = match collision_safe_quarantine_path(destination) {
        Ok(path) => path,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            }
        }
    };
    at_mutation_boundary();
    if atomic_move_no_replace(destination, &quarantine).is_err() {
        return match capture_file_version(destination) {
            Ok(current_version) if current_version.as_ref() != Some(expected) => {
                DurableDeleteOutcome::Conflict {
                    current_version,
                    recovery_paths: Vec::new(),
                }
            }
            Ok(current_version) => DurableDeleteOutcome::ConfirmedNotDeleted {
                current_version,
                recovery_paths: Vec::new(),
            },
            Err(_) => DurableDeleteOutcome::Indeterminate {
                recovery_paths: Vec::new(),
            },
        };
    }
    let Some(parent) = destination.parent() else {
        return DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        };
    };
    if sync_parent_directory_if_required(parent).is_err() {
        return DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        };
    }
    let quarantined = match capture_file_version(&quarantine) {
        Ok(version) => version,
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: vec![quarantine],
            }
        }
    };
    if !quarantined
        .as_ref()
        .is_some_and(|version| version.is_displaced_version_of(expected))
    {
        let current_version = capture_file_version(destination).ok().flatten();
        if current_version.is_none() && atomic_move_no_replace(&quarantine, destination).is_ok() {
            if sync_parent_directory_if_required(parent).is_err() {
                return DurableDeleteOutcome::Indeterminate {
                    recovery_paths: vec![quarantine],
                };
            }
            return DurableDeleteOutcome::Conflict {
                current_version: capture_file_version(destination).ok().flatten(),
                recovery_paths: Vec::new(),
            };
        }
        return DurableDeleteOutcome::Conflict {
            current_version,
            recovery_paths: vec![quarantine],
        };
    }
    before_final_unlink(&quarantine);
    match delete_quarantine_exact(&quarantine, expected) {
        Ok(true) => {}
        Ok(false) => {
            return DurableDeleteOutcome::Conflict {
                current_version: capture_file_version(destination).ok().flatten(),
                recovery_paths: vec![quarantine],
            }
        }
        Err(_) => {
            return DurableDeleteOutcome::Indeterminate {
                recovery_paths: vec![quarantine],
            }
        }
    }
    match sync_parent_directory_if_required(parent) {
        Ok(()) => DurableDeleteOutcome::ConfirmedDeleted,
        Err(_) => DurableDeleteOutcome::Indeterminate {
            recovery_paths: vec![quarantine],
        },
    }
}

#[cfg(unix)]
fn verified_open_file(path: &Path, expected: &FileVersion) -> io::Result<Option<File>> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    Ok(file_matches_version(&mut file, expected)?.then_some(file))
}

fn file_matches_version(file: &mut File, expected: &FileVersion) -> io::Result<bool> {
    let metadata = file.metadata()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    file.seek(SeekFrom::Start(0))?;
    let matches = file_platform_identity(file)? == expected.platform_identity
        && metadata.len() == expected.length
        && modified_nanos == expected.modified_nanos
        && format!("{:x}", Sha256::digest(&bytes)) == expected.sha256;
    Ok(matches)
}

#[cfg(unix)]
fn delete_quarantine_exact(path: &Path, expected: &FileVersion) -> io::Result<bool> {
    let Some(file) = verified_open_file(path, expected)? else {
        return Ok(false);
    };
    let handle_identity = file_platform_identity(&file)?;
    let path_metadata = fs::symlink_metadata(path)?;
    if path_metadata.file_type().is_symlink() || path_platform_identity(path)? != handle_identity {
        return Ok(false);
    }
    // POSIX has no unlink-by-handle operation. This final name removal is therefore
    // guaranteed only against cooperating mdx instances, which share DURABLE_WRITE_LOCK
    // and the crash-store filesystem lock. Any namespace change observed before this
    // point fails closed and leaves the random private quarantine as recovery evidence.
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(windows)]
fn delete_quarantine_exact(path: &Path, expected: &FileVersion) -> io::Result<bool> {
    use std::{
        mem,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FileDispositionInfoEx, SetFileInformationByHandle, FILE_ATTRIBUTE_NORMAL,
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };
    const DELETE_ACCESS: u32 = 0x0001_0000;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | DELETE_ACCESS,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_handle(handle.cast()) };
    if !file_matches_version(&mut file, expected)? {
        return Ok(false);
    }
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileDispositionInfoEx,
            (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(true)
    }
}

#[cfg(not(any(unix, windows)))]
fn delete_quarantine_exact(_path: &Path, _expected: &FileVersion) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no exact quarantine delete primitive",
    ))
}

fn collision_safe_quarantine_path(destination: &Path) -> io::Result<PathBuf> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("draft");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = destination.with_file_name(format!(".{file_name}.delete-{suffix}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate quarantine path",
    ))
}

#[cfg(target_os = "linux")]
fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
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

#[cfg(target_os = "macos")]
fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn atomic_move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let result = unsafe { MoveFileExW(wide(source).as_ptr(), wide(destination).as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn atomic_move_no_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no audited quarantine primitive",
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DurableWriteOutcome {
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
    },
    Indeterminate {
        message: String,
        recovery_paths: Vec<PathBuf>,
    },
}

pub(crate) fn capture_file_version(path: &Path) -> io::Result<Option<FileVersion>> {
    observe_open_file(path, None).map(|observed| observed.map(|observed| observed.version))
}

fn capture_committed_file_version(path: &Path) -> io::Result<Option<FileVersion>> {
    observe_open_file_with_binding(path, None)
        .map(|observed| observed.map(|observed| observed.version))
}

pub(crate) fn read_versioned_file(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<VersionedFileBytes>> {
    read_versioned_file_with_hook(path, max_bytes, || {})
}

pub(crate) fn read_versioned_open_file(
    mut file: File,
    canonical_path: &Path,
    max_bytes: usize,
) -> io::Result<VersionedFileBytes> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "open source must be a regular file",
        ));
    }
    let observed_identity = file_platform_identity(&file)?;
    file.seek(SeekFrom::Start(0))?;
    let sentinel_limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(sentinel_limit)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "file exceeds the bounded read limit",
        ));
    }
    let metadata_after = file.metadata()?;
    if file_platform_identity(&file)? != observed_identity
        || metadata.len() != metadata_after.len()
        || metadata.modified().ok() != metadata_after.modified().ok()
        || metadata.len() != bytes.len() as u64
    {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed while it was being read",
        ));
    }
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Ok(VersionedFileBytes {
        version: FileVersion {
            canonical_path: canonical_path.to_string_lossy().into_owned(),
            platform_identity: observed_identity,
            length: metadata.len(),
            modified_nanos,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            file_binding: None,
        },
        bytes,
    })
}

pub(crate) fn observe_versioned_file(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<VersionedFileBytes>> {
    let first = match capture_file_version(path)? {
        Some(version) => version,
        None => return Ok(None),
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "file disappeared during bounded observation",
            ));
        }
        Err(error) => return Err(error),
    };
    let sentinel_limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(sentinel_limit)
        .read_to_end(&mut bytes)?;
    let second = capture_file_version(path)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "file disappeared during bounded observation",
        )
    })?;
    if first != second {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed during bounded observation",
        ));
    }
    Ok(Some(VersionedFileBytes {
        bytes,
        version: second,
    }))
}

fn read_versioned_file_with_hook(
    path: &Path,
    max_bytes: usize,
    between_observations: impl FnOnce(),
) -> io::Result<Option<VersionedFileBytes>> {
    let first = match observe_open_file(path, Some(max_bytes))? {
        Some(observed) => observed,
        None => return Ok(None),
    };
    between_observations();
    let second = observe_open_file(path, Some(max_bytes))?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "file disappeared during stable observation",
        )
    })?;
    if first.version != second.version || first.bytes != second.bytes {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed during stable observation",
        ));
    }
    Ok(Some(second))
}

fn observe_open_file(
    path: &Path,
    max_bytes: Option<usize>,
) -> io::Result<Option<VersionedFileBytes>> {
    observe_open_file_inner(path, max_bytes, false)
}

fn observe_open_file_with_binding(
    path: &Path,
    max_bytes: Option<usize>,
) -> io::Result<Option<VersionedFileBytes>> {
    observe_open_file_inner(path, max_bytes, true)
}

fn observe_open_file_inner(
    path: &Path,
    max_bytes: Option<usize>,
    retain_file_binding: bool,
) -> io::Result<Option<VersionedFileBytes>> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !path_metadata.file_type().is_file() || path_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    let mut file = match open_observation_file(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    let observed_identity = file_platform_identity(&file)?;
    if path_platform_identity(path)? != observed_identity {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file identity changed while it was being opened",
        ));
    }

    let canonical_path = fs::canonicalize(path)?.to_string_lossy().into_owned();
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut bytes = Vec::new();
    match max_bytes {
        Some(max_bytes) => {
            let sentinel_limit = u64::try_from(max_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1);
            Read::by_ref(&mut file)
                .take(sentinel_limit)
                .read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::FileTooLarge,
                    "file exceeds the bounded read limit",
                ));
            }
        }
        None => {
            file.read_to_end(&mut bytes)?;
        }
    }
    let metadata_after = file.metadata()?;
    let path_metadata_after = fs::symlink_metadata(path)?;
    if file_platform_identity(&file)? != observed_identity
        || path_metadata_after.file_type().is_symlink()
        || path_platform_identity(path)? != observed_identity
        || metadata.len() != metadata_after.len()
        || metadata.modified().ok() != metadata_after.modified().ok()
        || metadata.len() != bytes.len() as u64
    {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed while it was being read",
        ));
    }

    Ok(Some(VersionedFileBytes {
        version: FileVersion {
            canonical_path,
            platform_identity: observed_identity,
            length: metadata.len(),
            modified_nanos,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            file_binding: retain_file_binding.then(|| Arc::new(file)),
        },
        bytes,
    }))
}

#[cfg(windows)]
fn open_observation_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(not(windows))]
fn open_observation_file(path: &Path) -> io::Result<File> {
    File::open(path)
}

#[cfg(unix)]
fn file_platform_identity(file: &File) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_platform_identity(file: &File) -> io::Result<String> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let result = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok(format!("{}:{file_index}", information.dwVolumeSerialNumber))
}

#[cfg(not(any(unix, windows)))]
fn file_platform_identity(_file: &File) -> io::Result<String> {
    Ok("unavailable".to_string())
}

#[cfg(windows)]
fn path_platform_identity(path: &Path) -> io::Result<String> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    file_platform_identity(&file)
}

#[cfg(not(windows))]
fn path_platform_identity(path: &Path) -> io::Result<String> {
    file_platform_identity(&File::open(path)?)
}

pub(crate) fn durable_write(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner(destination, bytes, expected, None)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DurableWriteFault {
    TempCreate,
    PartialWrite,
    Write,
    Flush,
    Metadata,
    Sync,
    Replace,
    BackupSucceededReplaceFailed,
    ReplacementSucceededBackupUnknown,
    UnsupportedReplace,
    Observe,
    CreationObserve,
    DisplacedObserve,
    ParentSync,
    CommittedBindingObserve,
}

fn durable_write_inner(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_hooks(destination, bytes, expected, fault, || {}, || {})
}

#[cfg(test)]
fn durable_write_inner_with_hook(
    destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_hooks(destination, bytes, expected, fault, before_replace, || {})
}

fn durable_write_inner_with_hooks(
    requested_destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    durable_write_inner_with_all_hooks(
        requested_destination,
        bytes,
        expected,
        fault,
        before_replace,
        || {},
        after_replace,
    )
}

fn durable_write_inner_with_all_hooks(
    requested_destination: &Path,
    bytes: &[u8],
    expected: &ExpectedFileState,
    fault: Option<DurableWriteFault>,
    before_replace: impl FnOnce(),
    at_mutation_boundary: impl FnOnce(),
    after_replace: impl FnOnce(),
) -> io::Result<DurableWriteOutcome> {
    let _write_guard = DURABLE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let requested_parent = requested_destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    fs::create_dir_all(requested_parent)?;
    let parent = fs::canonicalize(requested_parent)?;
    let destination = parent.join(requested_destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?);
    let parent_identity = capture_directory_identity(&parent)?;
    if fault == Some(DurableWriteFault::TempCreate) {
        return Err(io::Error::other("injected staged creation failure"));
    }
    let (staged_path, mut staged_file) = create_named_temp(&destination, "tmp")?;
    if fault == Some(DurableWriteFault::Write) {
        return Err(io::Error::other("injected staged write failure"));
    }
    if fault == Some(DurableWriteFault::PartialWrite) {
        staged_file.write_all(&bytes[..bytes.len() / 2])?;
        return Err(io::Error::other("injected partial staged write failure"));
    }
    staged_file.write_all(bytes)?;
    if fault == Some(DurableWriteFault::Flush) {
        return Err(io::Error::other("injected staged flush failure"));
    }
    staged_file.flush()?;
    if fault == Some(DurableWriteFault::Metadata) {
        return Err(io::Error::other("injected metadata copy failure"));
    }
    copy_destination_permissions(&destination, &staged_path, expected)?;
    if fault == Some(DurableWriteFault::Sync) {
        return Err(io::Error::other("injected staged sync failure"));
    }
    staged_file.sync_all()?;
    let staged_version = capture_file_version(&staged_path)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            "staged image disappeared after synchronization",
        )
    })?;
    let intended_recovery = create_recovery_image(&destination, bytes)?;

    let current = capture_file_version(&destination)?;
    if current.as_ref() != expected.version() {
        let _ = fs::remove_file(&staged_path);
        return Ok(DurableWriteOutcome::Conflict {
            current_version: current,
            recovery_path: intended_recovery,
        });
    }
    before_replace();

    if capture_directory_identity(&parent).ok().as_ref() != Some(&parent_identity) {
        return Ok(parent_change_indeterminate(
            requested_destination,
            bytes,
            vec![intended_recovery],
            Vec::new(),
            "The destination parent changed at the mutation boundary; no replacement was attempted.",
        ));
    }
    let staged_boundary = match capture_file_version(&staged_path) {
        Ok(version) => version,
        Err(error) => {
            return classify_failed_attempt(
                &destination,
                expected,
                vec![intended_recovery],
                &format!("The staged image could not be revalidated: {error}"),
            );
        }
    };
    if staged_boundary.as_ref() != Some(&staged_version) {
        return classify_failed_attempt(
            &destination,
            expected,
            vec![intended_recovery],
            "The staged path changed at the mutation boundary; no replacement was attempted.",
        );
    }
    at_mutation_boundary();

    if matches!(expected, ExpectedFileState::Absent) {
        if fault == Some(DurableWriteFault::Replace) {
            return classify_failed_attempt(
                &destination,
                expected,
                vec![intended_recovery],
                "The creation primitive failed before installing the destination.",
            );
        }
        match install_expected_absent(&staged_path, &destination) {
            Ok(disposition) => {
                after_replace();
                let staged_alias = (disposition == NewInstallDisposition::StagingAlias)
                    .then(|| staged_path.clone());
                if capture_directory_identity(&parent).ok().as_ref() != Some(&parent_identity) {
                    return Ok(parent_change_indeterminate(
                        requested_destination,
                        bytes,
                        vec![intended_recovery],
                        Vec::new(),
                        if staged_alias.is_some() {
                            "The destination parent changed while the new file was being installed. The non-independent staging alias location is uncertain."
                        } else {
                            "The destination parent changed while the new file was being installed."
                        },
                    ));
                }
                match open_file_matches_bytes(&mut staged_file, bytes) {
                    Ok(true) => {}
                    Ok(false) => {
                        return Ok(creation_indeterminate(
                            "The installed object no longer matches the verified staged handle.",
                            intended_recovery,
                            staged_alias,
                        ));
                    }
                    Err(error) => {
                        return Ok(creation_indeterminate(
                            &format!(
                                "The installed staged handle could not be revalidated: {error}"
                            ),
                            intended_recovery,
                            staged_alias,
                        ));
                    }
                }
                if fault == Some(DurableWriteFault::CreationObserve) {
                    return Ok(creation_indeterminate(
                        "The destination was created but could not be observed.",
                        intended_recovery,
                        staged_alias,
                    ));
                }
                let version = match capture_committed_file_version(&destination) {
                    Ok(Some(version)) => version,
                    Ok(None) => {
                        return Ok(creation_indeterminate(
                            "The created destination disappeared before it could be observed.",
                            intended_recovery,
                            staged_alias,
                        ));
                    }
                    Err(error) => {
                        return Ok(creation_indeterminate(
                            &format!(
                                "The destination was created but could not be observed: {error}"
                            ),
                            intended_recovery,
                            staged_alias,
                        ));
                    }
                };
                let intended_digest = format!("{:x}", Sha256::digest(bytes));
                if version.sha256 != intended_digest {
                    return Ok(creation_indeterminate(
                        "The created destination no longer matches the synchronized intended image.",
                        intended_recovery,
                        staged_alias,
                    ));
                }
                if let Some(staged_alias) = staged_alias {
                    if let Err(error) = fs::remove_file(&staged_alias) {
                        return Ok(DurableWriteOutcome::Indeterminate {
                            message: format!(
                                "The destination was created but its staging link could not be retired: {error}"
                            ),
                            recovery_paths: existing_recovery_paths(vec![intended_recovery]),
                        });
                    }
                }
                if fault == Some(DurableWriteFault::ParentSync)
                    || sync_parent_directory_if_required(&parent).is_err()
                {
                    return Ok(DurableWriteOutcome::Indeterminate {
                        message:
                            "The destination was created but directory synchronization failed."
                                .to_string(),
                        recovery_paths: vec![intended_recovery],
                    });
                }
                return Ok(DurableWriteOutcome::ConfirmedCommitted {
                    version,
                    displaced_path: Some(intended_recovery),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return match capture_file_version(&destination) {
                    Ok(Some(current_version)) => Ok(DurableWriteOutcome::Conflict {
                        current_version: Some(current_version),
                        recovery_path: intended_recovery,
                    }),
                    Ok(None) | Err(_) => Ok(DurableWriteOutcome::Indeterminate {
                        message: "The creation primitive reported an existing destination, but that result could not be confirmed."
                            .to_string(),
                        recovery_paths: vec![intended_recovery],
                    }),
                };
            }
            Err(error) => {
                return classify_failed_attempt(
                    &destination,
                    expected,
                    vec![intended_recovery],
                    &format!("The creation primitive failed: {error}"),
                );
            }
        }
    }

    if fault == Some(DurableWriteFault::Replace) {
        return classify_failed_attempt(
            &destination,
            expected,
            vec![intended_recovery],
            "The replacement primitive failed before mutation.",
        );
    }
    if fault == Some(DurableWriteFault::UnsupportedReplace) {
        return classify_failed_attempt(
            &destination,
            expected,
            vec![intended_recovery],
            "No audited atomic replace-with-backup primitive is available.",
        );
    }
    if fault == Some(DurableWriteFault::BackupSucceededReplaceFailed) {
        let observed = observe_open_file(&destination, None)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::Interrupted, "destination disappeared"))?;
        let backup = create_recovery_image(&destination, &observed.bytes)?;
        return classify_failed_attempt(
            &destination,
            expected,
            vec![intended_recovery, backup],
            "A before-image backup completed, but replacement failed without mutating the destination.",
        );
    }
    // Threat boundary: random private staging names are recovery internals, not authority
    // tokens. Public Linux/macOS/Windows replacement APIs still consume a pathname, so a
    // hostile same-UID process can substitute that leaf after revalidation. Unix keeps the
    // verified stage handle open. ReplaceFileW requires an exclusive open of the replacement,
    // so Windows releases that handle immediately before the native call and relies on the
    // independent intended image plus destination and displaced digests. These post-mutation
    // checks reject a substituted staged path as Indeterminate on every platform.
    // Destination races remain fully in scope and are never dismissed by this boundary.
    let displaced_hint = atomic_displaced_path(&staged_path);
    #[cfg(windows)]
    drop(staged_file);
    let displaced_path = match atomic_replace_with_backup(&staged_path, &destination) {
        Ok(path) => path,
        Err(error) => {
            let mut recovery_paths = vec![intended_recovery];
            if displaced_hint.exists() {
                recovery_paths.push(displaced_hint);
            }
            if replace_error_requires_indeterminate(&error) {
                let observation = match capture_file_version(&destination) {
                    Ok(Some(version)) => format!(
                        "destination re-observed with digest {} after the partial-state error",
                        version.sha256
                    ),
                    Ok(None) => "destination re-observed as absent after the partial-state error"
                        .to_string(),
                    Err(observe_error) => format!(
                        "destination re-observation also failed after the partial-state error: {observe_error}"
                    ),
                };
                return Ok(DurableWriteOutcome::Indeterminate {
                    message: format!(
                        "The replacement primitive reported a documented partial-state error: {error}; {observation}."
                    ),
                    recovery_paths: existing_recovery_paths(recovery_paths),
                });
            }
            return classify_failed_attempt(
                &destination,
                expected,
                recovery_paths,
                &format!("The replacement primitive reported failure: {error}"),
            );
        }
    };
    let displaced_bytes = fs::read(&displaced_path).ok();
    after_replace();
    if capture_directory_identity(&parent).ok().as_ref() != Some(&parent_identity) {
        return Ok(parent_change_indeterminate(
            requested_destination,
            bytes,
            vec![intended_recovery, displaced_path],
            displaced_bytes
                .into_iter()
                .map(|bytes| ("displaced".to_string(), bytes))
                .collect(),
            "The destination parent changed while replacement was in progress.",
        ));
    }
    #[cfg(not(windows))]
    {
        match open_file_matches_bytes(&mut staged_file, bytes) {
            Ok(true) => {}
            Ok(false) => {
                return Ok(DurableWriteOutcome::Indeterminate {
                    message: "The verified staged handle changed during replacement.".to_string(),
                    recovery_paths: existing_recovery_paths(vec![
                        intended_recovery,
                        displaced_path,
                    ]),
                });
            }
            Err(error) => {
                return Ok(DurableWriteOutcome::Indeterminate {
                    message: format!(
                        "The verified staged handle could not be revalidated after replacement: {error}"
                    ),
                    recovery_paths: existing_recovery_paths(vec![
                        intended_recovery,
                        displaced_path,
                    ]),
                });
            }
        }
    }
    if fault == Some(DurableWriteFault::ReplacementSucceededBackupUnknown) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: "Replacement succeeded but backup disposition could not be confirmed."
                .to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    if fault == Some(DurableWriteFault::Observe) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: "The replacement completed but outcome observation failed.".to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    let observed_new = match capture_file_version(&destination) {
        Ok(version) => version,
        Err(error) => {
            return Ok(DurableWriteOutcome::Indeterminate {
                message: format!(
                    "The replacement completed but the destination could not be observed: {error}"
                ),
                recovery_paths: vec![intended_recovery, displaced_path],
            });
        }
    };
    if fault == Some(DurableWriteFault::DisplacedObserve) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: "The replacement completed but the displaced original could not be observed."
                .to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    let observed_displaced = match capture_file_version(&displaced_path) {
        Ok(version) => version,
        Err(error) => {
            return Ok(DurableWriteOutcome::Indeterminate {
                message: format!(
                    "The replacement completed but the displaced original could not be observed: {error}"
                ),
                recovery_paths: vec![intended_recovery, displaced_path],
            });
        }
    };
    if !observed_displaced
        .as_ref()
        .zip(expected.version())
        .is_some_and(|(displaced, expected)| displaced.is_displaced_version_of(expected))
    {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: "The destination changed at the replacement boundary; recovery material was retained."
                .to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    let Some(version) = observed_new else {
        return Ok(DurableWriteOutcome::Indeterminate {
            message:
                "The replacement outcome could not be observed; recovery material was retained."
                    .to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    };
    if !version.is_displaced_version_of(&staged_version) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: "The replacement identity did not match the synchronized staged image; recovery material was retained."
                .to_string(),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    let directory_sync = if fault == Some(DurableWriteFault::ParentSync) {
        Err(io::Error::other(
            "injected parent-directory synchronization failure",
        ))
    } else {
        sync_parent_directory_if_required(&parent)
    };
    if let Err(error) = directory_sync {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The replacement completed but directory synchronization failed: {error}"
            ),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }
    if fault == Some(DurableWriteFault::CommittedBindingObserve) {
        fs::remove_file(&destination)?;
    }

    let committed_version = match capture_committed_file_version(&destination) {
        Ok(Some(committed_version)) if committed_version == version => committed_version,
        Ok(Some(_)) => {
            return Ok(DurableWriteOutcome::Indeterminate {
                message:
                    "The committed destination changed while its retained binding was acquired."
                        .to_string(),
                recovery_paths: vec![intended_recovery, displaced_path],
            });
        }
        Ok(None) => {
            return Ok(DurableWriteOutcome::Indeterminate {
                message: "The committed destination disappeared before its retained binding was acquired."
                    .to_string(),
                recovery_paths: vec![intended_recovery, displaced_path],
            });
        }
        Err(error) => {
            return Ok(DurableWriteOutcome::Indeterminate {
                message: format!(
                    "The committed destination could not retain its object binding: {error}"
                ),
                recovery_paths: vec![intended_recovery, displaced_path],
            });
        }
    };
    if let Err(error) = fs::remove_file(&intended_recovery) {
        return Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "The commit was observed but the independent recovery image could not be retired: {error}"
            ),
            recovery_paths: vec![intended_recovery, displaced_path],
        });
    }

    Ok(DurableWriteOutcome::ConfirmedCommitted {
        version: committed_version,
        displaced_path: Some(displaced_path),
    })
}

#[cfg(windows)]
fn replace_error_requires_indeterminate(error: &io::Error) -> bool {
    windows_replace_error_requires_indeterminate(error.raw_os_error())
}

#[cfg(not(windows))]
fn replace_error_requires_indeterminate(_error: &io::Error) -> bool {
    false
}

#[cfg(any(windows, test))]
fn windows_replace_error_requires_indeterminate(raw_os_error: Option<i32>) -> bool {
    matches!(raw_os_error, Some(1176 | 1177))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    canonical_path: PathBuf,
    platform_identity: String,
}

fn capture_directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination parent must be a real directory",
        ));
    }
    Ok(DirectoryIdentity {
        canonical_path: fs::canonicalize(path)?,
        platform_identity: path_platform_identity(path)?,
    })
}

fn classify_failed_attempt(
    destination: &Path,
    expected: &ExpectedFileState,
    recovery_paths: Vec<PathBuf>,
    message: &str,
) -> io::Result<DurableWriteOutcome> {
    match capture_file_version(destination) {
        Ok(current_version) if current_version.as_ref() == expected.version() => {
            Ok(DurableWriteOutcome::ConfirmedNotCommitted {
                current_version,
                recovery_paths,
                message: message.to_string(),
            })
        }
        Ok(_) | Err(_) => Ok(DurableWriteOutcome::Indeterminate {
            message: format!(
                "{message} The destination could not be proven unchanged after the attempt."
            ),
            recovery_paths,
        }),
    }
}

fn existing_recovery_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|path| path.exists()).collect()
}

fn parent_change_indeterminate(
    destination: &Path,
    bytes: &[u8],
    known_paths: Vec<PathBuf>,
    additional_images: Vec<(String, Vec<u8>)>,
    message: &str,
) -> DurableWriteOutcome {
    let mut recovery_paths = existing_recovery_paths(known_paths);
    let message = match create_recovery_in_current_parent(destination, bytes) {
        Ok(path) => {
            if !recovery_paths.contains(&path) {
                recovery_paths.push(path);
            }
            message.to_string()
        }
        Err(error) => match create_fallback_recovery(destination, "intended", bytes) {
            Ok(path) => {
                recovery_paths.push(path);
                format!(
                    "{message} The replacement-tree recovery path failed ({error}); intended bytes were retained in the fallback recovery directory."
                )
            }
            Err(fallback_error) => format!(
                "{message} A recovery image could not be created in the replacement tree ({error}) or fallback directory ({fallback_error})."
            ),
        },
    };
    let mut materialization_errors = Vec::new();
    for (kind, image) in additional_images {
        match create_fallback_recovery(destination, &kind, &image) {
            Ok(path) => recovery_paths.push(path),
            Err(error) => materialization_errors.push(format!("{kind}: {error}")),
        }
    }
    let message = if materialization_errors.is_empty() {
        message
    } else {
        format!(
            "{message} Additional exact recovery images could not be materialized: {}.",
            materialization_errors.join(", ")
        )
    };
    DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths,
    }
}

fn creation_indeterminate(
    message: &str,
    intended_recovery: PathBuf,
    staged_alias: Option<PathBuf>,
) -> DurableWriteOutcome {
    let message = match staged_alias {
        Some(staged_alias) => match fs::remove_file(&staged_alias) {
            Ok(()) => message.to_string(),
            Err(error) => format!(
                "{message} The non-independent staging alias at {} could not be retired: {error}",
                staged_alias.display()
            ),
        },
        None => message.to_string(),
    };
    DurableWriteOutcome::Indeterminate {
        message,
        recovery_paths: existing_recovery_paths(vec![intended_recovery]),
    }
}

fn open_file_matches_bytes(file: &mut File, expected: &[u8]) -> io::Result<bool> {
    file.seek(SeekFrom::Start(0))?;
    let mut observed = Vec::new();
    file.read_to_end(&mut observed)?;
    Ok(observed == expected)
}

fn create_recovery_in_current_parent(destination: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    let parent = fs::canonicalize(parent)?;
    create_recovery_image(
        &parent.join(destination.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
        })?),
        bytes,
    )
}

fn create_fallback_recovery(destination: &Path, kind: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let file_name = destination
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("mmd-data"));
    let anchor = std::env::temp_dir().join(file_name);
    create_synced_image(&anchor, kind, bytes)
}

fn create_recovery_image(destination: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    create_synced_image(destination, "recovery", bytes)
}

fn create_synced_image(destination: &Path, kind: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let (path, mut file) = create_named_temp(destination, kind)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    sync_parent_directory_if_required(path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "recovery path has no parent")
    })?)?;
    Ok(path)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NewInstallDisposition {
    StagingAlias,
    #[cfg(windows)]
    StagingMoved,
}

#[cfg(windows)]
fn install_expected_absent(staged: &Path, destination: &Path) -> io::Result<NewInstallDisposition> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let staged_wide = wide(staged);
    let destination_wide = wide(destination);
    // Both paths are in the same canonical parent. Without MOVEFILE_REPLACE_EXISTING,
    // MoveFileExW is a no-overwrite publication of the already flushed complete stage.
    // Win32 has no supported parent namespace fsync, so no such crash guarantee is claimed.
    let result = unsafe { MoveFileExW(staged_wide.as_ptr(), destination_wide.as_ptr(), 0) };
    if result != 0 {
        Ok(NewInstallDisposition::StagingMoved)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn install_expected_absent(staged: &Path, destination: &Path) -> io::Result<NewInstallDisposition> {
    fs::hard_link(staged, destination)?;
    Ok(NewInstallDisposition::StagingAlias)
}

fn copy_destination_permissions(
    destination: &Path,
    staged_path: &Path,
    expected: &ExpectedFileState,
) -> io::Result<()> {
    if matches!(expected, ExpectedFileState::Absent) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must be a regular file",
        ));
    }
    fs::set_permissions(staged_path, metadata.permissions())
}

fn create_named_temp(destination: &Path, kind: &str) -> io::Result<(PathBuf, File)> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mmd-data");
    for _ in 0..STAGING_ATTEMPTS {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let staged_path = destination.with_file_name(format!(".{file_name}.{kind}-{suffix}"));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&staged_path) {
            Ok(file) => return Ok((staged_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique staging file",
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn atomic_displaced_path(staged: &Path) -> PathBuf {
    staged.to_path_buf()
}

#[cfg(windows)]
fn atomic_displaced_path(staged: &Path) -> PathBuf {
    collision_safe_displaced_path(staged)
}

#[cfg(any(windows, test))]
fn collision_safe_displaced_path(staged: &Path) -> PathBuf {
    let name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mmd-staged");
    staged.with_file_name(format!("{name}.displaced"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn atomic_displaced_path(staged: &Path) -> PathBuf {
    staged.to_path_buf()
}

#[cfg(target_os = "linux")]
fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let staged_c = CString::new(staged.as_os_str().as_bytes())?;
    let destination_c = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            staged_c.as_ptr(),
            libc::AT_FDCWD,
            destination_c.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result == 0 {
        Ok(staged.to_path_buf())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let staged_c = CString::new(staged.as_os_str().as_bytes())?;
    let destination_c = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(staged_c.as_ptr(), destination_c.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(staged.to_path_buf())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn atomic_replace_with_backup(staged: &Path, destination: &Path) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let backup = atomic_displaced_path(staged);
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let staged_wide = wide(staged);
    let backup_wide = wide(&backup);
    let result = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staged_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result != 0 {
        Ok(backup)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn atomic_replace_with_backup(_staged: &Path, _destination: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "this platform has no audited atomic replace-with-backup primitive",
    ))
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(unix)]
fn parent_directory_sync_required() -> bool {
    true
}

#[cfg(not(unix))]
fn parent_directory_sync_required() -> bool {
    // Win32 exposes no supported parent-directory fsync contract. The platform contract
    // therefore requires file-handle flush and post-mutation observation, but does not
    // fabricate a directory durability step that the OS cannot provide.
    false
}

fn sync_parent_directory_if_required(parent: &Path) -> io::Result<()> {
    if parent_directory_sync_required() {
        #[cfg(unix)]
        return sync_parent_directory(parent);
    }
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        process::Command,
        sync::{Arc, Barrier},
        thread,
    };

    use tempfile::tempdir;

    use super::{
        capture_file_version, collision_safe_displaced_path, durable_remove_exact_with_hook,
        durable_remove_exact_with_hooks, durable_write, durable_write_inner,
        durable_write_inner_with_all_hooks, durable_write_inner_with_hook,
        durable_write_inner_with_hooks, read_versioned_file_with_hook, DurableDeleteOutcome,
        DurableWriteFault, DurableWriteOutcome, ExpectedFileState, FileVersion,
    };

    #[test]
    fn quarantine_delete_preserves_a_leaf_swapped_at_the_mutation_boundary() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("draft.json");
        let displaced = directory.path().join("displaced.json");
        fs::write(&destination, b"expected").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_remove_exact_with_hook(&destination, &expected, || {
            fs::rename(&destination, &displaced).unwrap();
            fs::write(&destination, b"replacement").unwrap();
        });

        assert!(matches!(outcome, DurableDeleteOutcome::Conflict { .. }));
        assert_eq!(fs::read(&destination).unwrap(), b"replacement");
        assert_eq!(fs::read(&displaced).unwrap(), b"expected");
    }

    #[test]
    fn quarantine_delete_never_unlinks_a_replacement_installed_before_final_unlink() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("draft.json");
        let rescued = directory.path().join("rescued.json");
        fs::write(&destination, b"expected").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_remove_exact_with_hooks(
            &destination,
            &expected,
            || {},
            |quarantine| {
                fs::rename(quarantine, &rescued).unwrap();
                fs::write(quarantine, b"replacement").unwrap();
            },
        );

        assert!(matches!(outcome, DurableDeleteOutcome::Conflict { .. }));
        assert_eq!(fs::read(&rescued).unwrap(), b"expected");
        let replacement = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().contains(".delete-"))
            .unwrap();
        assert_eq!(fs::read(replacement.path()).unwrap(), b"replacement");
    }

    fn exact(version: &FileVersion) -> ExpectedFileState {
        ExpectedFileState::Exact {
            version: version.clone(),
        }
    }

    fn staged_files(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
        fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".tmp-"))
                    .then_some(path)
            })
            .collect()
    }

    #[cfg(unix)]
    fn recovery_files(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
        fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".recovery-"))
                    .then_some(path)
            })
            .collect()
    }

    #[test]
    fn file_version_uses_strict_decimal_string_wire_contract_at_integer_maxima() {
        let version = FileVersion {
            canonical_path: "/tmp/note.md".to_string(),
            platform_identity: "1:2".to_string(),
            length: u64::MAX,
            modified_nanos: u128::MAX,
            sha256: "a".repeat(64),
            file_binding: None,
        };
        let json = serde_json::to_value(&version).unwrap();
        assert_eq!(json["length"], u64::MAX.to_string());
        assert_eq!(json["modifiedNanos"], u128::MAX.to_string());
        assert_eq!(
            serde_json::from_value::<FileVersion>(json).unwrap(),
            version
        );
    }

    #[test]
    fn file_version_rejects_noncanonical_or_invalid_wire_fields() {
        let valid = serde_json::json!({
            "canonicalPath": "/tmp/note.md",
            "platformIdentity": "1:2",
            "length": "1",
            "modifiedNanos": "2",
            "sha256": "a".repeat(64),
        });
        let invalid_cases = [
            ("number length", serde_json::json!(1), "length"),
            ("empty length", serde_json::json!(""), "length"),
            ("signed length", serde_json::json!("+1"), "length"),
            ("spaced length", serde_json::json!(" 1"), "length"),
            ("leading-zero length", serde_json::json!("01"), "length"),
            (
                "overflow length",
                serde_json::json!("18446744073709551616"),
                "length",
            ),
            ("number nanos", serde_json::json!(2), "modifiedNanos"),
            (
                "overflow nanos",
                serde_json::json!("340282366920938463463374607431768211456"),
                "modifiedNanos",
            ),
            (
                "uppercase digest",
                serde_json::json!("A".repeat(64)),
                "sha256",
            ),
            ("short digest", serde_json::json!("a".repeat(63)), "sha256"),
            (
                "empty canonical path",
                serde_json::json!(""),
                "canonicalPath",
            ),
            ("empty identity", serde_json::json!(""), "platformIdentity"),
        ];
        for (name, replacement, field) in invalid_cases {
            let mut candidate = valid.clone();
            candidate[field] = replacement;
            assert!(
                serde_json::from_value::<FileVersion>(candidate).is_err(),
                "{name} must be rejected"
            );
        }
        let mut unknown = valid;
        unknown["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<FileVersion>(unknown).is_err());
    }

    #[test]
    fn creates_and_replaces_complete_synced_images() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");

        let created = durable_write(&destination, b"first", &ExpectedFileState::Absent).unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();
        assert!(expected.retained_file_binding().is_none());
        let replaced = durable_write(&destination, b"second", &exact(&expected)).unwrap();

        let DurableWriteOutcome::ConfirmedCommitted {
            version: created_version,
            ..
        } = created
        else {
            panic!("creation must commit");
        };
        let DurableWriteOutcome::ConfirmedCommitted {
            version: replaced_version,
            ..
        } = replaced
        else {
            panic!("replacement must commit");
        };
        assert!(created_version.retained_file_binding().is_some());
        assert!(replaced_version.retained_file_binding().is_some());
        assert_eq!(fs::read(&destination).unwrap(), b"second");
    }

    #[cfg(windows)]
    #[test]
    fn windows_same_bytes_staging_substitution_cannot_confirm_commit() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"old-image").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner_with_all_hooks(
            &destination,
            b"new-image",
            &exact(&expected),
            None,
            || {},
            || {
                let staged = staged_files(directory.path());
                assert_eq!(staged.len(), 1);
                fs::remove_file(&staged[0]).unwrap();
                fs::write(&staged[0], b"new-image").unwrap();
            },
            || {},
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("a replacement with matching bytes but a different identity is not committed");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"new-image");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old-image")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"new-image")));
    }

    #[cfg(unix)]
    #[test]
    fn successful_creation_cleans_abandoned_staging_alias() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");

        let outcome = durable_write(&destination, b"complete", &ExpectedFileState::Absent).unwrap();

        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedCommitted { .. }
        ));
        assert!(staged_files(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_failure_after_creation_preserves_complete_bytes_and_recovery_evidence() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");

        let outcome = durable_write_inner_with_hooks(
            &destination,
            b"complete",
            &ExpectedFileState::Absent,
            None,
            || {},
            || {
                let staged = staged_files(directory.path());
                assert_eq!(staged.len(), 1);
                fs::remove_file(&staged[0]).unwrap();
                fs::create_dir(&staged[0]).unwrap();
            },
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate {
            message,
            recovery_paths,
        } = outcome
        else {
            panic!("failed staging cleanup must retain explicit recovery evidence");
        };
        assert!(message.contains("staging link could not be retired"));
        assert_eq!(fs::read(&destination).unwrap(), b"complete");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"complete")));
    }

    #[test]
    fn process_termination_before_replacement_preserves_only_complete_images() {
        const CHILD_PATH: &str = "MMD_DURABLE_WRITE_TERMINATION_PATH";
        if let Some(destination) = std::env::var_os(CHILD_PATH) {
            let destination = std::path::PathBuf::from(destination);
            let expected = capture_file_version(&destination).unwrap().unwrap();
            let _ = durable_write_inner_with_all_hooks(
                &destination,
                b"complete-new-image",
                &exact(&expected),
                None,
                || {},
                || std::process::exit(86),
                || {},
            );
            panic!("termination hook must exit before replacement");
        }

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"complete-old-image").unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("durable_write::tests::process_termination_before_replacement_preserves_only_complete_images")
            .arg("--nocapture")
            .env(CHILD_PATH, &destination)
            .status()
            .unwrap();

        assert_eq!(status.code(), Some(86));
        assert_eq!(fs::read(&destination).unwrap(), b"complete-old-image");
        let retained = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path != &destination && path.is_file())
            .collect::<Vec<_>>();
        assert!(!retained.is_empty());
        assert!(retained
            .iter()
            .all(|path| fs::read(path).unwrap() == b"complete-new-image"));
    }

    #[test]
    fn writes_empty_and_large_documents_exactly_and_returns_observed_version() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"stale trailing bytes").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let empty = durable_write(&destination, b"", &exact(&expected)).unwrap();
        let DurableWriteOutcome::ConfirmedCommitted { version, .. } = empty else {
            panic!("empty write must commit");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"");
        assert_eq!(Some(version), capture_file_version(&destination).unwrap());

        let expected = capture_file_version(&destination).unwrap().unwrap();
        let large = (0..(4 * 1024 * 1024 + 31))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let outcome = durable_write(&destination, &large, &exact(&expected)).unwrap();
        let DurableWriteOutcome::ConfirmedCommitted { version, .. } = outcome else {
            panic!("large write must commit");
        };
        assert_eq!(fs::read(&destination).unwrap(), large);
        assert_eq!(Some(version), capture_file_version(&destination).unwrap());
    }

    #[test]
    fn stages_in_destination_directory() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"new",
            &exact(&expected),
            Some(DurableWriteFault::Replace),
        );

        assert!(matches!(
            outcome,
            Ok(DurableWriteOutcome::ConfirmedNotCommitted { .. })
        ));
        let staged = staged_files(directory.path());
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].parent(), destination.parent());
        assert_eq!(fs::read(&staged[0]).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_supported_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write(&destination, b"new", &exact(&expected)).unwrap();

        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedCommitted { .. }
        ));
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn replaces_read_only_destination_with_complete_bytes() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"complete-old-image").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o444)).unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome =
            durable_write(&destination, b"complete-new-image", &exact(&expected)).unwrap();

        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedCommitted { .. }
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"complete-new-image");
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }

    #[test]
    fn final_compare_race_retains_complete_competing_bytes() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"expected").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome =
            durable_write_inner_with_hook(&destination, b"ours", &exact(&expected), None, || {
                fs::write(&destination, b"competitor").unwrap()
            })
            .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("replacement-boundary race must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"ours");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"competitor")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"ours")));
    }

    #[test]
    fn parent_directory_sync_failure_after_replace_is_indeterminate() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"new",
            &exact(&expected),
            Some(DurableWriteFault::ParentSync),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("directory sync failure must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    }

    #[test]
    fn unsupported_atomic_replace_blocks_before_overwrite() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"new",
            &exact(&expected),
            Some(DurableWriteFault::UnsupportedReplace),
        )
        .unwrap();

        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedNotCommitted { .. }
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        let staged = staged_files(directory.path());
        assert_eq!(staged.len(), 1);
        assert_eq!(fs::read(&staged[0]).unwrap(), b"new");
    }

    #[test]
    fn displaced_original_observation_failure_has_explicit_recovery_disposition() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"new",
            &exact(&expected),
            Some(DurableWriteFault::DisplacedObserve),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("unknown displaced observation must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    }

    #[test]
    fn expected_absent_install_race_retains_independent_intended_bytes() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");

        let outcome = durable_write_inner_with_hooks(
            &destination,
            b"intended",
            &ExpectedFileState::Absent,
            None,
            || {},
            || fs::write(&destination, b"competitor").unwrap(),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("post-install competing write must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"competitor");
        let intended = recovery_paths
            .iter()
            .find(|path| fs::read(path).ok().as_deref() == Some(b"intended"))
            .expect("independent intended bytes must be retained");
        fs::write(&destination, b"changed-again").unwrap();
        assert_eq!(fs::read(intended).unwrap(), b"intended");
    }

    #[test]
    fn failed_replace_with_unchanged_destination_is_confirmed_not_committed() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"intended",
            &exact(&expected),
            Some(DurableWriteFault::Replace),
        )
        .unwrap();

        let DurableWriteOutcome::ConfirmedNotCommitted {
            current_version,
            recovery_paths,
            ..
        } = outcome
        else {
            panic!("unchanged destination must be confirmed not committed");
        };
        assert_eq!(current_version, Some(expected));
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[test]
    fn backup_succeeded_then_replace_failed_has_unambiguous_not_committed_evidence() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"intended",
            &exact(&expected),
            Some(DurableWriteFault::BackupSucceededReplaceFailed),
        )
        .unwrap();

        let DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } = outcome else {
            panic!("failed replacement with unchanged destination is not committed");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[test]
    fn replacement_succeeded_with_unknown_backup_disposition_is_indeterminate() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"intended",
            &exact(&expected),
            Some(DurableWriteFault::ReplacementSucceededBackupUnknown),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("unknown backup disposition must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"intended");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[test]
    fn committed_binding_observation_failure_retains_new_and_old_recovery_images() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"intended",
            &exact(&expected),
            Some(DurableWriteFault::CommittedBindingObserve),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate {
            message,
            recovery_paths,
        } = outcome
        else {
            panic!("a missing committed binding must remain indeterminate");
        };
        assert!(message.contains("disappeared before its retained binding"));
        assert!(!destination.exists());
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[test]
    fn staged_path_substitution_is_detected_before_mutation() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner_with_hook(
            &destination,
            b"intended",
            &exact(&expected),
            None,
            || {
                let staged = staged_files(directory.path());
                assert_eq!(staged.len(), 1);
                fs::remove_file(&staged[0]).unwrap();
                fs::write(&staged[0], b"substitute").unwrap();
            },
        )
        .unwrap();

        let DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } = outcome else {
            panic!("staging substitution must block before mutation");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[test]
    fn staged_path_substitution_at_native_boundary_preserves_all_complete_images() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner_with_all_hooks(
            &destination,
            b"intended",
            &exact(&expected),
            None,
            || {},
            || {
                let staged = staged_files(directory.path());
                assert_eq!(staged.len(), 1);
                fs::remove_file(&staged[0]).unwrap();
                fs::write(&staged[0], b"competitor").unwrap();
            },
            || {},
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("a final staged-name race cannot be confirmed committed");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"competitor");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    }

    #[test]
    fn post_replace_parent_change_with_failed_recovery_creation_is_indeterminate() {
        let directory = tempdir().unwrap();
        let ancestor = directory.path().join("workspace");
        fs::create_dir(&ancestor).unwrap();
        let destination = ancestor.join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();
        let moved = directory.path().join("moved-workspace");

        let outcome = durable_write_inner_with_all_hooks(
            &destination,
            b"intended",
            &exact(&expected),
            None,
            || {},
            || {},
            || {
                fs::rename(&ancestor, &moved).unwrap();
                fs::write(&ancestor, b"not-a-directory").unwrap();
            },
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("post-mutation parent change must remain indeterminate");
        };
        assert_eq!(fs::read(moved.join("document.md")).unwrap(), b"intended");
        assert!(recovery_paths.iter().all(|path| path.exists()));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old")));
    }

    #[cfg(unix)]
    #[test]
    fn post_create_parent_change_with_failed_recovery_creation_is_indeterminate() {
        let directory = tempdir().unwrap();
        let ancestor = directory.path().join("workspace");
        fs::create_dir(&ancestor).unwrap();
        let destination = ancestor.join("document.md");
        let moved = directory.path().join("moved-workspace");

        let outcome = durable_write_inner_with_all_hooks(
            &destination,
            b"intended",
            &ExpectedFileState::Absent,
            None,
            || {},
            || {},
            || {
                fs::rename(&ancestor, &moved).unwrap();
                fs::write(&ancestor, b"not-a-directory").unwrap();
            },
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("post-create parent change must remain indeterminate");
        };
        assert_eq!(fs::read(moved.join("document.md")).unwrap(), b"intended");
        assert!(recovery_paths.iter().all(|path| path.exists()));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
        assert!(recovery_paths.iter().all(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".tmp-"))
        }));
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_swap_is_detected_without_mutating_the_replacement_tree() {
        let directory = tempdir().unwrap();
        let ancestor = directory.path().join("workspace");
        let parent = ancestor.join("nested");
        fs::create_dir_all(&parent).unwrap();
        let destination = parent.join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();
        let moved = directory.path().join("moved-workspace");

        let outcome = durable_write_inner_with_hook(
            &destination,
            b"intended",
            &exact(&expected),
            None,
            || {
                fs::rename(&ancestor, &moved).unwrap();
                fs::create_dir_all(&parent).unwrap();
            },
        )
        .unwrap();

        assert!(matches!(outcome, DurableWriteOutcome::Indeterminate { .. }));
        assert!(!destination.exists());
        assert_eq!(fs::read(moved.join("nested/document.md")).unwrap(), b"old");
        assert!(recovery_files(&parent)
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_live_staging_handle_prevents_ancestor_swap_before_replacement() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let ancestor = directory.path().join("workspace");
        let parent = ancestor.join("nested");
        fs::create_dir_all(&parent).unwrap();
        let destination = parent.join("document.md");
        fs::write(&destination, b"old").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();
        let moved = directory.path().join("moved-workspace");
        let rename_error = Cell::new(None);

        let outcome = durable_write_inner_with_hook(
            &destination,
            b"intended",
            &exact(&expected),
            None,
            || {
                rename_error.set(
                    fs::rename(&ancestor, &moved)
                        .err()
                        .and_then(|error| error.raw_os_error()),
                )
            },
        )
        .unwrap();

        assert_eq!(rename_error.get(), Some(5));
        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedCommitted { .. }
        ));
        assert_eq!(fs::read(destination).unwrap(), b"intended");
        assert!(!moved.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_live_installed_handle_prevents_post_create_parent_swap() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let ancestor = directory.path().join("workspace");
        fs::create_dir(&ancestor).unwrap();
        let destination = ancestor.join("document.md");
        let moved = directory.path().join("moved-workspace");
        let rename_error = Cell::new(None);

        let outcome = durable_write_inner_with_all_hooks(
            &destination,
            b"intended",
            &ExpectedFileState::Absent,
            None,
            || {},
            || {},
            || {
                rename_error.set(
                    fs::rename(&ancestor, &moved)
                        .err()
                        .and_then(|error| error.raw_os_error()),
                )
            },
        )
        .unwrap();

        assert_eq!(rename_error.get(), Some(5));
        assert!(matches!(
            outcome,
            DurableWriteOutcome::ConfirmedCommitted { .. }
        ));
        assert_eq!(fs::read(destination).unwrap(), b"intended");
        assert!(!moved.exists());
    }

    #[test]
    fn creation_observation_failure_retains_independent_intended_image() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");

        let outcome = durable_write_inner(
            &destination,
            b"intended",
            &ExpectedFileState::Absent,
            Some(DurableWriteFault::CreationObserve),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("creation observation failure must be indeterminate");
        };
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"intended")));
        assert!(recovery_paths.iter().all(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".tmp-"))
        }));
    }

    #[test]
    fn versioned_read_rejects_replacement_between_stable_observations() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, b"first").unwrap();

        let error = read_versioned_file_with_hook(&path, 1024, || {
            let replacement = directory.path().join("replacement");
            fs::write(&replacement, b"second").unwrap();
            fs::remove_file(&path).unwrap();
            fs::rename(replacement, &path).unwrap();
        })
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(fs::read(path).unwrap(), b"second");
    }

    #[test]
    fn unbounded_platform_limit_does_not_overflow_bounded_read_sentinel() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, b"content").unwrap();

        let observed = super::read_versioned_file(&path, usize::MAX)
            .unwrap()
            .unwrap();

        assert_eq!(observed.bytes, b"content");
    }

    #[test]
    fn parent_sync_policy_never_silently_claims_unsupported_platform_evidence() {
        #[cfg(unix)]
        assert!(super::parent_directory_sync_required());
        #[cfg(not(unix))]
        assert!(!super::parent_directory_sync_required());
    }

    #[test]
    fn documented_windows_partial_replace_errors_require_indeterminate() {
        assert!(super::windows_replace_error_requires_indeterminate(Some(
            1176
        )));
        assert!(super::windows_replace_error_requires_indeterminate(Some(
            1177
        )));
        assert!(!super::windows_replace_error_requires_indeterminate(Some(
            1175
        )));
    }

    #[test]
    fn collision_safe_windows_backup_name_preserves_random_staging_suffix() {
        let first = std::path::Path::new("/tmp/.document.md.tmp-001122");
        let second = std::path::Path::new("/tmp/.document.md.tmp-aabbcc");

        let first_backup = collision_safe_displaced_path(first);
        let second_backup = collision_safe_displaced_path(second);

        assert_ne!(first_backup, second_backup);
        assert_eq!(
            first_backup.file_name().unwrap(),
            ".document.md.tmp-001122.displaced"
        );
        assert_eq!(
            second_backup.file_name().unwrap(),
            ".document.md.tmp-aabbcc.displaced"
        );
    }

    #[test]
    fn version_conflict_never_replaces_destination_and_retains_staged_bytes() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"expected").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();
        fs::write(&destination, b"external").unwrap();

        let outcome = durable_write(&destination, b"ours", &exact(&expected)).unwrap();

        let DurableWriteOutcome::Conflict { recovery_path, .. } = outcome else {
            panic!("expected a conflict");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"external");
        assert_eq!(fs::read(recovery_path).unwrap(), b"ours");
    }

    #[test]
    fn absent_precondition_conflicts_if_destination_appears() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"external").unwrap();

        let outcome = durable_write(&destination, b"ours", &ExpectedFileState::Absent).unwrap();

        assert!(matches!(outcome, DurableWriteOutcome::Conflict { .. }));
        assert_eq!(fs::read(&destination).unwrap(), b"external");
    }

    #[test]
    fn precommit_write_sync_and_replace_failures_preserve_destination_and_recovery_bytes() {
        for (fault, expected_staged) in [
            (DurableWriteFault::Write, b"".as_slice()),
            (DurableWriteFault::PartialWrite, b"new-".as_slice()),
            (DurableWriteFault::Flush, b"new-image".as_slice()),
            (DurableWriteFault::Metadata, b"new-image".as_slice()),
            (DurableWriteFault::Sync, b"new-image".as_slice()),
        ] {
            let directory = tempdir().unwrap();
            let destination = directory.path().join("settings.json");
            fs::write(&destination, b"old-image").unwrap();
            let expected = capture_file_version(&destination).unwrap().unwrap();

            let result =
                durable_write_inner(&destination, b"new-image", &exact(&expected), Some(fault));

            assert!(result.is_err(), "{fault:?} must report failure");
            assert_eq!(fs::read(&destination).unwrap(), b"old-image");
            let staged = staged_files(directory.path());
            assert_eq!(staged.len(), 1);
            assert_eq!(fs::read(&staged[0]).unwrap(), expected_staged);
        }
    }

    #[test]
    fn temp_creation_failure_preserves_original_without_abandoned_staging() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"old-image").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let result = durable_write_inner(
            &destination,
            b"new-image",
            &exact(&expected),
            Some(DurableWriteFault::TempCreate),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"old-image");
        assert!(staged_files(directory.path()).is_empty());
    }

    #[test]
    fn post_replace_observation_failure_is_indeterminate_and_retains_exact_before_image() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"old-image").unwrap();
        let expected = capture_file_version(&destination).unwrap().unwrap();

        let outcome = durable_write_inner(
            &destination,
            b"new-image",
            &exact(&expected),
            Some(DurableWriteFault::Observe),
        )
        .unwrap();

        let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
            panic!("observation failure must be indeterminate");
        };
        assert_eq!(fs::read(&destination).unwrap(), b"new-image");
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"old-image")));
        assert!(recovery_paths
            .iter()
            .any(|path| fs::read(path).ok().as_deref() == Some(b"new-image")));
    }

    #[test]
    fn concurrent_writers_with_one_expected_version_report_only_one_confirmed_commit() {
        for round in 0..16 {
            let directory = tempdir().unwrap();
            let destination = directory.path().join("settings.json");
            fs::write(&destination, b"initial").unwrap();
            let expected = Arc::new(capture_file_version(&destination).unwrap().unwrap());
            let barrier = Arc::new(Barrier::new(6));
            let mut joins = Vec::new();
            for index in 0..6 {
                let destination = destination.clone();
                let expected = expected.clone();
                let barrier = barrier.clone();
                joins.push(thread::spawn(move || {
                    let bytes = format!("writer-{round}-{index}").into_bytes();
                    barrier.wait();
                    durable_write(&destination, &bytes, &exact(&expected)).unwrap()
                }));
            }
            let outcomes = joins
                .into_iter()
                .map(|join| join.join().unwrap())
                .collect::<Vec<_>>();

            assert_eq!(
                outcomes
                    .iter()
                    .filter(|outcome| matches!(
                        outcome,
                        DurableWriteOutcome::ConfirmedCommitted { .. }
                    ))
                    .count(),
                1,
                "round {round}"
            );
            assert!(fs::read_to_string(destination)
                .unwrap()
                .starts_with(&format!("writer-{round}-")));
            for outcome in outcomes {
                match outcome {
                    DurableWriteOutcome::Conflict { recovery_path, .. } => {
                        assert!(recovery_path.exists());
                    }
                    DurableWriteOutcome::Indeterminate { recovery_paths, .. } => {
                        assert!(recovery_paths.iter().all(|path| path.exists()));
                    }
                    DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } => {
                        assert!(recovery_paths.iter().all(|path| path.exists()));
                    }
                    DurableWriteOutcome::ConfirmedCommitted { .. } => {}
                }
            }
        }
    }
}
