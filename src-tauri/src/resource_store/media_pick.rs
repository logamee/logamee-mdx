//! Picked-media planning and import.
use super::*;

pub(crate) const MAX_PICKED_AUDIO_VIDEO_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MediaPickPlan {
    Reference { markdown_path: String, name: String },
    Import { source: PathBuf, name: String },
}

pub(crate) fn parse_picked_media_kind(value: &str) -> Result<WorkspaceFileKind, String> {
    match value {
        "image" => Ok(WorkspaceFileKind::Image),
        "video" => Ok(WorkspaceFileKind::Video),
        "audio" => Ok(WorkspaceFileKind::Audio),
        "html" => Ok(WorkspaceFileKind::Html),
        _ => Err("Unsupported media kind for resource picking".to_string()),
    }
}

pub(crate) fn picked_media_filter_label(kind: WorkspaceFileKind) -> &'static str {
    match kind {
        WorkspaceFileKind::Image => "Images",
        WorkspaceFileKind::Video => "Videos",
        WorkspaceFileKind::Audio => "Audio",
        _ => "HTML documents",
    }
}

// 对话框起始目录只做字符串规范化：Windows 上文档位于盘根时前端算出的目录是
// "C:"，它指向驱动器当前目录而非盘根，规范化为 "C:/" 才能定位到文档真实所在。
pub(crate) fn normalize_picker_default_directory(input: &str) -> String {
    let trimmed = input.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("{trimmed}/");
    }
    trimmed.to_string()
}

// 起始目录必须是真实存在的目录；空串、失效路径或文件一律回退对话框默认位置，
// 避免把平台相关的无效目录交给原生文件对话框。
pub(crate) fn resolve_picked_default_directory(input: &str) -> Option<PathBuf> {
    let normalized = normalize_picker_default_directory(input);
    if normalized.is_empty() {
        return None;
    }
    let path = PathBuf::from(normalized);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    Some(path)
}

fn resource_image_kind_for_extension(extension: &str) -> Option<ResourceImageKind> {
    match extension {
        "png" => Some(ResourceImageKind::Png),
        "jpg" | "jpeg" => Some(ResourceImageKind::Jpeg),
        "gif" => Some(ResourceImageKind::Gif),
        "webp" => Some(ResourceImageKind::Webp),
        _ => None,
    }
}

pub(crate) fn picked_file_name(selected: &Path) -> Result<String, String> {
    selected
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty() && name.len() <= 255)
        .ok_or_else(|| "The picked file has no usable file name".to_string())
}

// 资源选择器策略：工作区内的文件只生成相对引用（零拷贝，与文件树拖拽一致）；
// 工作区外的文件必须导入资源目录后才可被安全引用。类型不匹配的选中项直接报错。
pub(crate) fn plan_picked_media_resource(
    workspace_root: &Path,
    document_path: &Path,
    selected: &Path,
    media_kind: WorkspaceFileKind,
) -> Result<MediaPickPlan, String> {
    let classified = WorkspaceFileKind::classify(selected)
        .ok_or_else(|| "The picked file is not a supported workspace file".to_string())?;
    if classified != media_kind {
        return Err(format!(
            "The picked file does not match the {} picker",
            picked_media_filter_label(media_kind)
        ));
    }
    let name = picked_file_name(selected)?;
    if path_is_under(selected, workspace_root) {
        let document_directory = document_path
            .parent()
            .ok_or_else(|| "Markdown document has no parent directory".to_string())?;
        let markdown_path = markdown_relative_path(document_directory, selected)?;
        Ok(MediaPickPlan::Reference {
            markdown_path,
            name,
        })
    } else {
        Ok(MediaPickPlan::Import {
            source: selected.to_path_buf(),
            name,
        })
    }
}

fn load_picked_media_bytes(
    source: &Path,
    media_kind: WorkspaceFileKind,
    max_bytes: u64,
) -> Result<(String, Vec<u8>), String> {
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .ok_or_else(|| "The picked media file has no usable extension".to_string())?;
    if !media_kind.extensions().contains(&extension.as_str()) {
        return Err("The picked file does not match the media picker kind".to_string());
    }
    if media_kind == WorkspaceFileKind::Image && extension == "svg" {
        return Err(
            "SVG files must be placed inside the workspace and referenced directly".to_string(),
        );
    }
    let mut file = File::open(source)
        .map_err(|error| format!("Cannot read the picked media file: {error}"))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read the picked media file: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err("The picked media file exceeds the import size limit".to_string());
    }
    if media_kind == WorkspaceFileKind::Image {
        if let Some(image_kind) = resource_image_kind_for_extension(&extension) {
            image_kind.validate(&bytes, false)?;
        }
    }
    Ok((extension, bytes))
}

pub(crate) fn import_picked_media_file(
    state: &AppState,
    resource_workspace: &AuthorizedWorkspace,
    resource_subdirectory: &Path,
    document_path: &Path,
    media_kind: WorkspaceFileKind,
    source: &Path,
    max_bytes: u64,
) -> Result<String, String> {
    let (extension, bytes) = load_picked_media_bytes(source, media_kind, max_bytes)?;
    let digest_md5 = md5_hex(&bytes);
    let file_name = format!("{digest_md5}.{extension}");
    let _write_guard = RESOURCE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .file_authorization()
        .ensure_workspace_is_current(resource_workspace)?;
    publish_resource_no_replace(
        resource_workspace,
        resource_subdirectory,
        &file_name,
        &bytes,
        &digest_md5,
    )?;
    state
        .file_authorization()
        .ensure_workspace_is_current(resource_workspace)?;
    let resource_path = resource_workspace
        .root()
        .join(resource_subdirectory)
        .join(&file_name);
    let document_directory = document_path
        .parent()
        .ok_or_else(|| "Markdown document has no parent directory".to_string())?;
    markdown_relative_path(document_directory, &resource_path)
}

// 面板媒体插入的资源选择入口：默认目录为当前文档所在目录。选择器返回的路径
// 是用户在系统对话框中亲自授权的单次读取来源，与打开文档同级信任；导入仅在
// 本命令内完成，不产生持久路径授权。
#[tauri::command]
pub(crate) async fn pick_media_resources(
    app: AppHandle,
    input: PickMediaResourcesInput,
    state: State<'_, AppState>,
) -> Result<PickMediaResourcesResponse, String> {
    pick_media_resources_inner(&state, &app, input)
}
