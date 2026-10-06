//! Staging, directory-stability and publication steps for resource publishing.
use super::*;

pub(super) fn stage_resource_bytes(
    directory: &File,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<Option<(String, File)>, String> {
    let (staged_name, mut staged) = match create_staged_file(directory, file_name) {
        Ok(staged) => staged,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(None);
        }
        Err(error) => return Err(format!("Cannot create resource staging file: {error}")),
    };
    let write_result: Result<(), io::Error> = (|| {
        #[cfg(test)]
        if TEST_FAULT.with(|fault| fault.borrow_mut().take()) == Some(TestFault::PartialStagedWrite)
        {
            staged.write_all(&bytes[..bytes.len() / 2])?;
            return Err(io::Error::other("injected partial resource write failure"));
        }
        staged.write_all(bytes)?;
        staged.flush()?;
        staged.sync_all()?;
        if !file_bytes_match(staged.try_clone()?, bytes, digest_md5)? {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "staged resource changed before publication",
            ));
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        secure_fs::unlink_at(directory, &staged_name);
        return Err(format!("Cannot write staged resource: {error}"));
    }
    Ok(Some((staged_name, staged)))
}

pub(super) fn ensure_resource_directory_unchanged(
    root_handle: &File,
    resource_directory: &Path,
    directory: &File,
    staged_name: &str,
    directory_identity: &str,
) -> Result<(), String> {
    let current_directory = match secure_fs::mkdirs_open_final(root_handle, resource_directory) {
        Ok(current_directory) => current_directory,
        Err(error) => {
            secure_fs::unlink_at(directory, staged_name);
            return Err(format!(
                "Resource directory changed before publication: {error}"
            ));
        }
    };
    let current_directory_identity =
        crate::commands::opened_file_platform_identity(&current_directory)
            .map_err(|error| format!("Cannot identify current resource directory: {error}"))?;
    if current_directory_identity != directory_identity {
        secure_fs::unlink_at(directory, staged_name);
        return Err("Resource directory changed before publication".to_string());
    }
    Ok(())
}

pub(super) fn publish_staged_no_replace(
    directory: &File,
    staged: File,
    staged_name: &str,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    match secure_fs::publish_no_replace(directory, staged_name, file_name) {
        Ok(()) => {
            if !file_bytes_match(staged, bytes, digest_md5)
                .map_err(|error| format!("Cannot verify staged resource binding: {error}"))?
            {
                return Err("Staged resource changed during publication".to_string());
            }
            secure_fs::sync_directory(directory)
                .map_err(|error| format!("Cannot synchronize resource directory: {error}"))?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            secure_fs::unlink_at(directory, staged_name);
            verify_existing_resource(directory, file_name, bytes, digest_md5)
        }
        Err(error) => {
            secure_fs::unlink_at(directory, staged_name);
            Err(format!("Cannot publish resource atomically: {error}"))
        }
    }
}

pub(super) fn generated_asset_requires_replace(
    directory: &File,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    match secure_fs::open_existing_file_at(directory, file_name) {
        Ok(existing) => {
            if file_bytes_match(existing, bytes, digest_md5)
                .map_err(|error| format!("Cannot verify generated asset: {error}"))?
            {
                return Ok(false);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot inspect generated asset without following links: {error}"
            ));
        }
    }
    Ok(true)
}

pub(super) fn stage_generated_asset(
    directory: &File,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<(String, File), String> {
    let (staged_name, mut staged) = create_staged_file(directory, file_name)
        .map_err(|error| format!("Cannot create generated asset staging file: {error}"))?;
    let write_result: Result<(), io::Error> = (|| {
        staged.write_all(bytes)?;
        staged.flush()?;
        staged.sync_all()?;
        if !file_bytes_match(staged.try_clone()?, bytes, digest_md5)? {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "generated asset changed before publication",
            ));
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        secure_fs::unlink_at(directory, &staged_name);
        return Err(format!("Cannot write generated asset: {error}"));
    }
    Ok((staged_name, staged))
}

pub(super) fn ensure_generated_asset_directory_unchanged(
    root_handle: &File,
    resource_directory: &Path,
    directory: &File,
    staged_name: &str,
    directory_identity: &str,
) -> Result<(), String> {
    let current_directory =
        secure_fs::mkdirs_open_final(root_handle, resource_directory).map_err(|error| {
            format!("Generated asset directory changed before publication: {error}")
        })?;
    let current_identity = crate::commands::opened_file_platform_identity(&current_directory)
        .map_err(|error| format!("Cannot identify current generated asset directory: {error}"))?;
    if current_identity != directory_identity {
        secure_fs::unlink_at(directory, staged_name);
        return Err("Generated asset directory changed before publication".to_string());
    }
    Ok(())
}

pub(super) fn publish_staged_generated_asset(
    directory: &File,
    staged_name: &str,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    #[cfg(test)]
    if file_name.ends_with(".png")
        && TEST_FAULT.with(|fault| fault.borrow_mut().take()) == Some(TestFault::FailPngReplace)
    {
        secure_fs::unlink_at(directory, staged_name);
        return Err(
            "Cannot replace generated asset atomically: injected PNG publication failure"
                .to_string(),
        );
    }
    if let Err(error) = secure_fs::publish_replace(directory, staged_name, file_name) {
        secure_fs::unlink_at(directory, staged_name);
        return Err(format!(
            "Cannot replace generated asset atomically: {error}"
        ));
    }
    let published = secure_fs::open_existing_file_at(directory, file_name)
        .map_err(|error| format!("Cannot reopen generated asset: {error}"))?;
    if !file_bytes_match(published, bytes, digest_md5)
        .map_err(|error| format!("Cannot verify generated asset publication: {error}"))?
    {
        return Err("Generated asset changed during publication".to_string());
    }
    secure_fs::sync_directory(directory)
        .map_err(|error| format!("Cannot synchronize generated asset directory: {error}"))?;
    Ok(true)
}
