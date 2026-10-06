//! Excalidraw asset target planning and guarded publication steps.
use super::*;

pub(super) struct ExcalidrawAssetPlan {
    pub(super) resource_workspace: AuthorizedWorkspace,
    pub(super) asset_directory: PathBuf,
    pub(super) ownership_file_name: String,
    pub(super) ownership: Vec<u8>,
    pub(super) svg_file_name: String,
    pub(super) png_file_name: String,
    pub(super) svg_markdown_path: String,
    pub(super) png_markdown_path: String,
}

pub(super) fn plan_excalidraw_asset_paths(
    state: &AppState,
    input: &WriteExcalidrawAssetPairRequest,
    workspace: &AuthorizedWorkspace,
    document: &crate::path_auth::AuthorizedReadFile,
    resource_directory: ResourceDirectoryTarget,
    source_relative_path: &Path,
) -> Result<ExcalidrawAssetPlan, String> {
    let (resource_workspace, base_subdirectory) = resolve_resource_target(
        state,
        workspace,
        resource_directory,
        input.resource_directory_token.as_deref(),
    )?;
    let asset_directory = base_subdirectory.join("excalidraw-assets");
    let (ownership_file_name, svg_file_name, png_file_name) =
        stable_excalidraw_asset_names(source_relative_path)?;
    let ownership = forward_slash_path(source_relative_path)?.into_bytes();
    let svg_path = resource_workspace
        .root()
        .join(&asset_directory)
        .join(&svg_file_name);
    let png_path = resource_workspace
        .root()
        .join(&asset_directory)
        .join(&png_file_name);
    let document_directory = document
        .path()
        .parent()
        .ok_or_else(|| "Markdown document has no parent directory".to_string())?;
    let svg_markdown_path = markdown_relative_path(document_directory, &svg_path)?;
    let png_markdown_path = markdown_relative_path(document_directory, &png_path)?;
    Ok(ExcalidrawAssetPlan {
        resource_workspace,
        asset_directory,
        ownership_file_name,
        ownership,
        svg_file_name,
        png_file_name,
        svg_markdown_path,
        png_markdown_path,
    })
}

pub(super) fn stage_excalidraw_ownership(
    plan: &ExcalidrawAssetPlan,
) -> Result<(bool, File, Option<Vec<u8>>), String> {
    let ownership_created = ensure_excalidraw_asset_ownership(
        &plan.resource_workspace,
        &plan.asset_directory,
        &plan.ownership_file_name,
        &plan.ownership,
        &plan.svg_file_name,
        &plan.png_file_name,
    )?;
    if ownership_created {
        publish_resource_no_replace(
            &plan.resource_workspace,
            &plan.asset_directory,
            &plan.ownership_file_name,
            &plan.ownership,
            &md5_hex(&plan.ownership),
        )?;
    }
    let asset_root = plan
        .resource_workspace
        .clone_root_handle()
        .map_err(|error| format!("Cannot retain authorized asset root: {error}"))?;
    let asset_dir_handle = secure_fs::mkdirs_open_final(&asset_root, &plan.asset_directory)
        .map_err(|error| format!("Cannot open generated asset directory: {error}"))?;
    let previous_svg =
        match secure_fs::open_existing_file_at(&asset_dir_handle, &plan.svg_file_name) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                if let Err(error) = file.read_to_end(&mut bytes) {
                    if ownership_created {
                        let _ = secure_fs::unlink_at(&asset_dir_handle, &plan.ownership_file_name);
                    }
                    return Err(format!("Cannot snapshot SVG asset: {error}"));
                }
                Some(bytes)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                if ownership_created {
                    let _ = secure_fs::unlink_at(&asset_dir_handle, &plan.ownership_file_name);
                }
                return Err(format!("Cannot inspect existing SVG asset: {error}"));
            }
        };
    Ok((ownership_created, asset_dir_handle, previous_svg))
}

pub(super) fn publish_excalidraw_asset_pair(
    plan: &ExcalidrawAssetPlan,
    asset_dir_handle: &File,
    ownership_created: bool,
    previous_svg: Option<Vec<u8>>,
    svg: &[u8],
    png: &[u8],
) -> Result<(bool, bool), String> {
    let svg_updated = match publish_resource_replace(
        &plan.resource_workspace,
        &plan.asset_directory,
        &plan.svg_file_name,
        svg,
        &md5_hex(svg),
    ) {
        Ok(updated) => updated,
        Err(error) => {
            if ownership_created {
                let _ = secure_fs::unlink_at(asset_dir_handle, &plan.ownership_file_name);
            }
            return Err(error);
        }
    };
    let png_updated = match publish_resource_replace(
        &plan.resource_workspace,
        &plan.asset_directory,
        &plan.png_file_name,
        png,
        &md5_hex(png),
    ) {
        Ok(updated) => updated,
        Err(error) => {
            if let Some(previous) = previous_svg {
                let _ = publish_resource_replace(
                    &plan.resource_workspace,
                    &plan.asset_directory,
                    &plan.svg_file_name,
                    &previous,
                    &md5_hex(&previous),
                );
            } else {
                let _ = secure_fs::unlink_at(asset_dir_handle, &plan.svg_file_name);
            }
            if ownership_created {
                let _ = secure_fs::unlink_at(asset_dir_handle, &plan.ownership_file_name);
            }
            return Err(format!(
                "Cannot publish PNG asset; SVG was rolled back: {error}"
            ));
        }
    };
    Ok((svg_updated, png_updated))
}
