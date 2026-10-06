//! Staged-file creation and existing-resource verification.
use super::*;

pub(crate) fn create_staged_file(directory: &File, final_name: &str) -> io::Result<(String, File)> {
    for index in 0..STAGING_ATTEMPTS {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let staged_name = format!(".{final_name}.tmp-{suffix}-{index}");
        match secure_fs::create_new_file_at(directory, &staged_name) {
            Ok(file) => return Ok((staged_name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique resource staging file",
    ))
}

pub(crate) fn file_bytes_match(mut file: File, expected: &[u8], expected_digest: &str) -> io::Result<bool> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_RESOURCE_BYTES as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Ok(false);
    }
    Ok(bytes == expected && md5_hex(&bytes) == expected_digest)
}

pub(crate) fn verify_existing_resource(
    directory: &File,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    let first = secure_fs::open_existing_file_at(directory, file_name).map_err(|error| {
        format!("Cannot open existing resource without following links: {error}")
    })?;
    let first_metadata = first
        .metadata()
        .map_err(|error| format!("Cannot inspect existing resource: {error}"))?;
    let first_identity = crate::commands::opened_file_platform_identity(&first)
        .map_err(|error| format!("Cannot identify existing resource: {error}"))?;
    if !file_bytes_match(first, bytes, digest_md5)
        .map_err(|error| format!("Cannot verify existing resource: {error}"))?
    {
        return Err("Existing resource name collides with different bytes".to_string());
    }
    let second = secure_fs::open_existing_file_at(directory, file_name).map_err(|error| {
        format!("Cannot reopen existing resource without following links: {error}")
    })?;
    let second_metadata = second
        .metadata()
        .map_err(|error| format!("Cannot inspect existing resource: {error}"))?;
    let second_identity = crate::commands::opened_file_platform_identity(&second)
        .map_err(|error| format!("Cannot identify existing resource: {error}"))?;
    if first_identity != second_identity || first_metadata.len() != second_metadata.len() {
        return Err("Existing resource changed during deduplication".to_string());
    }
    if !file_bytes_match(second, bytes, digest_md5)
        .map_err(|error| format!("Cannot verify existing resource: {error}"))?
    {
        return Err("Existing resource name collides with different bytes".to_string());
    }
    Ok(false)
}
