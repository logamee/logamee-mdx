use std::io::Cursor;

const CENTRAL_DIRECTORY_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const CENTRAL_DIRECTORY_HEADER_LEN: usize = 46;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0605_4b50;
const END_OF_CENTRAL_DIRECTORY_LEN: usize = 22;
const MAX_ZIP_COMMENT_LEN: usize = u16::MAX as usize;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0606_4b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_LEN: usize = 56;
const ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_RECORD_SIZE: u64 = 44;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LEN: usize = 20;
const ZIP64_EXTRA_FIELD_ID: u16 = 0x0001;
const ZIP32_SIZE_SENTINEL: u32 = u32::MAX;

pub(crate) const DOCX_SOURCE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const DOCX_ENTRY_LIMIT: usize = 10_000;
const DOCX_EXPANDED_SIZE_LIMIT: u64 = 128 * 1024 * 1024;
const DOCX_EXPANSION_RATIO_LIMIT: u128 = 100;

const MALFORMED_DOCX_ARCHIVE: &str = "DOCX archive is malformed or truncated";

fn malformed_archive() -> String {
    MALFORMED_DOCX_ARCHIVE.to_string()
}

fn field_offset(base: usize, relative: usize) -> Result<usize, String> {
    base.checked_add(relative).ok_or_else(malformed_archive)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let end = offset.checked_add(2).ok_or_else(malformed_archive)?;
    let value = bytes.get(offset..end).ok_or_else(malformed_archive)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset.checked_add(4).ok_or_else(malformed_archive)?;
    let value = bytes.get(offset..end).ok_or_else(malformed_archive)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let end = offset.checked_add(8).ok_or_else(malformed_archive)?;
    let value = bytes.get(offset..end).ok_or_else(malformed_archive)?;
    Ok(u64::from_le_bytes([
        value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
    ]))
}

mod zip64;

use zip64::{central_directory_metadata, zip64_sizes};

pub(crate) fn preflight_docx_zip(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > DOCX_SOURCE_LIMIT_BYTES {
        return Err("DOCX source exceeds the 32 MiB limit".to_string());
    }

    let (metadata, mut offset, central_directory_end) = central_directory_layout(bytes)?;
    let mut entry_count = 0usize;
    let mut total_compressed = 0u64;
    let mut total_expanded = 0u64;

    while offset < central_directory_end {
        let header = central_directory_entry_header(bytes, offset, central_directory_end)?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| "DOCX archive entry count overflow".to_string())?;
        if entry_count > DOCX_ENTRY_LIMIT {
            return Err("DOCX archive contains more than 10,000 entries".to_string());
        }

        let (entry_end, compressed, expanded) =
            central_directory_entry_sizes(bytes, header, offset, central_directory_end)?;
        total_compressed = total_compressed
            .checked_add(compressed)
            .ok_or_else(|| "DOCX archive compressed size metadata overflow".to_string())?;
        total_expanded = total_expanded
            .checked_add(expanded)
            .ok_or_else(|| "DOCX archive expanded size metadata overflow".to_string())?;
        offset = entry_end;
    }

    if offset != central_directory_end || entry_count as u64 != metadata.entry_count {
        return Err(malformed_archive());
    }

    if total_expanded > DOCX_EXPANDED_SIZE_LIMIT {
        return Err("DOCX archive expands beyond the 128 MiB limit".to_string());
    }
    if total_compressed == 0 && total_expanded > 0 {
        return Err("DOCX archive aggregate has zero compressed bytes".to_string());
    }
    if u128::from(total_expanded)
        > u128::from(total_compressed).saturating_mul(DOCX_EXPANSION_RATIO_LIMIT)
    {
        return Err("DOCX archive aggregate expansion exceeds 100:1".to_string());
    }

    Ok(())
}

fn central_directory_layout(
    bytes: &[u8],
) -> Result<(zip64::CentralDirectoryMetadata, usize, usize), String> {
    let metadata = central_directory_metadata(bytes)?;
    if metadata.entry_count > DOCX_ENTRY_LIMIT as u64 {
        return Err("DOCX archive contains more than 10,000 entries".to_string());
    }
    let declared_central_directory_end = metadata
        .start
        .checked_add(metadata.size)
        .ok_or_else(malformed_archive)?;
    if declared_central_directory_end != metadata.trailer_start {
        return Err(malformed_archive());
    }

    let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| malformed_archive())?;
    // Metadata offsets are archive-relative. Requiring direct agreement with
    // the parser's absolute offset deliberately rejects prefixed archives.
    if archive.len() as u64 != metadata.entry_count
        || archive.central_directory_start() != metadata.start
    {
        return Err(malformed_archive());
    }
    let offset = usize::try_from(metadata.start).map_err(|_| malformed_archive())?;
    let central_directory_end = metadata
        .start
        .checked_add(metadata.size)
        .and_then(|end| usize::try_from(end).ok())
        .ok_or_else(malformed_archive)?;
    Ok((metadata, offset, central_directory_end))
}

fn central_directory_entry_header<'a>(
    bytes: &'a [u8],
    offset: usize,
    central_directory_end: usize,
) -> Result<&'a [u8], String> {
    if read_u32(bytes, offset)? != CENTRAL_DIRECTORY_HEADER_SIGNATURE {
        return Err(malformed_archive());
    }
    let fixed_header_end = offset
        .checked_add(CENTRAL_DIRECTORY_HEADER_LEN)
        .ok_or_else(malformed_archive)?;
    if fixed_header_end > central_directory_end {
        return Err(malformed_archive());
    }
    bytes
        .get(offset..fixed_header_end)
        .ok_or_else(malformed_archive)
}

fn central_directory_entry_sizes(
    bytes: &[u8],
    header: &[u8],
    offset: usize,
    central_directory_end: usize,
) -> Result<(usize, u64, u64), String> {
    let compressed_32 = read_u32(header, 20)?;
    let expanded_32 = read_u32(header, 24)?;
    let name_len = usize::from(read_u16(header, 28)?);
    let extra_len = usize::from(read_u16(header, 30)?);
    let comment_len = usize::from(read_u16(header, 32)?);
    let variable_len = name_len
        .checked_add(extra_len)
        .and_then(|length| length.checked_add(comment_len))
        .ok_or_else(malformed_archive)?;
    let entry_end = offset
        .checked_add(CENTRAL_DIRECTORY_HEADER_LEN)
        .and_then(|position| position.checked_add(variable_len))
        .ok_or_else(malformed_archive)?;
    if entry_end > central_directory_end {
        return Err(malformed_archive());
    }
    let extra_start = offset
        .checked_add(CENTRAL_DIRECTORY_HEADER_LEN)
        .and_then(|position| position.checked_add(name_len))
        .ok_or_else(malformed_archive)?;
    let extra_end = extra_start
        .checked_add(extra_len)
        .ok_or_else(malformed_archive)?;
    let extra = bytes
        .get(extra_start..extra_end)
        .ok_or_else(malformed_archive)?;
    bytes.get(offset..entry_end).ok_or_else(malformed_archive)?;

    let (compressed, expanded) = zip64_sizes(compressed_32, expanded_32, extra)?;
    if compressed == 0 && expanded > 0 {
        return Err(
            "DOCX archive declares nonzero output from zero compressed bytes".to_string(),
        );
    }
    if u128::from(expanded) > u128::from(compressed).saturating_mul(DOCX_EXPANSION_RATIO_LIMIT)
    {
        return Err("DOCX archive entry expansion exceeds 100:1".to_string());
    }
    Ok((entry_end, compressed, expanded))
}

#[cfg(test)]
mod tests;
