import { translate } from './i18n';
import type { EffectiveLocale } from './locale';

type FeedbackDialogKind = 'info' | 'error';
type FeedbackDialogRole = 'dialog' | 'alertdialog';

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


const ZH_ERROR_RULES = Object.freeze([
  { keywords: ['recent files store is busy'], message: '最近文件列表正在被另一个应用进程更新。请稍后重试。' },
  { keywords: ['recent file is no longer available', 'open target is no longer a supported file'], message: '最近文件已移动、删除或不再受支持。请从更新后的列表中重新选择。' },
  { keywords: ['recent files menu synchronization failed'], message: '最近文件已更新，但系统菜单暂时无法同步。请重试最近文件操作，或重新启动应用。' },
  { keywords: ['failed to authorize preview assets'], message: '文件已打开，但预览权限暂时无法同步。请重新打开该文件后再试。' },
  { keywords: ['selected file is not a markdown/mdx file', 'workspace file is not a markdown/mdx file'], message: '请选择 Markdown 或 MDX 文件。' },
  { keywords: ['exact write authority'], message: '文件在外部被替换为不受支持的对象，无法继续保存。请重新打开该文件后再试。' },
  { keywords: ['failed to write file'], message: '保存文件失败。请确认文件仍可写入，然后重试。' },
  { keywords: ['failed to create file', 'failed to create directory'], message: '新建失败。请确认目标位置可写入，然后重试。' },
  { keywords: ['failed to rename entry'], message: '重命名失败。请确认目标位置可写入，然后重试。' },
  { keywords: ['failed to delete file', 'failed to delete directory'], message: '删除失败。请确认文件或文件夹仍然存在，并且应用有权限访问。' },
  { keywords: ['failed to read file'], message: '读取文件失败。请确认文件仍然存在并可访问。' },
  { keywords: ['excalidraw preview module'], message: 'Excalidraw 编辑器暂时无法加载。请重新启动 mdx 后再试。' },
  { keywords: ['excalidraw preview'], message: '嵌入的 Excalidraw 绘图暂时无法显示。' },
  { keywords: ['invalid excalidraw scene', 'excalidraw scene'], message: '此 Excalidraw 文件格式无效，无法打开或保存。' },
  { keywords: ['excalidraw embed exceeds'], message: '嵌入的 Excalidraw 绘图过大，暂时无法显示。' },
  { keywords: ['excalidraw embed is not valid utf-8'], message: '嵌入的 Excalidraw 文件格式无效，无法显示。' },
  { keywords: ['excalidraw embed'], message: '无法加载嵌入的 Excalidraw 绘图。请使用当前工作区内的相对 Excalidraw 路径。' },
  { keywords: ['image preview could not be displayed'], message: '图片文件已找到，但预览无法显示。请重新打开图片所在文件夹；若仍失败，请尝试转换图片格式。' },
  { keywords: ['image source exceeds the 64 mib limit'], message: '图片文件过大，暂时无法预览。请压缩图片或使用较小的版本后再试。' },
  { keywords: ['image file is not accessible'], message: '无法访问该图片。请在应用内重新打开图片所在文件夹后再试。' },
  { keywords: ['image file not found'], message: '找不到该图片。请检查 Markdown 中的相对路径和文件名。' },
  { keywords: ['failed to read image'], message: '无法加载该图片。请确认图片文件存在并可访问。' },
  { keywords: ['failed to read media'], message: '无法加载该媒体文件。请确认文件存在并可访问。' },
  { keywords: ['failed to play media', 'media playback is not supported'], message: '当前系统不支持播放该媒体格式或编码。' },
  { keywords: ['failed to start html preview server', 'failed to run html preview server', 'html preview server state is poisoned', 'html preview state is poisoned', 'failed to create html preview token'], message: '无法启动 HTML 预览服务。请稍后重试。' },
  { keywords: ['html embed'], message: '无法加载嵌入的 HTML 页面。请使用当前工作区内的相对 HTML 路径。' },
  { keywords: ['invalid image path', 'invalid percent-encoded image path', 'image path is not valid utf-8', 'image path is empty', 'only relative local image paths are supported', 'absolute image paths are not allowed', 'image path traversal is not allowed'], message: '无法加载该图片。请使用当前 Markdown 文件附近的相对图片路径。' },
  { keywords: ['outside the user-authorized', 'outside authorized', 'escaped authorized', 'not been explicitly authorized'], message: '出于安全限制，应用无法访问未授权的文件或文件夹。请从应用内重新打开对应文件或文件夹后再试。' },
  { keywords: ['parent directory traversal is not allowed'], message: '无法打开该路径，因为它会离开允许的文件夹。' },
  { keywords: ['workspace entry name is empty', 'workspace entry name is invalid', 'workspace entry name cannot contain path separators', 'workspace entry name is reserved on windows'], message: '请输入有效的文件或文件夹名称。' },
  { keywords: ['workspace entry already exists'], message: '同名文件或文件夹已存在。请换一个名称。' },
  { keywords: ['cannot modify workspace root'], message: '不能直接重命名或删除当前工作区根目录。' },
  { keywords: ['cannot access path'], message: '无法访问所选路径。请确认文件或文件夹仍然存在，并且应用有权限访问。' },
  { keywords: ['path is not a file', 'authorized file must be a file', 'destination is not a file', 'current markdown path is not a file'], message: '请选择有效的文件后再试。' },
  { keywords: ['path is not a directory', 'authorized root must be a directory'], message: '请选择有效的文件夹后再试。' },
  { keywords: ['authorization state is poisoned'], message: '应用的文件访问状态暂时不可用。请重新打开文件或文件夹后再试。' },
  { keywords: ['invalid selected file path', 'invalid selected directory path', 'invalid save path'], message: '所选路径无效。请重新选择文件或文件夹。' },
  { keywords: ['permission denied', 'not permitted', 'forbidden', 'access denied'], message: '应用没有权限完成此操作。请重新选择文件或文件夹，或检查系统权限设置。' },
  { keywords: ['tauri', 'webview', 'window', 'event', 'channel', 'invoke'], message: '应用窗口通信暂时失败。请重试。' },
] as const);

const EN_ERROR_RULES = Object.freeze([
  { keywords: ['recent file'], message: 'The recent file is no longer available. Choose it again from the updated list.' },
  { keywords: ['exact write authority'], message: 'The file was replaced externally with an unsupported object, so it cannot be saved here. Reopen the document and try again.' },
  { keywords: ['failed to write file'], message: 'The file could not be saved. Confirm that it is still writable, then try again.' },
  { keywords: ['failed to create'], message: 'The item could not be created. Confirm that the destination is writable, then try again.' },
  { keywords: ['failed to rename'], message: 'The item could not be renamed. Confirm that the destination is writable, then try again.' },
  { keywords: ['failed to delete'], message: 'The item could not be deleted. Confirm that it still exists and is accessible.' },
  { keywords: ['failed to read file'], message: 'The file could not be read. Confirm that it still exists and is accessible.' },
  { keywords: ['excalidraw preview module'], message: 'The Excalidraw editor could not be loaded. Restart mdx and try again.' },
  { keywords: ['excalidraw preview'], message: 'The embedded Excalidraw drawing could not be displayed.' },
  { keywords: ['excalidraw scene'], message: 'This Excalidraw file is invalid and cannot be opened or saved.' },
  { keywords: ['excalidraw embed exceeds'], message: 'The embedded Excalidraw drawing is too large to display.' },
  { keywords: ['excalidraw embed is not valid utf-8'], message: 'The embedded Excalidraw file is invalid and cannot be displayed.' },
  { keywords: ['excalidraw embed'], message: 'The embedded Excalidraw drawing could not be displayed. Use a relative Excalidraw path within the current workspace.' },
  { keywords: ['docx'], message: 'This DOCX could not be displayed. The file may be damaged or unsupported.' },
  { keywords: ['pdf'], message: 'This PDF could not be displayed. The file may be damaged or unsupported.' },
  { keywords: ['image'], message: 'The image could not be displayed. Check its relative path and file access.' },
  { keywords: ['media'], message: 'This media file or codec cannot be played on the current system.' },
  { keywords: ['html embed'], message: 'The embedded HTML page could not be displayed. Use a relative HTML path within the current workspace.' },
  { keywords: ['html preview'], message: 'The HTML preview service could not start. Please try again.' },
  { keywords: ['workspace entry name'], message: 'Enter a valid file or folder name.' },
  { keywords: ['already exists'], message: 'An item with the same name already exists.' },
  { keywords: ['workspace root'], message: 'The workspace root cannot be renamed or deleted.' },
  { keywords: ['permission', 'not permitted', 'access denied', 'authorized'], message: 'mdx does not have permission to complete this operation. Reopen the file or folder and try again.' },
  { keywords: ['path', 'directory'], message: 'The selected file or folder is no longer available.' },
  { keywords: ['tauri', 'webview', 'window', 'event', 'invoke'], message: 'Communication with the application window failed. Please try again.' },
] as const);

function matchErrorRules(
  rules: ReadonlyArray<{ readonly keywords: readonly string[]; readonly message: string }>,
  message: string,
): string | null {
  for (const rule of rules) {
    if (rule.keywords.some((keyword) => message.includes(keyword))) return rule.message;
  }
  return null;
}

export function normalizeAppError(error: unknown, locale: EffectiveLocale = 'zh-CN'): string {
  const raw = stringifyError(error).trim();
  const message = raw.toLowerCase();
  if (locale === 'en') {
    return matchErrorRules(EN_ERROR_RULES, message) ?? 'The operation could not be completed. Please try again.';
  }
  if (!raw) return '操作没有完成。请稍后重试。';
  const zhMatch = matchErrorRules(ZH_ERROR_RULES, message);
  if (zhMatch !== null) return zhMatch;
  if (/[\u4e00-\u9fff]/u.test(raw)) return raw;
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
