use std::{
    fs::File,
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

fn validate_trusted_svg_resource(bytes: &[u8]) -> Result<(), String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "SVG resource must be valid UTF-8".to_string())?;
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if !(trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg")))
    {
        return Err("SVG resource does not contain an SVG document".to_string());
    }
    let lower = trimmed
        .to_ascii_lowercase()
        .replace("http://www.w3.org/2000/svg", "")
        .replace("https://www.w3.org/2000/svg", "");
    if lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("data:")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains(" xlink:href=")
        || lower.contains(" href=")
        || lower.contains(" onload=")
        || lower.contains(" onclick=")
        || lower.contains(" onerror=")
    {
        return Err("SVG resource contains unsupported active or external content".to_string());
    }
    Ok(())
}

fn decode_resource_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() {
        return Err("Resource payload is empty".to_string());
    }
    let max_base64_len = MAX_RESOURCE_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_base64_len + 4 {
        return Err("Resource payload exceeds the 16 MiB limit".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Resource payload is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("Resource payload is empty".to_string());
    }
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err("Resource payload exceeds the 16 MiB limit".to_string());
    }
    Ok(bytes)
}

fn validate_resource_directory(path: &str) -> Result<ResourceDirectoryTarget, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("Resource directory is invalid".to_string());
    }
    let directory = Path::new(path);
    let mut normalized = PathBuf::new();
    for component in directory.components() {
        match component {
            Component::Prefix(prefix) if directory.is_absolute() => {
                normalized.push(prefix.as_os_str())
            }
            Component::RootDir if directory.is_absolute() => normalized.push(component.as_os_str()),
            Component::Normal(segment) => normalized.push(segment),
            _ => return Err("Resource directory must not contain parent traversal".to_string()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Resource directory is invalid".to_string());
    }
    if directory.is_absolute() {
        Ok(ResourceDirectoryTarget::Absolute(normalized))
    } else {
        Ok(ResourceDirectoryTarget::Relative(normalized))
    }
}

fn validate_source_relative_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("Excalidraw source path is invalid".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute() {
        return Err("Excalidraw source path must be workspace-relative".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            _ => return Err("Excalidraw source path must not contain traversal".to_string()),
        }
    }
    if WorkspaceFileKind::classify(&normalized) != Some(WorkspaceFileKind::Excalidraw) {
        return Err("Excalidraw asset source must be an .excalidraw file".to_string());
    }
    Ok(normalized)
}

fn stable_excalidraw_asset_names(
    source_relative_path: &Path,
) -> Result<(String, String, String), String> {
    let source_text = forward_slash_path(source_relative_path)?;
    let key = md5_hex(source_text.as_bytes());
    let stem = source_relative_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("drawing")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(48)
        .collect::<String>();
    let stem = if stem.is_empty() { "drawing" } else { &stem };
    let prefix = format!("{stem}-{}", &key[..12]);
    Ok((
        format!("{prefix}.source"),
        format!("{prefix}.svg"),
        format!("{prefix}.png"),
    ))
}

fn resolve_resource_target(
    state: &AppState,
    workspace: &AuthorizedWorkspace,
    target: ResourceDirectoryTarget,
    resource_directory_token: Option<&str>,
) -> Result<(AuthorizedWorkspace, PathBuf), String> {
    match target {
        ResourceDirectoryTarget::Relative(relative) => Ok((workspace.clone(), relative)),
        ResourceDirectoryTarget::Absolute(absolute) => {
            let token = resource_directory_token.ok_or_else(|| {
                "Absolute resource directory must be explicitly authorized for this session"
                    .to_string()
            })?;
            resolve_authorized_workspace_root_for_token_inner(state, token, &absolute)
                .map(|authorization| (authorization, PathBuf::new()))
        }
    }
}

fn validate_suggested_name(suggested_name: Option<&str>) -> Result<(), String> {
    let Some(suggested_name) = suggested_name else {
        return Ok(());
    };
    if suggested_name.is_empty() || suggested_name.len() > 128 {
        return Err("Suggested resource name is invalid".to_string());
    }
    let mut components = Path::new(suggested_name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("Suggested resource name is invalid".to_string());
    }
    Ok(())
}

fn md5_hex(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}

fn forward_slash_path(path: &Path) -> Result<String, String> {
    path.components()
        .map(|component| match component {
            Component::Normal(segment) => segment
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Resource path is not valid UTF-8".to_string()),
            _ => Err("Resource path contains invalid components".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|segments| segments.join("/"))
}

fn markdown_relative_path(base: &Path, target: &Path) -> Result<String, String> {
    if !base.is_absolute() || !target.is_absolute() {
        return Err("Resource Markdown paths require absolute inputs".to_string());
    }
    let base_components = base.components().collect::<Vec<_>>();
    let target_components = target.components().collect::<Vec<_>>();
    let common = base_components
        .iter()
        .zip(&target_components)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0 {
        return Err(
            "Resource directory must share a filesystem root with the document".to_string(),
        );
    }
    let mut segments = Vec::new();
    for component in &base_components[common..] {
        match component {
            Component::Normal(_) => segments.push("..".to_string()),
            Component::CurDir => {}
            _ => {
                return Err(
                    "Resource directory must share a filesystem root with the document".to_string(),
                )
            }
        }
    }
    for component in &target_components[common..] {
        match component {
            Component::Normal(segment) => segments.push(
                segment
                    .to_str()
                    .ok_or_else(|| "Resource path is not valid UTF-8".to_string())?
                    .to_string(),
            ),
            Component::CurDir => {}
            _ => return Err("Resource path contains invalid components".to_string()),
        }
    }
    if segments.is_empty() {
        return Err("Resource Markdown path is empty".to_string());
    }
    Ok(segments.join("/"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod secure_fs {
    use super::*;
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
    };

    fn c_name(path: &Path) -> io::Result<CString> {
        use std::os::unix::ffi::OsStrExt;
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL"))
    }

    fn component_name(component: Component<'_>) -> io::Result<CString> {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "relative path is invalid",
            ));
        };
        c_name(Path::new(name))
    }

    pub(super) fn mkdirs_open_final(root: &File, relative: &Path) -> io::Result<File> {
        let mut directory = root.try_clone()?;
        for component in relative.components() {
            let name = component_name(component)?;
            let mkdir_result =
                unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o755) };
            if mkdir_result == -1 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            let descriptor = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor == -1 {
                return Err(io::Error::last_os_error());
            }
            let opened = unsafe { File::from_raw_fd(descriptor) };
            if !opened.metadata()?.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "resource path component is not a directory",
                ));
            }
            directory = opened;
        }
        Ok(directory)
    }

    pub(super) fn create_new_file_at(directory: &File, name: &str) -> io::Result<File> {
        let name = CString::new(name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "created resource is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_existing_file_at(directory: &File, name: &str) -> io::Result<File> {
        let name = CString::new(name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "resource is not a regular file",
            ));
        }
        Ok(file)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn publish_no_replace(
        directory: &File,
        staged: &str,
        final_name: &str,
    ) -> io::Result<()> {
        let staged = CString::new(staged)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
        let final_name = CString::new(final_name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
        let result = unsafe {
            libc::renameat2(
                directory.as_raw_fd(),
                staged.as_ptr(),
                directory.as_raw_fd(),
                final_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn publish_no_replace(
        directory: &File,
        staged: &str,
        final_name: &str,
    ) -> io::Result<()> {
        let source = CString::new(staged)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
        let destination = CString::new(final_name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
        let result = unsafe {
            libc::renameatx_np(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(super) fn publish_replace(
        directory: &File,
        staged: &str,
        final_name: &str,
    ) -> io::Result<()> {
        let staged = CString::new(staged)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged name contains NUL"))?;
        let final_name = CString::new(final_name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))?;
        let result = unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                staged.as_ptr(),
                directory.as_raw_fd(),
                final_name.as_ptr(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(super) fn unlink_at(directory: &File, name: &str) {
        if let Ok(name) = CString::new(name) {
            unsafe {
                libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
            }
        }
    }

    pub(super) fn sync_directory(directory: &File) -> io::Result<()> {
        directory.sync_all()
    }
}

#[cfg(windows)]
mod secure_fs {
    use super::*;
    use std::{
        ffi::c_void,
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        ptr::{null, null_mut},
    };

    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                FileDispositionInformation, FileRenameInformation, NtCreateFile,
                NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE,
                FILE_DISPOSITION_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
                FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_RENAME_INFORMATION_0,
                FILE_SYNCHRONOUS_IO_NONALERT,
            },
        },
        Win32::{
            Foundation::{
                RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE,
                UNICODE_STRING,
            },
            Storage::FileSystem::{
                FileAttributeTagInfo, GetFileInformationByHandleEx, DELETE,
                FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
                FILE_ATTRIBUTE_TAG_INFO, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_DATA, SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };

    const DIRECTORY_SHARE_MODE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    const DIRECTORY_OPEN_OPTIONS: u32 =
        FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
    const REGULAR_FILE_OPEN_OPTIONS: u32 =
        FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;

    fn handle(file: &File) -> HANDLE {
        file.as_raw_handle() as HANDLE
    }

    fn invalid_input(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    fn permission_denied(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, message)
    }

    fn nt_error(status: i32) -> io::Error {
        let code = unsafe { RtlNtStatusToDosError(status) };
        io::Error::from_raw_os_error(code as i32)
    }

    fn relative_name(name: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
        let name = name.encode_wide().collect::<Vec<_>>();
        let byte_length = name
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or_else(|| invalid_input("resource name is too long"))?;
        if name.is_empty() || byte_length > u16::MAX as usize {
            return Err(invalid_input("resource name is too long"));
        }
        Ok(name)
    }

    fn file_name(name: &str) -> io::Result<Vec<u16>> {
        if name.is_empty() || name.contains(['\\', '/']) {
            return Err(invalid_input("resource file name is invalid"));
        }
        relative_name(std::ffi::OsStr::new(name))
    }

    fn nt_open_relative(
        directory: &File,
        name: &[u16],
        desired_access: u32,
        disposition: u32,
        open_options: u32,
    ) -> io::Result<File> {
        let unicode_name = UNICODE_STRING {
            Length: (name.len() * size_of::<u16>()) as u16,
            MaximumLength: (name.len() * size_of::<u16>()) as u16,
            Buffer: name.as_ptr() as *mut u16,
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(directory),
            ObjectName: &unicode_name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut io_status = IO_STATUS_BLOCK::default();
        let mut raw: HANDLE = null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                desired_access,
                &attributes,
                &mut io_status,
                null(),
                FILE_ATTRIBUTE_NORMAL,
                DIRECTORY_SHARE_MODE,
                disposition,
                open_options,
                null(),
                0,
            )
        };
        if status < 0 {
            return Err(nt_error(status));
        }
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::other("NtCreateFile returned an invalid handle"));
        }
        Ok(unsafe { File::from_raw_handle(raw as _) })
    }

    fn attribute_tag(file: &File) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
        let succeeded = unsafe {
            GetFileInformationByHandleEx(
                handle(file),
                FileAttributeTagInfo,
                (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };
        if succeeded == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(info)
        }
    }

    fn validate_directory(file: &File) -> io::Result<()> {
        let attributes = attribute_tag(file)?.FileAttributes;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(permission_denied("resource directory is a reparse point"));
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(invalid_input("resource path component is not a directory"));
        }
        Ok(())
    }

    fn validate_regular_file(file: &File) -> io::Result<()> {
        let attributes = attribute_tag(file)?.FileAttributes;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(permission_denied("resource is a reparse point"));
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return Err(invalid_input("resource is not a regular file"));
        }
        Ok(())
    }

    fn rename_relative(
        directory: &File,
        staged: &str,
        final_name: &str,
        replace: bool,
    ) -> io::Result<()> {
        let staged_name = file_name(staged)?;
        let destination_name = file_name(final_name)?;
        let source = nt_open_relative(
            directory,
            &staged_name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            REGULAR_FILE_OPEN_OPTIONS,
        )?;
        validate_regular_file(&source)?;
        let name_bytes = destination_name.len() * size_of::<u16>();
        let buffer_bytes = size_of::<FILE_RENAME_INFORMATION>() + name_bytes;
        let mut storage = vec![0_usize; buffer_bytes.div_ceil(size_of::<usize>())];
        let rename = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*rename).Anonymous = FILE_RENAME_INFORMATION_0 {
                ReplaceIfExists: replace,
            };
            (*rename).RootDirectory = handle(directory);
            (*rename).FileNameLength = name_bytes as u32;
            std::ptr::copy_nonoverlapping(
                destination_name.as_ptr(),
                std::ptr::addr_of_mut!((*rename).FileName).cast::<u16>(),
                destination_name.len(),
            );
        }
        let mut io_status = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtSetInformationFile(
                handle(&source),
                &mut io_status,
                rename.cast::<c_void>(),
                buffer_bytes as u32,
                FileRenameInformation,
            )
        };
        if status < 0 {
            Err(nt_error(status))
        } else {
            Ok(())
        }
    }

    fn delete_relative(directory: &File, name: &str) -> io::Result<()> {
        let name = file_name(name)?;
        let file = nt_open_relative(
            directory,
            &name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            REGULAR_FILE_OPEN_OPTIONS,
        )?;
        validate_regular_file(&file)?;
        let mut disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
        let mut io_status = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtSetInformationFile(
                handle(&file),
                &mut io_status,
                (&mut disposition as *mut FILE_DISPOSITION_INFORMATION).cast::<c_void>(),
                size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
                FileDispositionInformation,
            )
        };
        if status < 0 {
            Err(nt_error(status))
        } else {
            Ok(())
        }
    }

    pub(super) fn mkdirs_open_final(root: &File, relative: &Path) -> io::Result<File> {
        let mut current = root.try_clone()?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(invalid_input("relative resource directory is invalid"));
            };
            let name = relative_name(name)?;
            let next = nt_open_relative(
                &current,
                &name,
                FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
                FILE_OPEN_IF,
                DIRECTORY_OPEN_OPTIONS,
            )?;
            validate_directory(&next)?;
            current = next;
        }
        Ok(current)
    }

    pub(super) fn create_new_file_at(directory: &File, name: &str) -> io::Result<File> {
        let name = file_name(name)?;
        let file = nt_open_relative(
            directory,
            &name,
            FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_CREATE,
            REGULAR_FILE_OPEN_OPTIONS,
        )?;
        validate_regular_file(&file)?;
        Ok(file)
    }

    pub(super) fn open_existing_file_at(directory: &File, name: &str) -> io::Result<File> {
        let name = file_name(name)?;
        let file = nt_open_relative(
            directory,
            &name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            REGULAR_FILE_OPEN_OPTIONS,
        )?;
        validate_regular_file(&file)?;
        Ok(file)
    }

    pub(super) fn publish_no_replace(
        directory: &File,
        staged: &str,
        final_name: &str,
    ) -> io::Result<()> {
        rename_relative(directory, staged, final_name, false)
    }

    pub(super) fn publish_replace(
        directory: &File,
        staged: &str,
        final_name: &str,
    ) -> io::Result<()> {
        rename_relative(directory, staged, final_name, true)
    }

    pub(super) fn unlink_at(directory: &File, name: &str) {
        let _ = delete_relative(directory, name);
    }

    pub(super) fn sync_directory(_directory: &File) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod secure_fs {
    use super::*;

    pub(super) fn mkdirs_open_final(_root: &File, _relative: &Path) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn create_new_file_at(_directory: &File, _name: &str) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn open_existing_file_at(_directory: &File, _name: &str) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource writes are unsupported on this platform",
        ))
    }
    pub(super) fn publish_no_replace(
        _directory: &File,
        _staged: &str,
        _final_name: &str,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource publication is unsupported on this platform",
        ))
    }
    pub(super) fn publish_replace(
        _directory: &File,
        _staged: &str,
        _final_name: &str,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "handle-relative resource replacement is unsupported on this platform",
        ))
    }
    pub(super) fn unlink_at(_directory: &File, _name: &str) {}
    pub(super) fn sync_directory(_directory: &File) -> io::Result<()> {
        Ok(())
    }
}

fn create_staged_file(directory: &File, final_name: &str) -> io::Result<(String, File)> {
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

fn file_bytes_match(mut file: File, expected: &[u8], expected_digest: &str) -> io::Result<bool> {
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

fn verify_existing_resource(
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

fn publish_resource_no_replace(
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
    let (staged_name, mut staged) = match create_staged_file(&directory, file_name) {
        Ok(staged) => staged,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return verify_existing_resource(&directory, file_name, bytes, digest_md5);
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
        secure_fs::unlink_at(&directory, &staged_name);
        return Err(format!("Cannot write staged resource: {error}"));
    }

    #[cfg(test)]
    tests::run_before_publish_hook();

    let current_directory = match secure_fs::mkdirs_open_final(&root_handle, resource_directory) {
        Ok(current_directory) => current_directory,
        Err(error) => {
            secure_fs::unlink_at(&directory, &staged_name);
            return Err(format!(
                "Resource directory changed before publication: {error}"
            ));
        }
    };
    let current_directory_identity =
        crate::commands::opened_file_platform_identity(&current_directory)
            .map_err(|error| format!("Cannot identify current resource directory: {error}"))?;
    if current_directory_identity != directory_identity {
        secure_fs::unlink_at(&directory, &staged_name);
        return Err("Resource directory changed before publication".to_string());
    }

    match secure_fs::publish_no_replace(&directory, &staged_name, file_name) {
        Ok(()) => {
            if !file_bytes_match(staged, bytes, digest_md5)
                .map_err(|error| format!("Cannot verify staged resource binding: {error}"))?
            {
                return Err("Staged resource changed during publication".to_string());
            }
            secure_fs::sync_directory(&directory)
                .map_err(|error| format!("Cannot synchronize resource directory: {error}"))?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            secure_fs::unlink_at(&directory, &staged_name);
            verify_existing_resource(&directory, file_name, bytes, digest_md5)
        }
        Err(error) => {
            secure_fs::unlink_at(&directory, &staged_name);
            Err(format!("Cannot publish resource atomically: {error}"))
        }
    }
}

fn publish_resource_replace(
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
    match secure_fs::open_existing_file_at(&directory, file_name) {
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

    let (staged_name, mut staged) = create_staged_file(&directory, file_name)
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
        secure_fs::unlink_at(&directory, &staged_name);
        return Err(format!("Cannot write generated asset: {error}"));
    }

    let current_directory = secure_fs::mkdirs_open_final(&root_handle, resource_directory)
        .map_err(|error| {
            format!("Generated asset directory changed before publication: {error}")
        })?;
    let current_identity = crate::commands::opened_file_platform_identity(&current_directory)
        .map_err(|error| format!("Cannot identify current generated asset directory: {error}"))?;
    if current_identity != directory_identity {
        secure_fs::unlink_at(&directory, &staged_name);
        return Err("Generated asset directory changed before publication".to_string());
    }

    #[cfg(test)]
    if file_name.ends_with(".png")
        && TEST_FAULT.with(|fault| fault.borrow_mut().take()) == Some(TestFault::FailPngReplace)
    {
        secure_fs::unlink_at(&directory, &staged_name);
        return Err(
            "Cannot replace generated asset atomically: injected PNG publication failure"
                .to_string(),
        );
    }
    if let Err(error) = secure_fs::publish_replace(&directory, &staged_name, file_name) {
        secure_fs::unlink_at(&directory, &staged_name);
        return Err(format!(
            "Cannot replace generated asset atomically: {error}"
        ));
    }
    let published = secure_fs::open_existing_file_at(&directory, file_name)
        .map_err(|error| format!("Cannot reopen generated asset: {error}"))?;
    if !file_bytes_match(published, bytes, digest_md5)
        .map_err(|error| format!("Cannot verify generated asset publication: {error}"))?
    {
        return Err("Generated asset changed during publication".to_string());
    }
    secure_fs::sync_directory(&directory)
        .map_err(|error| format!("Cannot synchronize generated asset directory: {error}"))?;
    Ok(true)
}

fn ensure_excalidraw_asset_ownership(
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

pub(crate) fn write_workspace_resource_inner(
    state: &AppState,
    input: WriteWorkspaceResourceRequest,
) -> Result<WriteWorkspaceResourceResponse, String> {
    let resource_directory = validate_resource_directory(&input.resource_directory)?;
    validate_suggested_name(input.suggested_name.as_deref())?;
    let kind = ResourceImageKind::from_mime(&input.mime_type)?;
    let bytes = decode_resource_bytes(&input.bytes_base64)?;
    kind.validate(&bytes, input.trusted_generated.unwrap_or(false))?;
    let digest_md5 = md5_hex(&bytes);
    let file_name = format!("{digest_md5}.{}", kind.extension());

    let document = open_exact_workspace_file_for_read_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &input.document_path,
    )?;
    if WorkspaceFileKind::classify(document.path()) != Some(WorkspaceFileKind::Markdown) {
        return Err("Resource writes require an authorized Markdown document".to_string());
    }
    let workspace_auth = document
        .workspace_authorization()
        .ok_or_else(|| "Document is not authorized through the selected workspace".to_string())?;
    if workspace_auth.wire_token() != input.workspace_token {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    let _document_binding = workspace_auth.retained_file_binding();
    let workspace = resolve_authorized_workspace_root_for_token_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
    )?;
    if workspace.root() != workspace_auth.root()
        || !path_is_under(document.path(), workspace.root())
    {
        return Err("Document authorization does not match the selected workspace".to_string());
    }

    let (resource_workspace, resource_subdirectory) = resolve_resource_target(
        state,
        &workspace,
        resource_directory,
        input.resource_directory_token.as_deref(),
    )?;
    let resource_path = resource_workspace
        .root()
        .join(&resource_subdirectory)
        .join(&file_name);
    let document_directory = document
        .path()
        .parent()
        .ok_or_else(|| "Markdown document has no parent directory".to_string())?;
    let markdown_path = markdown_relative_path(document_directory, &resource_path)?;

    let _write_guard = RESOURCE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&resource_workspace)?;
    let created = publish_resource_no_replace(
        &resource_workspace,
        &resource_subdirectory,
        &file_name,
        &bytes,
        &digest_md5,
    )?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&resource_workspace)?;

    let relative_path = if resource_workspace.root() == workspace.root() {
        forward_slash_path(&resource_subdirectory.join(&file_name))?
    } else {
        markdown_path.clone()
    };
    Ok(WriteWorkspaceResourceResponse {
        relative_path,
        markdown_path,
        file_name,
        digest_md5,
        created,
    })
}

#[tauri::command]
pub(crate) fn write_workspace_resource(
    input: WriteWorkspaceResourceRequest,
    state: State<'_, AppState>,
) -> Result<WriteWorkspaceResourceResponse, String> {
    write_workspace_resource_inner(&state, input)
}

pub(crate) fn write_excalidraw_asset_pair_inner(
    state: &AppState,
    input: WriteExcalidrawAssetPairRequest,
) -> Result<WriteExcalidrawAssetPairResponse, String> {
    let resource_directory = validate_resource_directory(&input.resource_directory)?;
    let source_relative_path = validate_source_relative_path(&input.source_relative_path)?;
    if input.source_content.len() > MAX_RESOURCE_BYTES {
        return Err("Excalidraw source exceeds the 16 MiB asset-sync limit".to_string());
    }
    validate_excalidraw_scene(&input.source_content)?;
    let svg = decode_resource_bytes(&input.svg_base64)?;
    let png = decode_resource_bytes(&input.png_base64)?;
    ResourceImageKind::Svg.validate(&svg, true)?;
    ResourceImageKind::Png.validate(&png, true)?;

    let document = open_exact_workspace_file_for_read_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &input.document_path,
    )?;
    if WorkspaceFileKind::classify(document.path()) != Some(WorkspaceFileKind::Markdown) {
        return Err("Excalidraw asset sync requires an authorized Markdown document".to_string());
    }
    let workspace_auth = document
        .workspace_authorization()
        .ok_or_else(|| "Document is not authorized through the selected workspace".to_string())?;
    if workspace_auth.wire_token() != input.workspace_token {
        return Err("Document authorization does not match the selected workspace".to_string());
    }
    let _document_binding = workspace_auth.retained_file_binding();
    let workspace = resolve_authorized_workspace_root_for_token_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
    )?;
    if workspace.root() != workspace_auth.root()
        || !path_is_under(document.path(), workspace.root())
    {
        return Err("Document authorization does not match the selected workspace".to_string());
    }

    let (source_workspace, source_path) = resolve_authorized_workspace_result_file_inner(
        state,
        &input.workspace_token,
        &input.workspace_root,
        &forward_slash_path(&source_relative_path)?,
    )?;
    if WorkspaceFileKind::classify(&source_path) != Some(WorkspaceFileKind::Excalidraw) {
        return Err("Excalidraw asset source is not an .excalidraw file".to_string());
    }
    let mut source_file = source_workspace
        .open_regular_file(&source_path)
        .map_err(|error| format!("Cannot securely read Excalidraw asset source: {error}"))?;
    let mut source_bytes = Vec::new();
    Read::by_ref(&mut source_file)
        .take((MAX_RESOURCE_BYTES as u64).saturating_add(1))
        .read_to_end(&mut source_bytes)
        .map_err(|error| format!("Cannot read Excalidraw asset source: {error}"))?;
    if source_bytes.len() > MAX_RESOURCE_BYTES {
        return Err("Excalidraw source exceeds the 16 MiB asset-sync limit".to_string());
    }
    if source_bytes != input.source_content.as_bytes() {
        return Err("Excalidraw source changed before generated assets were written".to_string());
    }

    let (resource_workspace, base_subdirectory) = resolve_resource_target(
        state,
        &workspace,
        resource_directory,
        input.resource_directory_token.as_deref(),
    )?;
    let asset_directory = base_subdirectory.join("excalidraw-assets");
    let (ownership_file_name, svg_file_name, png_file_name) =
        stable_excalidraw_asset_names(&source_relative_path)?;
    let ownership = forward_slash_path(&source_relative_path)?.into_bytes();
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

    let _write_guard = RESOURCE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&source_workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&resource_workspace)?;

    let ownership_created = ensure_excalidraw_asset_ownership(
        &resource_workspace,
        &asset_directory,
        &ownership_file_name,
        &ownership,
        &svg_file_name,
        &png_file_name,
    )?;
    if ownership_created {
        publish_resource_no_replace(
            &resource_workspace,
            &asset_directory,
            &ownership_file_name,
            &ownership,
            &md5_hex(&ownership),
        )?;
    }
    let asset_root = resource_workspace
        .clone_root_handle()
        .map_err(|error| format!("Cannot retain authorized asset root: {error}"))?;
    let asset_dir_handle = secure_fs::mkdirs_open_final(&asset_root, &asset_directory)
        .map_err(|error| format!("Cannot open generated asset directory: {error}"))?;
    let previous_svg = match secure_fs::open_existing_file_at(&asset_dir_handle, &svg_file_name) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            if let Err(error) = file.read_to_end(&mut bytes) {
                if ownership_created {
                    let _ = secure_fs::unlink_at(&asset_dir_handle, &ownership_file_name);
                }
                return Err(format!("Cannot snapshot SVG asset: {error}"));
            }
            Some(bytes)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            if ownership_created {
                let _ = secure_fs::unlink_at(&asset_dir_handle, &ownership_file_name);
            }
            return Err(format!("Cannot inspect existing SVG asset: {error}"));
        }
    };
    let svg_updated = match publish_resource_replace(
        &resource_workspace,
        &asset_directory,
        &svg_file_name,
        &svg,
        &md5_hex(&svg),
    ) {
        Ok(updated) => updated,
        Err(error) => {
            if ownership_created {
                let _ = secure_fs::unlink_at(&asset_dir_handle, &ownership_file_name);
            }
            return Err(error);
        }
    };
    let png_updated = match publish_resource_replace(
        &resource_workspace,
        &asset_directory,
        &png_file_name,
        &png,
        &md5_hex(&png),
    ) {
        Ok(updated) => updated,
        Err(error) => {
            if let Some(previous) = previous_svg {
                let _ = publish_resource_replace(
                    &resource_workspace,
                    &asset_directory,
                    &svg_file_name,
                    &previous,
                    &md5_hex(&previous),
                );
            } else {
                let _ = secure_fs::unlink_at(&asset_dir_handle, &svg_file_name);
            }
            if ownership_created {
                let _ = secure_fs::unlink_at(&asset_dir_handle, &ownership_file_name);
            }
            return Err(format!(
                "Cannot publish PNG asset; SVG was rolled back: {error}"
            ));
        }
    };

    state
        .file_authorization()
        .ensure_workspace_is_current(&workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&source_workspace)?;
    state
        .file_authorization()
        .ensure_workspace_is_current(&resource_workspace)?;
    Ok(WriteExcalidrawAssetPairResponse {
        svg_markdown_path,
        png_markdown_path,
        svg_file_name,
        png_file_name,
        source_sha256: format!("{:x}", Sha256::digest(input.source_content.as_bytes())),
        updated: svg_updated || png_updated,
    })
}

#[tauri::command]
pub(crate) fn write_excalidraw_asset_pair(
    input: WriteExcalidrawAssetPairRequest,
    state: State<'_, AppState>,
) -> Result<WriteExcalidrawAssetPairResponse, String> {
    write_excalidraw_asset_pair_inner(&state, input)
}

fn authorize_resource_directory_path_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    transport: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<ResourceDirectoryAuthorizationResponse, String> {
    let authorization = authorize_resource_directory_inner(state, path, transport)?;
    Ok(ResourceDirectoryAuthorizationResponse {
        path: authorization.root().to_string_lossy().to_string(),
        token: authorization.wire_token(),
    })
}

#[tauri::command]
pub(crate) async fn authorize_resource_directory_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ResourceDirectoryAuthorizationResponse>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Invalid selected resource directory: {error}"))?;
    authorize_resource_directory_path_inner(&state, path, |root| {
        allow_asset_preview_directory(&app, root)
    })
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::{open_directory_inner, open_workspace_file_inner},
        state::AppState,
    };
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use std::{
        fs,
        sync::{Arc, Barrier, Mutex as TestMutex},
        thread,
    };
    use tempfile::TempDir;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    static BEFORE_PUBLISH_HOOK: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);

    pub(super) fn run_before_publish_hook() {
        if let Some(hook) = BEFORE_PUBLISH_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            hook();
        }
    }

    fn set_before_publish_hook(hook: impl FnOnce() + Send + 'static) {
        *BEFORE_PUBLISH_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(hook));
    }

    fn open_workspace_and_document(state: &AppState, dir: &TempDir) -> (String, String) {
        let snapshot = open_directory_inner(state, dir.path()).unwrap();
        open_workspace_file_inner(state, dir.path().join("draft.md")).unwrap();
        (snapshot.workspace_token, snapshot.root)
    }

    fn request(token: &str, root: &str, bytes: &[u8]) -> WriteWorkspaceResourceRequest {
        WriteWorkspaceResourceRequest {
            workspace_token: token.to_string(),
            workspace_root: root.to_string(),
            document_path: Path::new(root)
                .join("draft.md")
                .to_string_lossy()
                .to_string(),
            resource_directory: "assets/images".to_string(),
            bytes_base64: BASE64_STANDARD.encode(bytes),
            mime_type: "image/png".to_string(),
            suggested_name: Some("clipboard.png".to_string()),
            trusted_generated: None,
            resource_directory_token: None,
        }
    }

    #[test]
    fn writes_supported_image_under_authorized_resource_directory() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let response = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();

        assert_eq!(response.digest_md5.len(), 32);
        assert_eq!(
            response.relative_path,
            format!("assets/images/{}.png", response.digest_md5)
        );
        assert_eq!(response.markdown_path, response.relative_path);
        assert_eq!(response.file_name, format!("{}.png", response.digest_md5));
        assert!(response.created);
        assert_eq!(
            fs::read(dir.path().join(&response.relative_path)).unwrap(),
            PNG
        );
        assert!(fs::read_dir(dir.path().join("assets/images"))
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            }));
    }

    #[test]
    fn deduplicates_identical_image_bytes_by_md5_name() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let first = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();
        let second = write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap();

        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(first.digest_md5, second.digest_md5);
    }

    #[test]
    fn rejects_unauthorized_workspace_token_before_side_effects() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();

        let error = write_workspace_resource_inner(
            &state,
            request("workspace-999", &dir.path().to_string_lossy(), PNG),
        )
        .unwrap_err();

        assert!(error.contains("Workspace authorization") || error.contains("Invalid workspace"));
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn rejects_parent_traversal_and_absolute_resource_directories_before_side_effects() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let mut traversal = request(&token, &root, PNG);
        traversal.resource_directory = "assets/../outside".to_string();
        assert!(write_workspace_resource_inner(&state, traversal).is_err());

        let mut absolute = request(&token, &root, PNG);
        absolute.resource_directory = dir.path().join("assets").to_string_lossy().to_string();
        assert!(write_workspace_resource_inner(&state, absolute).is_err());
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn writes_to_an_explicitly_authorized_absolute_resource_directory() {
        let state = AppState::default();
        let outer = TempDir::new().unwrap();
        let workspace = outer.path().join("workspace");
        let docs = workspace.join("docs");
        let resources = outer.path().join("shared-resources");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&resources).unwrap();
        fs::write(docs.join("draft.md"), b"# Draft").unwrap();
        let snapshot = open_directory_inner(&state, &workspace).unwrap();
        open_workspace_file_inner(&state, docs.join("draft.md")).unwrap();
        let authorization =
            authorize_resource_directory_path_inner(&state, &resources, |_| Ok(())).unwrap();
        let mut input = request(&snapshot.workspace_token, &snapshot.root, PNG);
        input.document_path = docs.join("draft.md").to_string_lossy().to_string();
        input.resource_directory = authorization.path.clone();
        input.resource_directory_token = Some(authorization.token);

        let response = write_workspace_resource_inner(&state, input).unwrap();

        assert_eq!(
            response.markdown_path,
            format!("../../shared-resources/{}", response.file_name)
        );
        assert_eq!(response.relative_path, response.markdown_path);
        assert_eq!(fs::read(resources.join(response.file_name)).unwrap(), PNG);
    }

    #[test]
    fn rejects_absolute_resource_directory_without_matching_live_authorization() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        let resources = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        fs::write(workspace.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &workspace);

        let mut missing = request(&token, &root, PNG);
        missing.resource_directory = resources.path().to_string_lossy().to_string();
        assert!(write_workspace_resource_inner(&state, missing)
            .unwrap_err()
            .contains("explicitly authorized"));

        let authorization =
            authorize_resource_directory_path_inner(&state, other.path(), |_| Ok(())).unwrap();
        let mut mismatched = request(&token, &root, PNG);
        mismatched.resource_directory = resources.path().to_string_lossy().to_string();
        mismatched.resource_directory_token = Some(authorization.token);
        assert!(write_workspace_resource_inner(&state, mismatched).is_err());
        assert!(fs::read_dir(resources.path()).unwrap().next().is_none());
        assert!(fs::read_dir(other.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nested_symlink_without_creating_outside_side_effects() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        fs::create_dir(dir.path().join("assets")).unwrap();
        symlink(outside.path(), dir.path().join("assets/images")).unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let error =
            write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

        assert!(
            error.contains("securely")
                || error.contains("symbolic")
                || error.contains("Not a directory")
                || error.contains("Too many levels")
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_final_symlink_target_during_dedup_verification() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let digest = md5_hex(PNG);
        let resource_dir = dir.path().join("assets/images");
        fs::create_dir_all(&resource_dir).unwrap();
        fs::write(outside.path().join("target.png"), PNG).unwrap();
        symlink(
            outside.path().join("target.png"),
            resource_dir.join(format!("{digest}.png")),
        )
        .unwrap();

        let error =
            write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

        assert!(error.contains("without following links") || error.contains("Too many levels"));
    }

    #[test]
    fn rejects_bad_signature_unsupported_type_malformed_base64_and_oversize_before_side_effects() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let bad_signature = request(&token, &root, b"not-png");
        assert!(write_workspace_resource_inner(&state, bad_signature)
            .unwrap_err()
            .contains("match"));

        let mut unsupported = request(&token, &root, PNG);
        unsupported.mime_type = "application/pdf".to_string();
        assert!(write_workspace_resource_inner(&state, unsupported)
            .unwrap_err()
            .contains("not supported"));

        let mut malformed = request(&token, &root, PNG);
        malformed.bytes_base64 = "%%%".to_string();
        assert!(write_workspace_resource_inner(&state, malformed)
            .unwrap_err()
            .contains("base64"));

        let mut oversized = request(&token, &root, PNG);
        oversized.bytes_base64 = BASE64_STANDARD.encode(vec![0_u8; MAX_RESOURCE_BYTES + 1]);
        assert!(write_workspace_resource_inner(&state, oversized)
            .unwrap_err()
            .contains("16 MiB"));
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn rejects_arbitrary_clipboard_svg_without_trusted_generated_contract() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let mut input = request(
            &token,
            &root,
            br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
        );
        input.mime_type = "image/svg+xml".to_string();

        let error = write_workspace_resource_inner(&state, input).unwrap_err();

        assert!(error.contains("trusted generated"));
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn accepts_structurally_safe_trusted_generated_svg() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let mut input = request(
            &token,
            &root,
            br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#,
        );
        input.mime_type = "image/svg+xml".to_string();
        input.trusted_generated = Some(true);

        let response = write_workspace_resource_inner(&state, input).unwrap();

        assert!(response.relative_path.ends_with(".svg"));
        assert!(dir.path().join(response.relative_path).exists());
    }

    #[test]
    fn rejects_document_paths_outside_authorized_workspace() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let outside_doc = outside.path().join("draft.md");
        fs::write(&outside_doc, b"# Outside").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);

        let mut input = request(&token, &root, PNG);
        input.document_path = outside_doc.to_string_lossy().to_string();

        assert!(write_workspace_resource_inner(&state, input)
            .unwrap_err()
            .contains("outside"));
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn rejects_stale_or_unauthorized_markdown_document() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        let doc = dir.path().join("draft.md");
        fs::write(&doc, b"# Draft").unwrap();
        let snapshot = open_directory_inner(&state, dir.path()).unwrap();
        let mut input = request(&snapshot.workspace_token, &snapshot.root, PNG);
        assert!(write_workspace_resource_inner(&state, input.clone())
            .unwrap_err()
            .contains("explicitly"));

        open_workspace_file_inner(&state, &doc).unwrap();
        let replacement = dir.path().join("replacement.md");
        fs::write(&replacement, b"# Replacement").unwrap();
        fs::remove_file(&doc).unwrap();
        fs::rename(replacement, &doc).unwrap();
        input.document_path = doc.to_string_lossy().to_string();
        let error = write_workspace_resource_inner(&state, input).unwrap_err();
        assert!(
            error.contains("identity") || error.contains("explicitly") || error.contains("changed")
        );
    }

    #[test]
    fn rejects_existing_digest_file_with_different_bytes() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let input = request(&token, &root, PNG);
        let digest = md5_hex(PNG);
        let resource_dir = dir.path().join("assets/images");
        fs::create_dir_all(&resource_dir).unwrap();
        fs::write(resource_dir.join(format!("{digest}.png")), b"different").unwrap();

        let error = write_workspace_resource_inner(&state, input).unwrap_err();

        assert!(error.contains("collides"));
    }

    #[test]
    fn cleans_up_staged_file_after_partial_write_failure() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        TEST_FAULT.with(|fault| *fault.borrow_mut() = Some(TestFault::PartialStagedWrite));

        let error =
            write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

        assert!(error.contains("partial"));
        let resource_dir = dir.path().join("assets/images");
        assert!(resource_dir.exists());
        assert!(fs::read_dir(resource_dir).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn detects_parent_replacement_before_publication_without_writing_outside() {
        let state = AppState::default();
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        fs::create_dir(dir.path().join("assets")).unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let assets = dir.path().join("assets");
        let moved = dir.path().join("assets-moved");
        let outside_path = outside.path().to_path_buf();
        set_before_publish_hook(move || {
            fs::rename(&assets, &moved).unwrap();
            symlink(&outside_path, &assets).unwrap();
        });

        let error =
            write_workspace_resource_inner(&state, request(&token, &root, PNG)).unwrap_err();

        assert!(
            error.contains("atomic")
                || error.contains("publish")
                || error.contains("No such file")
                || error.contains("Staged")
                || error.contains("Workspace root changed")
                || error.contains("authorization")
                || error.contains("Resource directory changed")
                || error.contains("Not a directory")
                || error.contains("Too many levels")
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn handles_concurrent_identical_writes_as_single_created_resource() {
        let state = Arc::new(AppState::default());
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("draft.md"), b"# Draft").unwrap();
        let (token, root) = open_workspace_and_document(&state, &dir);
        let barrier = Arc::new(Barrier::new(8));
        let results = Arc::new(TestMutex::new(Vec::new()));

        thread::scope(|scope| {
            for _ in 0..8 {
                let state = Arc::clone(&state);
                let token = token.clone();
                let root = root.clone();
                let barrier = Arc::clone(&barrier);
                let results = Arc::clone(&results);
                scope.spawn(move || {
                    barrier.wait();
                    let result =
                        write_workspace_resource_inner(&state, request(&token, &root, PNG))
                            .unwrap();
                    results.lock().unwrap().push(result);
                });
            }
        });

        let results = results.lock().unwrap();
        assert_eq!(results.iter().filter(|result| result.created).count(), 1);
        assert!(results
            .iter()
            .all(|result| result.relative_path == results[0].relative_path));
        let resource_dir = dir.path().join("assets/images");
        let entries = fs::read_dir(resource_dir).unwrap().count();
        assert_eq!(entries, 1);
    }

    fn excalidraw_asset_request(
        token: &str,
        root: &str,
        source_content: &str,
        svg: &[u8],
        png: &[u8],
    ) -> WriteExcalidrawAssetPairRequest {
        WriteExcalidrawAssetPairRequest {
            workspace_token: token.to_string(),
            workspace_root: root.to_string(),
            document_path: Path::new(root)
                .join("docs/guide.md")
                .to_string_lossy()
                .to_string(),
            source_relative_path: "diagrams/system.excalidraw".to_string(),
            source_content: source_content.to_string(),
            resource_directory: "assets/diagrams".to_string(),
            resource_directory_token: None,
            svg_base64: BASE64_STANDARD.encode(svg),
            png_base64: BASE64_STANDARD.encode(png),
        }
    }

    #[test]
    fn writes_and_updates_stably_named_excalidraw_asset_pair() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        let docs = workspace.path().join("docs");
        let diagrams = workspace.path().join("diagrams");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&diagrams).unwrap();
        fs::write(docs.join("guide.md"), b"# Guide").unwrap();
        let source_content = crate::excalidraw_scene::default_excalidraw_scene();
        fs::write(diagrams.join("system.excalidraw"), source_content).unwrap();
        let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
        let svg_one = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#;
        let png_one = b"\x89PNG\r\n\x1a\nfirst";

        let first = write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                svg_one,
                png_one,
            ),
        )
        .unwrap();

        assert!(first.updated);
        assert!(first.svg_markdown_path.starts_with("../assets/diagrams/"));
        assert!(first.png_markdown_path.starts_with("../assets/diagrams/"));
        let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");
        let svg_path = asset_directory.join(&first.svg_file_name);
        let png_path = asset_directory.join(&first.png_file_name);
        assert_eq!(fs::read(&svg_path).unwrap(), svg_one);
        assert_eq!(fs::read(&png_path).unwrap(), png_one);

        let svg_two = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>"#;
        let png_two = b"\x89PNG\r\n\x1a\nsecond";
        let second = write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                svg_two,
                png_two,
            ),
        )
        .unwrap();

        assert_eq!(second.svg_file_name, first.svg_file_name);
        assert_eq!(second.png_file_name, first.png_file_name);
        assert_eq!(second.source_sha256, first.source_sha256);
        assert_eq!(first.source_sha256.len(), 64);
        assert_eq!(fs::read(svg_path).unwrap(), svg_two);
        assert_eq!(fs::read(png_path).unwrap(), png_two);
    }

    #[test]
    fn rolls_back_svg_when_png_publication_fails() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        fs::create_dir_all(workspace.path().join("docs")).unwrap();
        fs::create_dir_all(workspace.path().join("diagrams")).unwrap();
        fs::write(workspace.path().join("docs/guide.md"), b"# Guide").unwrap();
        let source_content = crate::excalidraw_scene::default_excalidraw_scene();
        fs::write(
            workspace.path().join("diagrams/system.excalidraw"),
            source_content,
        )
        .unwrap();
        let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, workspace.path().join("docs/guide.md")).unwrap();
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#;
        let png = b"\x89PNG\r\n\x1a\nfirst";
        write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                svg,
                png,
            ),
        )
        .unwrap();
        TEST_FAULT.with(|fault| *fault.borrow_mut() = Some(TestFault::FailPngReplace));
        let changed_svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>"#;
        let error = write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                changed_svg,
                b"\x89PNG\r\n\x1a\nsecond",
            ),
        )
        .unwrap_err();
        assert!(error.contains("rolled back"), "{error}");
        let asset_dir = workspace.path().join("assets/diagrams/excalidraw-assets");
        let names = stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
        assert_eq!(fs::read(asset_dir.join(names.1)).unwrap(), svg);
    }

    #[test]
    fn refuses_to_take_over_unowned_stable_excalidraw_assets() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        let docs = workspace.path().join("docs");
        let diagrams = workspace.path().join("diagrams");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&diagrams).unwrap();
        fs::write(docs.join("guide.md"), b"# Guide").unwrap();
        let source_content = crate::excalidraw_scene::default_excalidraw_scene();
        fs::write(diagrams.join("system.excalidraw"), source_content).unwrap();
        let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
        let (_, svg_file_name, png_file_name) =
            stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
        let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");
        fs::create_dir_all(&asset_directory).unwrap();
        fs::write(asset_directory.join(&svg_file_name), b"user-owned-svg").unwrap();

        let error = write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
                b"\x89PNG\r\n\x1a\nnew",
            ),
        )
        .unwrap_err();

        assert!(error.contains("ownership"));
        assert_eq!(
            fs::read(asset_directory.join(svg_file_name)).unwrap(),
            b"user-owned-svg"
        );
        assert!(!asset_directory.join(png_file_name).exists());
    }

    #[test]
    fn refuses_to_replace_assets_owned_by_a_different_source() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        let docs = workspace.path().join("docs");
        let diagrams = workspace.path().join("diagrams");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&diagrams).unwrap();
        fs::write(docs.join("guide.md"), b"# Guide").unwrap();
        let source_content = crate::excalidraw_scene::default_excalidraw_scene();
        fs::write(diagrams.join("system.excalidraw"), source_content).unwrap();
        let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
        let (ownership_file_name, svg_file_name, _) =
            stable_excalidraw_asset_names(Path::new("diagrams/system.excalidraw")).unwrap();
        let asset_directory = workspace.path().join("assets/diagrams/excalidraw-assets");
        fs::create_dir_all(&asset_directory).unwrap();
        fs::write(
            asset_directory.join(ownership_file_name),
            b"diagrams/other.excalidraw",
        )
        .unwrap();
        fs::write(asset_directory.join(&svg_file_name), b"other-source-svg").unwrap();

        let error = write_excalidraw_asset_pair_inner(
            &state,
            excalidraw_asset_request(
                &snapshot.workspace_token,
                &snapshot.root,
                source_content,
                br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
                b"\x89PNG\r\n\x1a\nnew",
            ),
        )
        .unwrap_err();

        assert!(error.contains("different source"));
        assert_eq!(
            fs::read(asset_directory.join(svg_file_name)).unwrap(),
            b"other-source-svg"
        );
    }

    #[test]
    fn rejects_excalidraw_assets_when_source_content_is_stale() {
        let state = AppState::default();
        let workspace = TempDir::new().unwrap();
        let docs = workspace.path().join("docs");
        let diagrams = workspace.path().join("diagrams");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&diagrams).unwrap();
        fs::write(docs.join("guide.md"), b"# Guide").unwrap();
        fs::write(
            diagrams.join("system.excalidraw"),
            crate::excalidraw_scene::default_excalidraw_scene(),
        )
        .unwrap();
        let snapshot = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, docs.join("guide.md")).unwrap();
        let request = excalidraw_asset_request(
            &snapshot.workspace_token,
            &snapshot.root,
            "{\"type\":\"excalidraw\",\"version\":2,\"elements\":[],\"appState\":{},\"files\":{}}",
            br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
            b"\x89PNG\r\n\x1a\nstale",
        );

        let error = write_excalidraw_asset_pair_inner(&state, request).unwrap_err();

        assert!(error.contains("changed") || error.contains("match"));
        assert!(!workspace.path().join("assets").exists());
    }
}
