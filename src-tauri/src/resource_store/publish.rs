//! No-replace and replace publication with ownership transfer.
use super::publish_steps::{
    ensure_generated_asset_directory_unchanged, ensure_resource_directory_unchanged,
    generated_asset_requires_replace, publish_staged_generated_asset, publish_staged_no_replace,
    stage_generated_asset, stage_resource_bytes,
};
use super::*;

pub(crate) fn publish_resource_no_replace(
    workspace: &AuthorizedWorkspace,
    resource_directory: &Path,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    let root_handle = workspace
        .clone_root_handle()
        .map_err(|error| format!("Cannot retain authorized workspace root: {error}"))?;
    let directory = secure_fs::mkdirs_open_final(&root_handle, resource_directory)
        .map_err(|error| format!("Cannot create resource directory securely: {error}"))?;
    let directory_identity = crate::commands::opened_file_platform_identity(&directory)
        .map_err(|error| format!("Cannot identify resource directory: {error}"))?;
    let Some((staged_name, staged)) =
        stage_resource_bytes(&directory, file_name, bytes, digest_md5)?
    else {
        return verify_existing_resource(&directory, file_name, bytes, digest_md5);
    };

    #[cfg(test)]
    crate::resource_store::test_prelude::run_before_publish_hook();

    ensure_resource_directory_unchanged(
        &root_handle,
        resource_directory,
        &directory,
        &staged_name,
        &directory_identity,
    )?;
    publish_staged_no_replace(
        &directory,
        staged,
        &staged_name,
        file_name,
        bytes,
        digest_md5,
    )
}

pub(crate) fn publish_resource_replace(
    workspace: &AuthorizedWorkspace,
    resource_directory: &Path,
    file_name: &str,
    bytes: &[u8],
    digest_md5: &str,
) -> Result<bool, String> {
    let root_handle = workspace
        .clone_root_handle()
        .map_err(|error| format!("Cannot retain authorized resource root: {error}"))?;
    let directory = secure_fs::mkdirs_open_final(&root_handle, resource_directory)
        .map_err(|error| format!("Cannot create generated asset directory securely: {error}"))?;
    let directory_identity = crate::commands::opened_file_platform_identity(&directory)
        .map_err(|error| format!("Cannot identify generated asset directory: {error}"))?;
    if !generated_asset_requires_replace(&directory, file_name, bytes, digest_md5)? {
        return Ok(false);
    }
    let (staged_name, _staged) = stage_generated_asset(&directory, file_name, bytes, digest_md5)?;
    ensure_generated_asset_directory_unchanged(
        &root_handle,
        resource_directory,
        &directory,
        &staged_name,
        &directory_identity,
    )?;
    publish_staged_generated_asset(&directory, &staged_name, file_name, bytes, digest_md5)
}

pub(crate) fn ensure_excalidraw_asset_ownership(
    workspace: &AuthorizedWorkspace,
    asset_directory: &Path,
    ownership_file_name: &str,
    ownership: &[u8],
    svg_file_name: &str,
    png_file_name: &str,
) -> Result<bool, String> {
    let root_handle = workspace
        .clone_root_handle()
        .map_err(|error| format!("Cannot retain authorized resource root: {error}"))?;
    let directory = secure_fs::mkdirs_open_final(&root_handle, asset_directory)
        .map_err(|error| format!("Cannot create generated asset directory securely: {error}"))?;
    match secure_fs::open_existing_file_at(&directory, ownership_file_name) {
        Ok(existing) => {
            if file_bytes_match(existing, ownership, &md5_hex(ownership))
                .map_err(|error| format!("Cannot verify Excalidraw asset ownership: {error}"))?
            {
                return Ok(false);
            }
            return Err("Existing Excalidraw assets belong to a different source".to_string());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot inspect Excalidraw asset ownership without following links: {error}"
            ));
        }
    }
    for file_name in [svg_file_name, png_file_name] {
        match secure_fs::open_existing_file_at(&directory, file_name) {
            Ok(_) => {
                return Err(
                    "Existing generated asset has no matching Excalidraw source ownership"
                        .to_string(),
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Cannot inspect generated asset without following links: {error}"
                ));
            }
        }
    }
    Ok(true)
}
