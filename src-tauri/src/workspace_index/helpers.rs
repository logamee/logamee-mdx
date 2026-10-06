//! Path and content normalization helpers for indexing.
use std::time::Instant;
use crate::private_fs::lowercase_hex;

use super::cancellation::CancellationToken;
use crate::workspace_file_kind::WorkspaceFileKind;
use super::core::QueryLocation;
use super::IndexDocument;
use sha2::{Digest, Sha256};

pub(super) fn default_sample_count() -> usize {
    1
}

pub(super) fn elapsed_micros(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

#[cfg(unix)]
pub(super) fn process_peak_rss_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `usage` points to writable storage for `getrusage`, and is read only
    // after the OS reports success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let peak = unsafe { usage.assume_init() }.ru_maxrss;
    let peak = u64::try_from(peak).ok()?;
    #[cfg(target_os = "macos")]
    {
        Some(peak)
    }
    #[cfg(not(target_os = "macos"))]
    {
        peak.checked_mul(1024)
    }
}

#[cfg(not(unix))]
pub(super) fn process_peak_rss_bytes() -> Option<u64> {
    None
}

pub(super) fn normalize_relative_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.ends_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || normalized.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    Some(normalized)
}

pub(super) fn is_supported_markdown_path(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        let normalized = extension.to_ascii_lowercase();
        WorkspaceFileKind::Markdown
            .extensions()
            .contains(&normalized.as_str())
    })
}

pub(super) fn normalize_for_search(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        append_casefolded(&mut normalized, character);
    }
    normalized
}

pub(super) fn normalize_content(value: &str, cancellation: &CancellationToken) -> Option<String> {
    let mut normalized = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if index % 4096 == 0 && cancellation.is_cancelled() {
            return None;
        }
        append_casefolded(&mut normalized, character);
    }
    Some(normalized)
}

pub(super) fn bounded_snippet(
    content: &str,
    normalized_content: &str,
    first_term: &str,
    max_chars: usize,
) -> String {
    if max_chars == 0 {
        return String::new();
    }
    // Lowercasing can change byte lengths, so use the match only as an approximate
    // character anchor and slice the original exclusively at character boundaries.
    let byte_anchor = normalized_content.find(first_term).unwrap_or(0);
    let anchor_chars = normalized_content[..byte_anchor].chars().count();
    let total_chars = content.chars().count();
    let start = anchor_chars.saturating_sub(max_chars / 3).min(total_chars);
    content.chars().skip(start).take(max_chars).collect()
}

pub(super) fn source_location_for_normalized_offset(content: &str, normalized_offset: usize) -> QueryLocation {
    let mut line = 1usize;
    let mut original_offset = 0usize;
    let mut normalized_cursor = 0usize;

    for character in content.chars() {
        let mut folded = String::new();
        append_casefolded(&mut folded, character);
        let next_normalized_cursor = normalized_cursor.saturating_add(folded.len());
        if normalized_offset < next_normalized_cursor {
            return QueryLocation {
                line,
                utf8_byte_offset: original_offset,
            };
        }
        normalized_cursor = next_normalized_cursor;
        original_offset = original_offset.saturating_add(character.len_utf8());
        if character == '\n' {
            line = line.saturating_add(1);
        }
    }

    QueryLocation {
        line,
        utf8_byte_offset: original_offset,
    }
}

pub(super) fn corpus_digest(documents: &[IndexDocument]) -> String {
    let mut digest = Sha256::new();
    for document in documents {
        let path_length = (document.relative_path.len() as u64).to_le_bytes();
        let content_length = (document.content.len() as u64).to_le_bytes();
        for bytes in [
            path_length.as_slice(),
            document.relative_path.as_bytes(),
            content_length.as_slice(),
            document.content.as_bytes(),
        ] {
            digest.update(bytes);
        }
    }
    format!("sha256-v1:{}", lowercase_hex(&digest.finalize()))
}

fn append_casefolded(output: &mut String, character: char) {
    // Full case folding differs from lowercasing for these common multi/special
    // mappings. Other characters use Unicode lowercase supplied by the standard
    // library; the schema ID versions this tokenizer contract.
    match character {
        '\u{00df}' | '\u{1e9e}' => output.push_str("ss"),
        '\u{03c2}' => output.push('\u{03c3}'),
        _ => output.extend(character.to_lowercase()),
    }
}
