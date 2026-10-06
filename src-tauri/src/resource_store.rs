use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{
    commands::allow_asset_preview_directory,
    excalidraw_scene::validate_excalidraw_scene,
    path_auth::{
        authorize_resource_directory_inner, open_exact_workspace_file_for_read_inner,
        path_is_under, resolve_authorized_workspace_result_file_inner,
        resolve_authorized_workspace_root_for_token_inner, AuthorizedWorkspace,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
};

const MAX_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
const STAGING_ATTEMPTS: usize = 32;
static RESOURCE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
thread_local! {
    static TEST_FAULT: std::cell::RefCell<Option<TestFault>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestFault {
    PartialStagedWrite,
    FailPngReplace,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteWorkspaceResourceRequest {
    workspace_token: String,
    workspace_root: String,
    document_path: String,
    resource_directory: String,
    bytes_base64: String,
    mime_type: String,
    suggested_name: Option<String>,
    trusted_generated: Option<bool>,
    resource_directory_token: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteWorkspaceResourceResponse {
    pub(crate) relative_path: String,
    pub(crate) markdown_path: String,
    pub(crate) file_name: String,
    pub(crate) digest_md5: String,
    pub(crate) created: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceDirectoryAuthorizationResponse {
    pub(crate) path: String,
    pub(crate) token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PickMediaResourcesInput {
    media_kind: String,
    default_directory: String,
    workspace_token: String,
    workspace_root: String,
    document_path: String,
    resource_directory: String,
    resource_directory_token: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedMediaResource {
    pub(crate) name: String,
    pub(crate) markdown_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickMediaResourcesResponse {
    pub(crate) resources: Vec<PickedMediaResource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteExcalidrawAssetPairRequest {
    workspace_token: String,
    workspace_root: String,
    document_path: String,
    source_relative_path: String,
    source_content: String,
    resource_directory: String,
    resource_directory_token: Option<String>,
    svg_base64: String,
    png_base64: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteExcalidrawAssetPairResponse {
    pub(crate) svg_markdown_path: String,
    pub(crate) png_markdown_path: String,
    pub(crate) svg_file_name: String,
    pub(crate) png_file_name: String,
    pub(crate) source_sha256: String,
    pub(crate) updated: bool,
}

enum ResourceDirectoryTarget {
    Relative(PathBuf),
    Absolute(PathBuf),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResourceImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

impl ResourceImageKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Svg => "svg",
        }
    }

    fn from_mime(mime_type: &str) -> Result<Self, String> {
        match mime_type.trim().to_ascii_lowercase().as_str() {
            "image/png" => Ok(Self::Png),
            "image/jpeg" | "image/jpg" => Ok(Self::Jpeg),
            "image/gif" => Ok(Self::Gif),
            "image/webp" => Ok(Self::Webp),
            "image/svg+xml" => Ok(Self::Svg),
            _ => Err("Resource image type is not supported".to_string()),
        }
    }

    fn validate(self, bytes: &[u8], trusted_generated: bool) -> Result<(), String> {
        match self {
            Self::Png if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(()),
            Self::Jpeg if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Ok(()),
            Self::Gif if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Ok(()),
            Self::Webp
                if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" =>
            {
                Ok(())
            }
            Self::Svg if trusted_generated => validate_trusted_svg_resource(bytes),
            Self::Svg => {
                Err("Clipboard SVG resources require a trusted generated source".to_string())
            }
            _ => Err("Resource bytes do not match the declared image type".to_string()),
        }
    }
}


mod excalidraw_pair;
mod excalidraw_publish;
mod secure_fs {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) use super::secure_fs_unix::*;
    #[cfg(windows)]
    pub(super) use super::secure_fs_windows::*;
    #[cfg(windows)]
    pub(super) use super::secure_fs_windows_ops::*;
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub(super) use super::secure_fs_stub::*;
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod secure_fs_unix;
#[cfg(windows)]
mod secure_fs_windows;
#[cfg(windows)]
mod secure_fs_windows_ops;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod secure_fs_stub;
mod media_pick;
mod pick_dialog;
mod publish;
mod publish_steps;
mod staging;
mod validate;
mod write_resource;
#[cfg(test)]
pub(crate) mod test_prelude;
#[cfg(test)]
mod group0_tests;
#[cfg(test)]
mod group1_tests;
#[cfg(test)]
mod group2_tests;
#[cfg(test)]
mod group3_tests;

pub(crate) use excalidraw_pair::*;
#[cfg(windows)]
pub(crate) use secure_fs_windows::*;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) use secure_fs_stub::*;
pub(crate) use media_pick::*;
pub(crate) use pick_dialog::*;
pub(crate) use publish::*;
pub(crate) use staging::*;
pub(crate) use validate::*;
pub(crate) use write_resource::*;
