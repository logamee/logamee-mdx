//! Additional shared fixtures.
pub(crate) use super::fixtures::*;

#[derive(Clone)]
pub(super) struct TestZipEntry {
    pub(super) name: String,
    pub(super) compression_method: u16,
    pub(super) compressed_size: u64,
    pub(super) uncompressed_size: u64,
}

impl TestZipEntry {
    pub(super) fn new(
        name: impl Into<String>,
        compressed_size: u64,
        uncompressed_size: u64,
    ) -> Self {
        Self {
            name: name.into(),
            compression_method: 0,
            compressed_size,
            uncompressed_size,
        }
    }

    pub(super) fn with_compression_method(mut self, compression_method: u16) -> Self {
        self.compression_method = compression_method;
        self
    }
}

pub(super) fn append_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub(super) fn append_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub(super) fn zip64_size_fields(entry: &TestZipEntry) -> (u32, u32, Vec<u8>) {
    if entry.compressed_size <= u32::MAX as u64 && entry.uncompressed_size <= u32::MAX as u64 {
        return (
            entry.compressed_size as u32,
            entry.uncompressed_size as u32,
            Vec::new(),
        );
    }

    let mut extra = Vec::with_capacity(20);
    append_u16(&mut extra, 0x0001);
    append_u16(&mut extra, 16);
    extra.extend_from_slice(&entry.uncompressed_size.to_le_bytes());
    extra.extend_from_slice(&entry.compressed_size.to_le_bytes());
    (u32::MAX, u32::MAX, extra)
}

pub(super) fn docx_zip(entries: &[TestZipEntry], valid_local_headers: bool) -> Vec<u8> {
    assert!(entries.len() <= u16::MAX as usize);
    let mut bytes = Vec::new();
    let mut local_offsets = Vec::with_capacity(entries.len());

    for entry in entries {
        local_offsets.push(bytes.len() as u32);
        append_local_file_header(&mut bytes, entry, valid_local_headers);
    }

    let central_offset = bytes.len() as u32;
    for (entry, local_offset) in entries.iter().zip(local_offsets) {
        append_central_directory_entry(&mut bytes, entry, local_offset);
    }
    let central_size = bytes.len() as u32 - central_offset;
    append_end_of_central_directory(&mut bytes, entries.len(), central_size, central_offset);
    bytes
}

fn append_local_file_header(bytes: &mut Vec<u8>, entry: &TestZipEntry, valid: bool) {
    let name = entry.name.as_bytes();
    assert!(name.len() <= u16::MAX as usize);
    append_u32(bytes, if valid { 0x0403_4b50 } else { 0x0403_4b51 });
    append_u16(bytes, 45);
    append_u16(bytes, 0);
    append_u16(bytes, entry.compression_method);
    append_u16(bytes, 0);
    append_u16(bytes, 0);
    append_u32(bytes, 0);
    let (compressed_size, uncompressed_size, extra) = zip64_size_fields(entry);
    append_u32(bytes, compressed_size);
    append_u32(bytes, uncompressed_size);
    append_u16(bytes, name.len() as u16);
    append_u16(bytes, extra.len() as u16);
    bytes.extend_from_slice(name);
    bytes.extend_from_slice(&extra);
}

fn append_central_directory_entry(bytes: &mut Vec<u8>, entry: &TestZipEntry, local_offset: u32) {
    let name = entry.name.as_bytes();
    let (compressed_size, uncompressed_size, extra) = zip64_size_fields(entry);
    append_u32(bytes, 0x0201_4b50);
    append_u16(bytes, 45);
    append_u16(bytes, 45);
    append_u16(bytes, 0);
    append_u16(bytes, entry.compression_method);
    append_u16(bytes, 0);
    append_u16(bytes, 0);
    append_u32(bytes, 0);
    append_u32(bytes, compressed_size);
    append_u32(bytes, uncompressed_size);
    append_u16(bytes, name.len() as u16);
    append_u16(bytes, extra.len() as u16);
    append_u16(bytes, 0);
    append_u16(bytes, 0);
    append_u16(bytes, 0);
    append_u32(bytes, 0);
    append_u32(bytes, local_offset);
    bytes.extend_from_slice(name);
    bytes.extend_from_slice(&extra);
}

fn append_end_of_central_directory(
    bytes: &mut Vec<u8>,
    entry_count: usize,
    central_size: u32,
    central_offset: u32,
) {
    append_u32(bytes, 0x0605_4b50);
    append_u16(bytes, 0);
    append_u16(bytes, 0);
    append_u16(bytes, entry_count as u16);
    append_u16(bytes, entry_count as u16);
    append_u32(bytes, central_size);
    append_u32(bytes, central_offset);
    append_u16(bytes, 0);
}

pub(super) fn minimal_docx_zip() -> Vec<u8> {
    docx_zip(&[TestZipEntry::new("[Content_Types].xml", 0, 0)], true)
}

pub(super) fn assert_zip_central_directory_parses(bytes: &[u8], expected_entries: usize) {
    let archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(archive.len(), expected_entries);
}

pub(super) fn test_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

pub(super) fn assert_exact_binary_wire(
    path: &Path,
    source: &[u8],
    expected_kind: &str,
    mime: &str,
) {
    let state = AppState::default();
    authorize_directory_root_inner(&state, path.parent().unwrap().to_path_buf()).unwrap();
    let response = open_workspace_file_inner(&state, path).unwrap();
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "kind": expected_kind,
            "path": path.canonicalize().unwrap().to_string_lossy(),
            "content_mode": "binary",
            "mime_type": mime,
            "bytes_base64": test_base64(source),
        })
    );
}

pub(super) fn assert_docx_open_rejected_without_exact_grant(bytes: &[u8], expected_message: &str) {
    let directory = tempdir().unwrap();
    let path = directory.path().join("hostile.docx");
    fs::write(&path, bytes).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let error = open_workspace_file_inner(&state, &path).unwrap_err();

    assert!(
        error.contains(expected_message),
        "expected {error:?} to contain {expected_message:?}"
    );
    assert!(ensure_authorized_write_file_inner(&state, &path).is_err());
}

pub(crate) fn session_state(app_data_dir: PathBuf) -> AppState {
    let state = AppState::default();
    state.initialize_recent_files(app_data_dir.clone()).unwrap();
    state.initialize_workspace_session(app_data_dir).unwrap();
    state
}
