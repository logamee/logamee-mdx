use super::{malformed_archive, read_u16, read_u32, read_u64,
    ZIP32_SIZE_SENTINEL, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE,
    ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LEN, ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_LEN,
    ZIP64_END_OF_CENTRAL_DIRECTORY_MIN_RECORD_SIZE, ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
    ZIP64_EXTRA_FIELD_ID, END_OF_CENTRAL_DIRECTORY_SIGNATURE, END_OF_CENTRAL_DIRECTORY_LEN,
    MAX_ZIP_COMMENT_LEN,
    field_offset};

pub(super) struct CentralDirectoryMetadata {
    pub(super) entry_count: u64,
    pub(super) start: u64,
    pub(super) size: u64,
    pub(super) trailer_start: u64,
}

pub(super) fn find_end_of_central_directory(bytes: &[u8]) -> Result<usize, String> {
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

pub(super) fn central_directory_metadata(bytes: &[u8]) -> Result<CentralDirectoryMetadata, String> {
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

pub(super) fn zip64_central_directory_metadata(
    bytes: &[u8],
    eocd_offset: usize,
    classic_entries_on_disk: u16,
    classic_total_entries: u16,
    classic_central_directory_size: u32,
    classic_central_directory_start: u32,
) -> Result<CentralDirectoryMetadata, String> {
    let (locator_offset, zip64_eocd_offset) = zip64_locator_offsets(bytes, eocd_offset)?;
    validate_zip64_eocd_record(bytes, zip64_eocd_offset, locator_offset)?;

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

fn zip64_locator_offsets(bytes: &[u8], eocd_offset: usize) -> Result<(usize, usize), String> {
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
    Ok((locator_offset, zip64_eocd_offset))
}

fn validate_zip64_eocd_record(
    bytes: &[u8],
    zip64_eocd_offset: usize,
    locator_offset: usize,
) -> Result<(), String> {
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
    Ok(())
}

pub(super) fn zip64_sizes(
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
