import { describe, expect, it, vi } from 'vitest';
import { emitAppFeedbackError, getFeedbackDialog, normalizeAppError } from './appFeedback';

describe('app feedback dialog', () => {
  it('shows notices as modal dialogs with a friendly acknowledgement action', () => {
    expect(getFeedbackDialog({ notice: '操作已完成。', error: null })).toEqual({
      kind: 'info',
      role: 'dialog',
      title: '提示',
      message: '操作已完成。',
      dismissLabel: '知道了',
    });
  });

  it('shows errors as alert dialogs and prioritizes them over notices', () => {
    expect(getFeedbackDialog({ notice: '已完成', error: '保存失败' })).toEqual({
      kind: 'error',
      role: 'alertdialog',
      title: '出现问题',
      message: '保存失败',
      dismissLabel: '知道了',
    });
  });

  it('does not render a feedback dialog when there is no message', () => {
    expect(getFeedbackDialog({ notice: null, error: null })).toBeNull();
  });

  it('normalizes authorization and path errors without exposing backend details', () => {
    expect(normalizeAppError('File is outside the user-authorized session files and directories')).toBe('出于安全限制，应用无法访问未授权的文件或文件夹。请从应用内重新打开对应文件或文件夹后再试。');
    expect(normalizeAppError('Cannot access path: No such file or directory (os error 2)')).toBe('无法访问所选路径。请确认文件或文件夹仍然存在，并且应用有权限访问。');
    expect(normalizeAppError('Destination file has not been explicitly authorized by open, workspace selection, or save-as')).not.toContain('explicitly authorized');
  });

  it('normalizes image resolver errors without exposing raw runtime text', () => {
    expect(normalizeAppError('Failed to read image: Permission denied (os error 13)')).toBe('无法加载该图片。请确认图片文件存在并可访问。');
    expect(normalizeAppError('Image file is not accessible: Permission denied (os error 13)')).toBe('无法访问该图片。请在应用内重新打开图片所在文件夹后再试。');
    expect(normalizeAppError('Image source exceeds the 64 MiB limit')).toBe('图片文件过大，暂时无法预览。请压缩图片或使用较小的版本后再试。');
    expect(normalizeAppError('Image path traversal is not allowed')).toBe('无法加载该图片。请使用当前 Markdown 文件附近的相对图片路径。');
    expect(getFeedbackDialog({ notice: null, error: 'Image file not found' })?.message).toBe('找不到该图片。请检查 Markdown 中的相对路径和文件名。');
  });

  it('normalizes media loading and playback errors', () => {
    expect(normalizeAppError('Failed to read media: Permission denied (os error 13)')).toBe('无法加载该媒体文件。请确认文件存在并可访问。');
    expect(normalizeAppError('Media playback is not supported by this WebView')).toBe('当前系统不支持播放该媒体格式或编码。');
    expect(normalizeAppError('Failed to play media')).toBe('当前系统不支持播放该媒体格式或编码。');
  });

  it('normalizes HTML preview server errors', () => {
    expect(normalizeAppError('Failed to start HTML preview server: address unavailable')).toBe('无法启动 HTML 预览服务。请稍后重试。');
    expect(normalizeAppError('HTML preview server state is poisoned')).toBe('无法启动 HTML 预览服务。请稍后重试。');
    expect(normalizeAppError('Failed to create HTML preview token: random source unavailable')).toBe('无法启动 HTML 预览服务。请稍后重试。');
  });

  it('normalizes Markdown HTML embed errors without exposing path validation details', () => {
    expect(normalizeAppError('HTML embed target escaped the Markdown directory')).toBe(
      '无法加载嵌入的 HTML 页面。请使用当前工作区内的相对 HTML 路径。',
    );
    expect(normalizeAppError('Cannot read HTML embed: Permission denied (os error 13)', 'en')).toBe(
      'The embedded HTML page could not be displayed. Use a relative HTML path within the current workspace.',
    );
  });

  it('normalizes Markdown Excalidraw embed errors without exposing path validation details', () => {
    expect(normalizeAppError('Excalidraw embed target escaped authorized roots')).toBe(
      '无法加载嵌入的 Excalidraw 绘图。请使用当前工作区内的相对 Excalidraw 路径。',
    );
    expect(normalizeAppError('Excalidraw embed file not found', 'en')).toBe(
      'The embedded Excalidraw drawing could not be displayed. Use a relative Excalidraw path within the current workspace.',
    );
  });

  it('normalizes recent-file contention and stale entries', () => {
    expect(normalizeAppError('Recent files store is busy')).toBe(
      '最近文件列表正在被另一个应用进程更新。请稍后重试。',
    );
    expect(normalizeAppError('Recent file is no longer available')).toBe(
      '最近文件已移动、删除或不再受支持。请从更新后的列表中重新选择。',
    );
    expect(normalizeAppError('Open target is no longer a supported file')).toBe(
      '最近文件已移动、删除或不再受支持。请从更新后的列表中重新选择。',
    );
  });

  it('normalizes derived preview and native-menu synchronization errors', () => {
    expect(normalizeAppError('Failed to authorize preview assets: unavailable')).toBe(
      '文件已打开，但预览权限暂时无法同步。请重新打开该文件后再试。',
    );
    expect(normalizeAppError('Recent files menu synchronization failed')).toBe(
      '最近文件已更新，但系统菜单暂时无法同步。请重试最近文件操作，或重新启动应用。',
    );
  });

  it('keeps an exhausted Excalidraw module load failure distinct from an invalid scene', () => {
    const error = 'Failed to load Excalidraw preview module';

    expect(normalizeAppError(error)).toBe(
      'Excalidraw 编辑器暂时无法加载。请重新启动 mdx 后再试。',
    );
    expect(normalizeAppError(error, 'en')).toBe(
      'The Excalidraw editor could not be loaded. Restart mdx and try again.',
    );
    expect(normalizeAppError('Excalidraw preview could not be rendered')).toBe(
      '嵌入的 Excalidraw 绘图暂时无法显示。',
    );
  });

  it('emits raw errors for the app shell to normalize once', () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal('window', eventTarget);
    const handler = vi.fn<(event: Event) => void>();
    eventTarget.addEventListener('mmd:app-feedback-error', handler);

    emitAppFeedbackError('Resolved image escaped authorized roots');

    eventTarget.removeEventListener('mmd:app-feedback-error', handler);
    vi.unstubAllGlobals();
    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).detail).toBe('Resolved image escaped authorized roots');
  });

  it('keeps Markdown HTML embed errors specific through the feedback event and dialog', () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal('window', eventTarget);
    let emittedError: string | null = null;
    const handler = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        emittedError = event.detail;
      }
    };
    eventTarget.addEventListener('mmd:app-feedback-error', handler);

    emitAppFeedbackError('HTML embed target escaped the Markdown directory');

    eventTarget.removeEventListener('mmd:app-feedback-error', handler);
    vi.unstubAllGlobals();
    expect(getFeedbackDialog({ notice: null, error: emittedError }, 'en')?.message).toBe(
      'The embedded HTML page could not be displayed. Use a relative HTML path within the current workspace.',
    );
  });
});
