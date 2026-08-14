import { describe, expect, it } from 'vitest';
import {
  getProgramClosePopoutLabels,
  getUnsavedExitPrompt,
  getUnsavedFileSwitchPrompt,
  shouldBlockProgramCloseOnPopoutCloseFailure,
  shouldPreventDefaultProgramClose,
  shouldShowUnsavedExitPrompt,
} from './closeGuard';

describe('program close guard', () => {
  it('shows the unsaved-exit prompt only when the main window has unsaved changes', () => {
    expect(shouldShowUnsavedExitPrompt({ dirty: true, isPopout: false })).toBe(true);
    expect(shouldShowUnsavedExitPrompt({ dirty: false, isPopout: false })).toBe(false);
    expect(shouldShowUnsavedExitPrompt({ dirty: true, isPopout: true })).toBe(false);
  });

  it('closes both popout windows when the program closes', () => {
    expect(getProgramClosePopoutLabels()).toEqual(['mmd-editor-popout', 'mmd-preview-popout']);
  });

  it('does not block main-window close if best-effort popout cleanup fails', () => {
    expect(shouldBlockProgramCloseOnPopoutCloseFailure()).toBe(false);
  });

  it('prevents the default close while the dirty main window waits for a save/cancel/quit decision', () => {
    expect(shouldPreventDefaultProgramClose({ dirty: false, isPopout: false })).toBe(false);
    expect(shouldPreventDefaultProgramClose({ dirty: true, isPopout: true })).toBe(false);
    expect(shouldPreventDefaultProgramClose({ dirty: true, isPopout: false })).toBe(true);
  });

  it('describes the unsaved file and offers save, cancel, and quit actions', () => {
    expect(getUnsavedExitPrompt('notes/today.md')).toEqual({
      title: '有未保存的更改',
      message: '“today.md” 尚未保存。退出前要保存吗？',
      saveLabel: '保存',
      cancelLabel: '取消',
      quitLabel: '退出程序',
    });
    expect(getUnsavedExitPrompt(null).message).toContain('Untitled.md');
  });

  it('describes both files when unsaved changes block a file switch', () => {
    expect(getUnsavedFileSwitchPrompt('notes/report.md', 'notes/today.md')).toEqual({
      title: '有未保存的更改',
      message: '“report.md” 尚未保存。切换到“today.md”前要保存吗？',
      saveLabel: '保存并切换',
      cancelLabel: '取消',
      quitLabel: '不保存并切换',
    });
  });
});
