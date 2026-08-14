import { describe, expect, it } from 'vitest';
import { getPopoutOpenErrorMessage } from './popoutFeedback';

describe('popout feedback', () => {
  it('formats errors only for creating a new popout window with friendly details', () => {
    expect(getPopoutOpenErrorMessage('editor', 'permission denied')).toBe('无法打开 Editor 独立窗口：应用没有权限完成此操作。请重新选择文件或文件夹，或检查系统权限设置。');
    expect(getPopoutOpenErrorMessage('preview', new Error('webview failed'))).toBe('无法打开 Live Preview 独立窗口：应用窗口通信暂时失败。请重试。');
  });
});
