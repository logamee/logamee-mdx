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

struct CentralDirectoryMetadata {
    entry_count: u64,
    start: u64,
    size: u64,
    trailer_start: u64,
}

fn find_end_of_central_directory(bytes: &[u8]) -> Result<usize, String> {
    let latest = bytes
        .len()
        .checked_sub(END_OF_CENTRAL_DIRECTORY_LEN)
        .ok_or_else(malformed_archive)?;
    let earliest = bytes
        .len()
        .saturating_sub(END_OF_CENTRAL_DIRECTORY_LEN + MAX_ZIP_COMMENT_LEN);

    for offset in (earliest..=latest).rev() {
        if read_u32(bytes, offset)? != END_OF_CENTRAL_DIRECTORY_SIGNATURE {
            continue;
        }
        let comment_len = usize::from(read_u16(bytes, field_offset(offset, 20)?)?);
        let record_end = offset
            .checked_add(END_OF_CENTRAL_DIRECTORY_LEN)
            .and_then(|end| end.checked_add(comment_len))
            .ok_or_else(malformed_archive)?;
        if record_end == bytes.len() {
            return Ok(offset);
        }
    }

    Err(malformed_archive())
}

fn central_directory_metadata(bytes: &[u8]) -> Result<CentralDirectoryMetadata, String> {
    let eocd_offset = find_end_of_central_directory(bytes)?;
    let disk_number = read_u16(bytes, field_offset(eocd_offset, 4)?)?;
    let central_directory_disk = read_u16(bytes, field_offset(eocd_offset, 6)?)?;
    let entries_on_disk = read_u16(bytes, field_offset(eocd_offset, 8)?)?;
    let total_entries = read_u16(bytes, field_offset(eocd_offset, 10)?)?;
    let central_directory_size = read_u32(bytes, field_offset(eocd_offset, 12)?)?;
    let central_directory_start = read_u32(bytes, field_offset(eocd_offset, 16)?)?;

    if disk_number != 0 || central_directory_disk != 0 {
        return Err(malformed_archive());
    }

    let uses_zip64 = entries_on_disk == u16::MAX
        || total_entries == u16::MAX
        || central_directory_size == u32::MAX
        || central_directory_start == u32::MAX;
    if uses_zip64 {
        return zip64_central_directory_metadata(
            bytes,
            eocd_offset,
            entries_on_disk,
            total_entries,
            central_directory_size,
            central_directory_start,
        );
    }

    if entries_on_disk != total_entries {
        return Err(malformed_archive());
    }

    Ok(CentralDirectoryMetadata {
        entry_count: total_entries.into(),
        start: central_directory_start.into(),
        size: central_directory_size.into(),
        trailer_start: eocd_offset as u64,
    })
}

fn zip64_central_directory_metadata(
    bytes: &[u8],
    eocd_offset: usize,
    classic_entries_on_disk: u16,
    classic_total_entries: u16,
    classic_central_directory_size: u32,
    classic_central_directory_start: u32,
) -> Result<CentralDirectoryMetadata, String> {
    let locator_offset = eocd_offset
        .checked_sub(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LEN)
        .ok_or_else(malformed_archive)?;
    if read_u32(bytes, locator_offset)? != ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE {
        return Err(malformed_archive());
    }
    let zip64_disk = read_u32(bytes, field_offset(locator_offset, 4)?)?;
    let zip64_eocd_offset = read_u64(bytes, field_offset(locator_offset, 8)?)?;
    let total_disks = read_u32(bytes, field_offset(locator_offset, 16)?)?;
    if zip64_disk != 0 || total_disks != 1 {
        return Err(malformed_archive());
    }

    // Requiring the locator's archive-relative offset to also be the physical
    // offset deliberately rejects concatenated/prefixed ZIP archives.
    let zip64_eocd_offset = usize::try_from(zip64_eocd_offset).map_err(|_| malformed_archive())?;
    if read_u32(bytes, zip64_eocd_offset)? != ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE {
        return Err(malformed_archive());
    }
    let record_size = read_u64(bytes, field_offset(zip64_eocd_offset, 4)?)?;
    if record_size < ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_RECORD_SIZE {
        return Err(malformed_archive());
    }
    let record_size = usize::try_from(record_size).map_err(|_| malformed_archive())?;
    let record_end = zip64_eocd_offset
        .checked_add(12)
        .and_then(|offset| offset.checked_add(record_size))
        .ok_or_else(malformed_archive)?;
    if record_end != locator_offset
        || record_end
            < zip64_eocd_offset
                .checked_add(ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_LEN)
                .ok_or_else(malformed_archive)?
    {
        return Err(malformed_archive());
    }

    let disk_number = read_u32(bytes, field_offset(zip64_eocd_offset, 16)?)?;
    let central_directory_disk = read_u32(bytes, field_offset(zip64_eocd_offset, 20)?)?;
    let entries_on_disk = read_u64(bytes, field_offset(zip64_eocd_offset, 24)?)?;
    let total_entries = read_u64(bytes, field_offset(zip64_eocd_offset, 32)?)?;
    let central_directory_size = read_u64(bytes, field_offset(zip64_eocd_offset, 40)?)?;
    let central_directory_start = read_u64(bytes, field_offset(zip64_eocd_offset, 48)?)?;
    if disk_number != 0
        || central_directory_disk != 0
        || entries_on_disk != total_entries
        || (classic_entries_on_disk != u16::MAX
            && u64::from(classic_entries_on_disk) != entries_on_disk)
        || (classic_total_entries != u16::MAX && u64::from(classic_total_entries) != total_entries)
        || (classic_central_directory_size != u32::MAX
            && u64::from(classic_central_directory_size) != central_directory_size)
        || (classic_central_directory_start != u32::MAX
            && u64::from(classic_central_directory_start) != central_directory_start)
    {
        return Err(malformed_archive());
    }

    Ok(CentralDirectoryMetadata {
        entry_count: total_entries,
        start: central_directory_start,
        size: central_directory_size,
        trailer_start: zip64_eocd_offset as u64,
    })
}

fn zip64_sizes(
    compressed_size: u32,
    uncompressed_size: u32,
    extra: &[u8],
) -> Result<(u64, u64), String> {
    let needs_compressed = compressed_size == ZIP32_SIZE_SENTINEL;
    let needs_uncompressed = uncompressed_size == ZIP32_SIZE_SENTINEL;
    if !needs_compressed && !needs_uncompressed {
        return Ok((compressed_size.into(), uncompressed_size.into()));
    }

    let mut offset = 0;
    while offset < extra.len() {
        let field_id = read_u16(extra, offset)?;
        let field_len = usize::from(read_u16(extra, field_offset(offset, 2)?)?);
        offset = offset.checked_add(4).ok_or_else(malformed_archive)?;
        let field_end = offset
            .checked_add(field_len)
            .ok_or_else(malformed_archive)?;
        let field = extra.get(offset..field_end).ok_or_else(malformed_archive)?;
        offset = field_end;

        if field_id != ZIP64_EXTRA_FIELD_ID {
            continue;
        }

        let mut zip64_offset = 0;
        let expanded = if needs_uncompressed {
            let value = read_u64(field, zip64_offset)?;
            zip64_offset = zip64_offset.checked_add(8).ok_or_else(malformed_archive)?;
            value
        } else {
            uncompressed_size.into()
        };
        let compressed = if needs_compressed {
            read_u64(field, zip64_offset)?
        } else {
            compressed_size.into()
        };
        return Ok((compressed, expanded));
    }

    Err(malformed_archive())
}

pub(crate) fn preflight_docx_zip(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > DOCX_SOURCE_LIMIT_BYTES {
        return Err("DOCX source exceeds the 32 MiB limit".to_string());
    }

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
    let mut offset = usize::try_from(metadata.start).map_err(|_| malformed_archive())?;
    let central_directory_end = metadata
        .start
        .checked_add(metadata.size)
        .and_then(|end| usize::try_from(end).ok())
        .ok_or_else(malformed_archive)?;
    let mut entry_count = 0usize;
    let mut total_compressed = 0u64;
    let mut total_expanded = 0u64;

    while offset < central_directory_end {
        if read_u32(bytes, offset)? != CENTRAL_DIRECTORY_HEADER_SIGNATURE {
            return Err(malformed_archive());
        }
        let fixed_header_end = offset
            .checked_add(CENTRAL_DIRECTORY_HEADER_LEN)
            .ok_or_else(malformed_archive)?;
        if fixed_header_end > central_directory_end {
            return Err(malformed_archive());
        }
        let header = bytes
            .get(offset..fixed_header_end)
            .ok_or_else(malformed_archive)?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| "DOCX archive entry count overflow".to_string())?;
        if entry_count > DOCX_ENTRY_LIMIT {
            return Err("DOCX archive contains more than 10,000 entries".to_string());
        }

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

#[cfg(test)]
mod tests {
    use super::preflight_docx_zip;

    const REAL_COMPRESSED_DOCX: &[u8] =
        include_bytes!("../../test-fixtures/p2/docx/single-paragraph.docx");

    fn append_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn append_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn append_u64(bytes: &mut Vec<u8>, value: u64) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn one_entry_classic_zip() -> Vec<u8> {
        let mut bytes = Vec::new();
        append_u32(&mut bytes, 0x0403_4b50);
        append_u16(&mut bytes, 20);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);

        append_u32(&mut bytes, 0x0201_4b50);
        append_u16(&mut bytes, 20);
        append_u16(&mut bytes, 20);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);

        append_u32(&mut bytes, 0x0605_4b50);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 1);
        append_u16(&mut bytes, 1);
        append_u32(&mut bytes, 46);
        append_u32(&mut bytes, 30);
        append_u16(&mut bytes, 0);
        bytes
    }

    fn one_entry_zip64(shadow_central_directory: bool) -> Vec<u8> {
        let classic = one_entry_classic_zip();
        let mut bytes = classic[..76].to_vec();
        if shadow_central_directory {
            let mut shadow = classic[30..76].to_vec();
            shadow[24..28].copy_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&shadow);
        }
        let zip64_eocd_offset = bytes.len() as u64;

        append_u32(&mut bytes, 0x0606_4b50);
        append_u64(&mut bytes, 44);
        append_u16(&mut bytes, 45);
        append_u16(&mut bytes, 45);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u64(&mut bytes, 1);
        append_u64(&mut bytes, 1);
        append_u64(&mut bytes, 46);
        append_u64(&mut bytes, 30);

        append_u32(&mut bytes, 0x0706_4b50);
        append_u32(&mut bytes, 0);
        append_u64(&mut bytes, zip64_eocd_offset);
        append_u32(&mut bytes, 1);

        append_u32(&mut bytes, 0x0605_4b50);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, u16::MAX);
        append_u16(&mut bytes, u16::MAX);
        append_u32(&mut bytes, u32::MAX);
        append_u32(&mut bytes, u32::MAX);
        append_u16(&mut bytes, 0);
        bytes
    }

    #[test]
    fn accepts_real_compressed_docx_fixture() {
        assert_eq!(preflight_docx_zip(REAL_COMPRESSED_DOCX), Ok(()));
    }

    #[test]
    fn rejects_classic_eocd_entry_limit_before_parsing_central_directory() {
        let mut bytes = Vec::new();
        append_u32(&mut bytes, 0x0605_4b50);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 10_001);
        append_u16(&mut bytes, 10_001);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u16(&mut bytes, 0);

        assert_eq!(
            preflight_docx_zip(&bytes),
            Err("DOCX archive contains more than 10,000 entries".to_string())
        );
    }

    #[test]
    fn rejects_zip64_eocd_entry_limit_before_parsing_central_directory() {
        let mut bytes = Vec::new();
        append_u32(&mut bytes, 0x0606_4b50);
        append_u64(&mut bytes, 44);
        append_u16(&mut bytes, 45);
        append_u16(&mut bytes, 45);
        append_u32(&mut bytes, 0);
        append_u32(&mut bytes, 0);
        append_u64(&mut bytes, 10_001);
        append_u64(&mut bytes, 10_001);
        append_u64(&mut bytes, 0);
        append_u64(&mut bytes, 0);

        append_u32(&mut bytes, 0x0706_4b50);
        append_u32(&mut bytes, 0);
        append_u64(&mut bytes, 0);
        append_u32(&mut bytes, 1);

        append_u32(&mut bytes, 0x0605_4b50);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, 0);
        append_u16(&mut bytes, u16::MAX);
        append_u16(&mut bytes, u16::MAX);
        append_u32(&mut bytes, u32::MAX);
        append_u32(&mut bytes, u32::MAX);
        append_u16(&mut bytes, 0);

        assert_eq!(
            preflight_docx_zip(&bytes),
            Err("DOCX archive contains more than 10,000 entries".to_string())
        );
    }

    #[test]
    fn rejects_metadata_count_that_does_not_match_the_central_directory() {
        let mut bytes = one_entry_classic_zip();
        let eocd_offset = bytes.len() - 22;
        bytes[eocd_offset + 8..eocd_offset + 12].fill(0);

        assert_eq!(
            preflight_docx_zip(&bytes),
            Err("DOCX archive is malformed or truncated".to_string())
        );
    }

    #[test]
    fn rejects_classic_shadow_central_directory_before_eocd() {
        let mut bytes = one_entry_classic_zip();
        let eocd_offset = bytes.len() - 22;
        let mut shadow_central_directory = bytes[30..eocd_offset].to_vec();
        shadow_central_directory[24..28].copy_from_slice(&1u32.to_le_bytes());
        bytes.splice(eocd_offset..eocd_offset, shadow_central_directory);

        assert_eq!(
            preflight_docx_zip(&bytes),
            Err("DOCX archive is malformed or truncated".to_string())
        );
    }

    #[test]
    fn accepts_zip64_archive_without_central_directory_gap() {
        assert_eq!(preflight_docx_zip(&one_entry_zip64(false)), Ok(()));
    }

    #[test]
    fn rejects_zip64_shadow_central_directory_before_trailer() {
        assert_eq!(
            preflight_docx_zip(&one_entry_zip64(true)),
            Err("DOCX archive is malformed or truncated".to_string())
        );
    }
}
