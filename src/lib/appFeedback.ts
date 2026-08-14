import { translate } from './i18n';
import type { EffectiveLocale } from './locale';

export type FeedbackDialogKind = 'info' | 'error';
export type FeedbackDialogRole = 'dialog' | 'alertdialog';

export const APP_FEEDBACK_ERROR_EVENT = 'mmd:app-feedback-error';

export interface FeedbackDialog {
  kind: FeedbackDialogKind;
  role: FeedbackDialogRole;
  title: string;
  message: string;
  dismissLabel: string;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error == null) return '';
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeEnglishError(raw: string, message: string): string {
  if (!raw) return 'The operation could not be completed. Please try again.';
  if (message.includes('recent file')) return 'The recent file is no longer available. Choose it again from the updated list.';
  if (message.includes('failed to write file')) return 'The file could not be saved. Confirm that it is still writable, then try again.';
  if (message.includes('failed to create')) return 'The item could not be created. Confirm that the destination is writable, then try again.';
  if (message.includes('failed to rename')) return 'The item could not be renamed. Confirm that the destination is writable, then try again.';
  if (message.includes('failed to delete')) return 'The item could not be deleted. Confirm that it still exists and is accessible.';
  if (message.includes('failed to read file')) return 'The file could not be read. Confirm that it still exists and is accessible.';
  if (message.includes('excalidraw preview module')) return 'The Excalidraw editor could not be loaded. Restart mdx and try again.';
  if (message.includes('excalidraw preview')) return 'The embedded Excalidraw drawing could not be displayed.';
  if (message.includes('excalidraw scene')) return 'This Excalidraw file is invalid and cannot be opened or saved.';
  if (message.includes('excalidraw embed exceeds')) return 'The embedded Excalidraw drawing is too large to display.';
  if (message.includes('excalidraw embed is not valid utf-8')) return 'The embedded Excalidraw file is invalid and cannot be displayed.';
  if (message.includes('excalidraw embed')) return 'The embedded Excalidraw drawing could not be displayed. Use a relative Excalidraw path within the current workspace.';
  if (message.includes('docx')) return 'This DOCX could not be displayed. The file may be damaged or unsupported.';
  if (message.includes('pdf')) return 'This PDF could not be displayed. The file may be damaged or unsupported.';
  if (message.includes('image')) return 'The image could not be displayed. Check its relative path and file access.';
  if (message.includes('media')) return 'This media file or codec cannot be played on the current system.';
  if (message.includes('html embed')) return 'The embedded HTML page could not be displayed. Use a relative HTML path within the current workspace.';
  if (message.includes('html preview')) return 'The HTML preview service could not start. Please try again.';
  if (message.includes('workspace entry name')) return 'Enter a valid file or folder name.';
  if (message.includes('already exists')) return 'An item with the same name already exists.';
  if (message.includes('workspace root')) return 'The workspace root cannot be renamed or deleted.';
  if (message.includes('permission') || message.includes('not permitted') || message.includes('access denied') || message.includes('authorized')) {
    return 'mdx does not have permission to complete this operation. Reopen the file or folder and try again.';
  }
  if (message.includes('path') || message.includes('directory')) return 'The selected file or folder is no longer available.';
  if (message.includes('tauri') || message.includes('webview') || message.includes('window') || message.includes('event') || message.includes('invoke')) {
    return 'Communication with the application window failed. Please try again.';
  }
  return 'The operation could not be completed. Please try again.';
}

export function normalizeAppError(error: unknown, locale: EffectiveLocale = 'zh-CN'): string {
  const raw = stringifyError(error).trim();
  const message = raw.toLowerCase();

  if (locale === 'en') return normalizeEnglishError(raw, message);

  if (!raw) return '操作没有完成。请稍后重试。';

  if (message.includes('recent files store is busy')) {
    return '最近文件列表正在被另一个应用进程更新。请稍后重试。';
  }

  if (
    message.includes('recent file is no longer available')
    || message.includes('open target is no longer a supported file')
  ) {
    return '最近文件已移动、删除或不再受支持。请从更新后的列表中重新选择。';
  }

  if (message.includes('recent files menu synchronization failed')) {
    return '最近文件已更新，但系统菜单暂时无法同步。请重试最近文件操作，或重新启动应用。';
  }

  if (message.includes('failed to authorize preview assets')) {
    return '文件已打开，但预览权限暂时无法同步。请重新打开该文件后再试。';
  }

  if (message.includes('selected file is not a markdown/mdx file') || message.includes('workspace file is not a markdown/mdx file')) {
    return '请选择 Markdown 或 MDX 文件。';
  }

  if (message.includes('failed to write file')) {
    return '保存文件失败。请确认文件仍可写入，然后重试。';
  }

  if (message.includes('failed to create file') || message.includes('failed to create directory')) {
    return '新建失败。请确认目标位置可写入，然后重试。';
  }

  if (message.includes('failed to rename entry')) {
    return '重命名失败。请确认目标位置可写入，然后重试。';
  }

  if (message.includes('failed to delete file') || message.includes('failed to delete directory')) {
    return '删除失败。请确认文件或文件夹仍然存在，并且应用有权限访问。';
  }

  if (message.includes('failed to read file')) {
    return '读取文件失败。请确认文件仍然存在并可访问。';
  }

  if (message.includes('excalidraw preview module')) {
    return 'Excalidraw 编辑器暂时无法加载。请重新启动 mdx 后再试。';
  }

  if (message.includes('excalidraw preview')) {
    return '嵌入的 Excalidraw 绘图暂时无法显示。';
  }

  if (message.includes('invalid excalidraw scene') || message.includes('excalidraw scene')) {
    return '此 Excalidraw 文件格式无效，无法打开或保存。';
  }

  if (message.includes('excalidraw embed exceeds')) {
    return '嵌入的 Excalidraw 绘图过大，暂时无法显示。';
  }

  if (message.includes('excalidraw embed is not valid utf-8')) {
    return '嵌入的 Excalidraw 文件格式无效，无法显示。';
  }

  if (message.includes('excalidraw embed')) {
    return '无法加载嵌入的 Excalidraw 绘图。请使用当前工作区内的相对 Excalidraw 路径。';
  }

  if (message.includes('image preview could not be displayed')) {
    return '图片文件已找到，但预览无法显示。请重新打开图片所在文件夹；若仍失败，请尝试转换图片格式。';
  }

  if (message.includes('image source exceeds the 64 mib limit')) {
    return '图片文件过大，暂时无法预览。请压缩图片或使用较小的版本后再试。';
  }

  if (message.includes('image file is not accessible')) {
    return '无法访问该图片。请在应用内重新打开图片所在文件夹后再试。';
  }

  if (message.includes('image file not found')) {
    return '找不到该图片。请检查 Markdown 中的相对路径和文件名。';
  }

  if (message.includes('failed to read image')) {
    return '无法加载该图片。请确认图片文件存在并可访问。';
  }

  if (message.includes('failed to read media')) {
    return '无法加载该媒体文件。请确认文件存在并可访问。';
  }

  if (message.includes('failed to play media') || message.includes('media playback is not supported')) {
    return '当前系统不支持播放该媒体格式或编码。';
  }

  if (
    message.includes('failed to start html preview server') ||
    message.includes('failed to run html preview server') ||
    message.includes('html preview server state is poisoned') ||
    message.includes('html preview state is poisoned') ||
    message.includes('failed to create html preview token')
  ) {
    return '无法启动 HTML 预览服务。请稍后重试。';
  }

  if (message.includes('html embed')) {
    return '无法加载嵌入的 HTML 页面。请使用当前工作区内的相对 HTML 路径。';
  }

  if (
    message.includes('invalid image path') ||
    message.includes('invalid percent-encoded image path') ||
    message.includes('image path is not valid utf-8') ||
    message.includes('image path is empty') ||
    message.includes('only relative local image paths are supported') ||
    message.includes('absolute image paths are not allowed') ||
    message.includes('image path traversal is not allowed')
  ) {
    return '无法加载该图片。请使用当前 Markdown 文件附近的相对图片路径。';
  }

  if (
    message.includes('outside the user-authorized') ||
    message.includes('outside authorized') ||
    message.includes('escaped authorized') ||
    message.includes('not been explicitly authorized')
  ) {
    return '出于安全限制，应用无法访问未授权的文件或文件夹。请从应用内重新打开对应文件或文件夹后再试。';
  }

  if (message.includes('parent directory traversal is not allowed')) {
    return '无法打开该路径，因为它会离开允许的文件夹。';
  }

  if (message.includes('workspace entry name is empty') || message.includes('workspace entry name is invalid') || message.includes('workspace entry name cannot contain path separators')) {
    return '请输入有效的文件或文件夹名称。';
  }

  if (message.includes('workspace entry already exists')) {
    return '同名文件或文件夹已存在。请换一个名称。';
  }

  if (message.includes('cannot modify workspace root')) {
    return '不能直接重命名或删除当前工作区根目录。';
  }

  if (message.includes('cannot access path')) {
    return '无法访问所选路径。请确认文件或文件夹仍然存在，并且应用有权限访问。';
  }

  if (message.includes('path is not a file') || message.includes('authorized file must be a file') || message.includes('destination is not a file') || message.includes('current markdown path is not a file')) {
    return '请选择有效的文件后再试。';
  }

  if (message.includes('path is not a directory') || message.includes('authorized root must be a directory')) {
    return '请选择有效的文件夹后再试。';
  }

  if (message.includes('authorization state is poisoned')) {
    return '应用的文件访问状态暂时不可用。请重新打开文件或文件夹后再试。';
  }

  if (
    message.includes('invalid selected file path') ||
    message.includes('invalid selected directory path') ||
    message.includes('invalid save path')
  ) {
    return '所选路径无效。请重新选择文件或文件夹。';
  }

  if (
    message.includes('permission denied') ||
    message.includes('not permitted') ||
    message.includes('forbidden') ||
    message.includes('access denied')
  ) {
    return '应用没有权限完成此操作。请重新选择文件或文件夹，或检查系统权限设置。';
  }

  if (/[\u4e00-\u9fff]/u.test(raw)) {
    return raw;
  }

  if (
    message.includes('tauri') ||
    message.includes('webview') ||
    message.includes('window') ||
    message.includes('event') ||
    message.includes('channel') ||
    message.includes('invoke')
  ) {
    return '应用窗口通信暂时失败。请重试。';
  }

  return '操作没有完成。请稍后重试。';
}

export function emitAppFeedbackError(error: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(APP_FEEDBACK_ERROR_EVENT, { detail: stringifyError(error) }));
}

export function getFeedbackDialog(input: { error: string | null; notice: string | null }, locale: EffectiveLocale = 'zh-CN'): FeedbackDialog | null {
  if (input.error) {
    return {
      kind: 'error',
      role: 'alertdialog',
      title: translate(locale, 'problem'),
      message: normalizeAppError(input.error, locale),
      dismissLabel: translate(locale, 'gotIt'),
    };
  }
  if (input.notice) {
    return {
      kind: 'info',
      role: 'dialog',
      title: translate(locale, 'notice'),
      message: input.notice,
      dismissLabel: translate(locale, 'gotIt'),
    };
  }
  return null;
}
