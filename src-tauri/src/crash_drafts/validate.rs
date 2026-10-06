//! Request, envelope and token validation.
use super::*;
use crate::private_fs::lowercase_hex;

pub(crate) fn validate_write_request(request: &CrashDraftWriteRequest) -> Result<(), CrashDraftError> {
    validate_document_id(&request.document_id)?;
    if request.revision == 0 || request.revision > JS_SAFE_INTEGER {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft revision must be a positive safe integer",
        ));
    }
    validate_pair(&request.path_hint, &request.base_version_token)?;
    if let Some(path) = request.path_hint.as_deref() {
        validate_path_hint(path)?;
    }
    if request.content.len() > MAX_DRAFT_CONTENT_BYTES {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Oversized,
            "crash draft content exceeds the size limit",
        ));
    }
    Ok(())
}

pub(crate) fn validate_envelope(envelope: &CrashDraftEnvelope, filename_id: &str) -> Result<(), ()> {
    if envelope.schema_version != CRASH_DRAFT_SCHEMA_VERSION
        || envelope.document_id != filename_id
        || validate_document_id(&envelope.document_id).is_err()
        || envelope.revision == 0
        || envelope.revision > JS_SAFE_INTEGER
        || envelope.updated_at_ms > JS_SAFE_INTEGER
        || validate_pair(&envelope.path_hint, &envelope.base_version_token).is_err()
        || envelope
            .path_hint
            .as_deref()
            .is_some_and(|path| validate_path_hint(path).is_err())
        || envelope.content.len() > MAX_DRAFT_CONTENT_BYTES
        || envelope.checksum != envelope_checksum(envelope)
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn validate_document_id(document_id: &str) -> Result<(), CrashDraftError> {
    if document_id.len() == 32
        && document_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "document ID must be 32 lowercase hexadecimal characters",
        ))
    }
}

pub(crate) fn validate_expected_token(token: &str) -> Result<(), CrashDraftError> {
    if is_opaque_token(token) {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft token must be 64 lowercase hexadecimal characters",
        ))
    }
}

pub(crate) fn is_ignored_artifact_name(file_name: &std::ffi::OsStr) -> bool {
    if file_name == LOCK_FILE_NAME {
        return false;
    }
    !file_name
        .to_str()
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|id| validate_document_id(id).is_ok())
}

pub(crate) fn validate_pair(path: &Option<String>, version: &Option<String>) -> Result<(), CrashDraftError> {
    if matches!((path, version), (None, None))
        || matches!((path, version), (Some(path), Some(version)) if !path.is_empty() && is_opaque_token(version))
    {
        Ok(())
    } else {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "path hint and base version token must be supplied together",
        ))
    }
}

pub(crate) fn validate_path_hint(path: &str) -> Result<(), CrashDraftError> {
    if path.len() > MAX_PATH_HINT_BYTES {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Oversized,
            "crash draft path hint exceeds the size limit",
        ));
    }
    if path.is_empty()
        || path
            .chars()
            .any(|character| character.is_control() || is_unicode_format_control(character))
    {
        return Err(CrashDraftError::plain(
            CrashDraftErrorCode::Invalid,
            "crash draft path hint contains unsupported characters",
        ));
    }
    Ok(())
}

pub(crate) fn is_opaque_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn is_unicode_format_control(character: char) -> bool {
    matches!(
        character,
        '\u{00ad}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

pub(crate) fn request_matches(envelope: &CrashDraftEnvelope, request: &CrashDraftWriteRequest) -> bool {
    envelope.file_kind == request.file_kind
        && envelope.revision == request.revision
        && envelope.path_hint == request.path_hint
        && envelope.base_version_token == request.base_version_token
        && envelope.content == request.content
}

pub(crate) fn ensure_protected_capacity<V>(
    entries: &[ScannedEntry<V>],
    incoming_id: &str,
    incoming_size: u64,
) -> Result<(), CrashDraftError> {
    let protected: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry, ScannedEntry::Protected { .. }))
        .collect();
    let replacing_protected = protected.iter().any(|entry| entry.id() == incoming_id);
    let minimum_count = protected.len() + usize::from(!replacing_protected);
    let protected_size = protected.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(entry.size())
            .ok_or_else(capacity_overflow)
    })?;
    let minimum_size = protected_size
        .checked_add(incoming_size)
        .ok_or_else(capacity_overflow)?;
    if minimum_count > MAX_DRAFT_ENTRIES || minimum_size > MAX_DRAFT_TOTAL_BYTES {
        Err(CrashDraftError::plain(
            CrashDraftErrorCode::Capacity,
            "protected crash drafts consume the available storage capacity",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn checked_total_size<V>(entries: &[ScannedEntry<V>]) -> Result<u64, CrashDraftError> {
    entries.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(entry.size())
            .ok_or_else(capacity_overflow)
    })
}

pub(crate) fn capacity_overflow() -> CrashDraftError {
    CrashDraftError::plain(
        CrashDraftErrorCode::Capacity,
        "crash draft storage size exceeds the supported range",
    )
}

pub(crate) fn overflow_capacity_error(receipt: String) -> CrashDraftError {
    let mut error = CrashDraftError::plain(
        CrashDraftErrorCode::Capacity,
        "crash draft directory contains too many entries",
    );
    error.repair_required = Some(CrashDraftRepairRequired::LimitRepair);
    error.repair_receipt = Some(receipt);
    error
}

pub(crate) fn envelope_checksum(envelope: &CrashDraftEnvelope) -> String {
    let mut frame = Vec::new();
    frame.extend_from_slice(b"mmd-crash-draft\0\x01");
    frame_field(&mut frame, &envelope.schema_version.to_be_bytes());
    frame_field(&mut frame, envelope.document_id.as_bytes());
    frame_field(
        &mut frame,
        match envelope.file_kind {
            CrashDraftFileKind::Markdown => b"markdown",
            CrashDraftFileKind::Html => b"html",
            CrashDraftFileKind::Excalidraw => b"excalidraw",
        },
    );
    frame_field(&mut frame, &envelope.revision.to_be_bytes());
    frame_field(&mut frame, &envelope.updated_at_ms.to_be_bytes());
    frame_option(&mut frame, envelope.path_hint.as_deref());
    frame_option(&mut frame, envelope.base_version_token.as_deref());
    frame_field(&mut frame, envelope.content.as_bytes());
    lowercase_hex(&Sha256::digest(frame))
}

pub(crate) fn frame_option(frame: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(value) => {
            frame.push(1);
            frame_field(frame, value.as_bytes());
        }
        None => frame.push(0),
    }
}

pub(crate) fn frame_field(frame: &mut Vec<u8>, bytes: &[u8]) {
    frame.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    frame.extend_from_slice(bytes);
}
