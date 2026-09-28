// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from './types';
import App from './App';

const appMocks = vi.hoisted(() => ({
  editorPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  jinxiuMarkdown: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  paneResizer: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
  settings: null as AppSettings | null,
  updateSettings: vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined),
  useCrashDraftRecovery: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
  useDocumentSession: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
  listen: vi.fn<() => Promise<() => void>>(async () => () => undefined),
}));
vi.mock('./hooks/useDocumentSession', () => ({
  useDocumentSession: appMocks.useDocumentSession,
}));
vi.mock('./hooks/useCrashDraftRecovery', () => ({
  useCrashDraftRecovery: appMocks.useCrashDraftRecovery,
}));
vi.mock('./lib/tauriCommands', () => ({
  setNativeSaveMenuEnabled: appMocks.setNativeSaveMenuEnabled,
}));
vi.mock('./hooks/usePaneResize', () => ({
  usePaneResize: () => ({
    editorPaneRef: { current: null },
    movePaneResize: vi.fn<() => void>(),
    previewPaneRef: { current: null },
    startPaneResize: vi.fn<() => void>(),
    stopPaneResize: vi.fn<() => void>(),
  }),
}));
vi.mock('./hooks/usePanePopouts', () => ({
  usePanePopouts: () => ({
    closePopoutWindows: vi.fn<() => Promise<void>>(async () => undefined),
    editorPopoutButton: undefined,
    openPanePopout: vi.fn<(pane: 'editor' | 'preview') => Promise<void>>(async () => undefined),
    previewPopoutButton: undefined,
  }),
}));
vi.mock('./hooks/useProgramCloseGuard', () => ({
  useProgramCloseGuard: () => ({
    forceCloseProgram: vi.fn<() => Promise<void>>(async () => undefined),
  }),
}));
vi.mock('./hooks/useSettings', () => ({
  useSettings: () => ({
    busy: false,
    recovery: null,
    reset: vi.fn<() => Promise<void>>(async () => undefined),
    retry: vi.fn<() => Promise<void>>(async () => undefined),
    settings: appMocks.settings,
    updateSettings: appMocks.updateSettings,
  }),
}));
vi.mock('./components/EditorPane', () => ({ EditorPane: appMocks.editorPane }));
vi.mock('./components/PaneResizer', () => ({ PaneResizer: appMocks.paneResizer }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: appMocks.jinxiuMarkdown }));

const baseSettings: AppSettings = {
  autosaveEnabled: true,
  autosaveDelayMs: 1500,
  spellcheckEnabled: true,
  wikilinksEnabled: false,
  resourceDirectory: 'assets',
  editorPaneRatio: 0.5,
  editorFontSize: 16,
  selectedSkin: 'original',
  followSystemTheme: false,
  localeMode: 'system',
  shortcuts: {},
  exportProfiles: {},
};

function createMarkdownSession() {
  const setError = vi.fn<(message: string | null) => void>();
  const setNotice = vi.fn<(message: string | null) => void>();
  return {
    activeFileKind: 'markdown',
    activeMimeType: null,
    activePath: '/workspace/report.md',
    authorityStatus: 'committed',
    broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined),
    busy: false,
    bytesBase64: null,
    content: '# Report',
    createFileInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    createFolderInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    dirty: false,
    documentEpoch: 7,
    documentId: 'document-markdown',
    error: null,
    externalFileAction: null,
    saveConflict: null as { busy: boolean; path: string } | null,
    fileTree: [],
    handleClearRecent: vi.fn<() => Promise<void>>(async () => undefined),
    handleNew: vi.fn<() => void>(),
    handleOpenDirectory: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenFile: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenRecent: vi.fn<(entryId: string) => Promise<void>>(async () => undefined),
    handleSave: vi.fn<() => Promise<void>>(async () => undefined),
    handleSaveAs: vi.fn<() => Promise<void>>(async () => undefined),
    handleCancelSaveConflict: vi.fn<() => void>(),
    handleOverwriteSaveConflict: vi.fn<() => Promise<void>>(async () => undefined),
    moveWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    notice: null,
    openWorkspaceFilePath: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    previewRevision: 0,
    refreshWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    renameWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    saveCurrentDocument: vi.fn<() => Promise<boolean>>(async () => true),
    setError,
    setNotice,
    updateContent: vi.fn<(content: string) => void>(),
    workspaceRoot: '/workspace',
  };
}

function pressKeys(key: string, target: HTMLElement = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key });
  target.dispatchEvent(event);
  return event;
}

describe('App editor font size shortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof createMarkdownSession>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    appMocks.settings = { ...baseSettings };
    appMocks.updateSettings.mockClear();
    appMocks.updateSettings.mockResolvedValue(undefined);
    session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session as unknown as Record<string, unknown>);
    appMocks.useCrashDraftRecovery.mockReturnValue({
      afterConfirmedSave: vi.fn<(documentId: string) => Promise<boolean>>(async () => true), busy: false, canRepairOverflow: false,
      catalog: null, discard: vi.fn<() => void>(), discardAll: vi.fn<() => void>(), error: null,
      overflowRepairProgress: null, repairOverflowBatch: vi.fn<() => void>(), recover: vi.fn<() => void>(), retry: vi.fn<() => void>(),
    } as unknown as Record<string, unknown>);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  const settleFlush = async () => {
    await act(async () => { await new Promise((resolve) => globalThis.setTimeout(resolve, 1)); });
  };

  it('steps and resets the editor font size from zoom-style shortcuts', async () => {
    await act(async () => root.render(<App />));

    const increase = pressKeys('=');
    expect(increase.defaultPrevented).toBe(true);
    expect(appMocks.updateSettings).toHaveBeenCalledTimes(1);
    const increased = appMocks.updateSettings.mock.lastCall?.[0];
    if (!increased) throw new Error('Expected a font size update');

    // 模拟 useSettings 提交新设置后的重渲染，并让串行写入队列清空目标。
    appMocks.settings = increased;
    await act(async () => root.render(<App />));
    await settleFlush();
    appMocks.updateSettings.mockClear();

    const decrease = pressKeys('-');
    expect(decrease.defaultPrevented).toBe(true);
    expect(appMocks.updateSettings.mock.lastCall?.[0].editorFontSize).toBe(16);

    appMocks.settings = { ...baseSettings, editorFontSize: 21 };
    await act(async () => root.render(<App />));
    await settleFlush();
    appMocks.updateSettings.mockClear();
    const reset = pressKeys('0');
    expect(reset.defaultPrevented).toBe(true);
    expect(appMocks.updateSettings.mock.lastCall?.[0].editorFontSize).toBe(16);
  });

  it('keeps the shortcuts working while typing inside the editor content', async () => {
    await act(async () => root.render(<App />));
    const typingTarget = document.createElement('div');
    typingTarget.setAttribute('contenteditable', 'true');
    container.append(typingTarget);

    const increase = pressKeys('=', typingTarget);
    expect(increase.defaultPrevented).toBe(true);
    expect(appMocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(appMocks.updateSettings.mock.lastCall?.[0].editorFontSize).toBe(17);
  });

  it('offers the font shortcuts in the popped-out editor window while other actions stay main-only', async () => {
    window.history.replaceState({}, '', '/?pane=editor');
    await act(async () => root.render(<App />));

    const increase = pressKeys('=');
    expect(increase.defaultPrevented).toBe(true);
    expect(appMocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(appMocks.updateSettings.mock.lastCall?.[0].editorFontSize).toBe(17);

    const save = pressKeys('s');
    expect(save.defaultPrevented).toBe(false);
    expect(session.handleSave).not.toHaveBeenCalled();
  });
});
