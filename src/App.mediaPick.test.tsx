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
  pickMediaResources: vi.fn<(input: Record<string, unknown>) => Promise<{ name: string; markdownPath: string }[]>>(),
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
  pickMediaResources: appMocks.pickMediaResources,
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
  autosaveMode: 'afterDelay',
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

function createMarkdownSession(withWorkspace: boolean) {
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
    files: withWorkspace
      ? [{
        absolutePath: '/workspace/report.md',
        kind: 'markdown' as const,
        name: 'report.md',
        path: '/workspace/report.md',
        relativePath: 'report.md',
        file: { kind: 'markdown' as const, name: 'report.md', path: '/workspace/report.md', relative_path: 'report.md' },
      }]
      : [],
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
    workspaceRoot: withWorkspace ? '/workspace' : null,
    workspaceToken: withWorkspace ? 'workspace-token-7' : null,
  };
}

describe('App media resource picking', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    appMocks.settings = { ...baseSettings };
    appMocks.pickMediaResources.mockReset();
    appMocks.updateSettings.mockClear();
    appMocks.useDocumentSession.mockReset();
    appMocks.useCrashDraftRecovery.mockReset();
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

  const lastEditorPaneProps = (): Record<string, unknown> => appMocks.editorPane.mock.lastCall?.[0] ?? {};

  it('inserts picked media references at the cursor with the document directory as default', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession(true) as unknown as Record<string, unknown>);
    appMocks.pickMediaResources.mockResolvedValue([
      { name: 'cover.png', markdownPath: 'assets/cover.png' },
      { name: 'holiday photo.jpg', markdownPath: 'assets/holiday photo.jpg' },
    ]);

    await act(async () => root.render(<App />));
    const onMediaCommandPick = lastEditorPaneProps().onMediaCommandPick as (command: 'image') => void;
    if (typeof onMediaCommandPick !== 'function') throw new Error('Expected a media command picker');

    await act(async () => onMediaCommandPick('image'));

    expect(appMocks.pickMediaResources).toHaveBeenCalledTimes(1);
    expect(appMocks.pickMediaResources.mock.lastCall?.[0]).toMatchObject({
      mediaKind: 'image',
      defaultDirectory: '/workspace',
      documentPath: '/workspace/report.md',
      resourceDirectory: 'assets',
      workspaceToken: 'workspace-token-7',
    });
    const insertion = lastEditorPaneProps().mediaInsertion as { markdown: string; target: { kind: string } } | null;
    expect(insertion?.target.kind).toBe('cursor');
    expect(insertion?.markdown).toBe(
      '![cover.png](assets/cover.png)\n\n![holiday photo.jpg](assets/holiday%20photo.jpg)',
    );
  });

  it('applies the meme and embed reference templates for their palette commands', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession(true) as unknown as Record<string, unknown>);
    appMocks.pickMediaResources.mockResolvedValue([
      { name: 'funny.gif', markdownPath: 'assets/funny.gif' },
    ]);

    await act(async () => root.render(<App />));
    const onMediaCommandPick = lastEditorPaneProps().onMediaCommandPick as (command: 'meme') => void;
    await act(async () => onMediaCommandPick('meme'));

    expect(appMocks.pickMediaResources.mock.lastCall?.[0]).toMatchObject({ mediaKind: 'image' });
    expect((lastEditorPaneProps().mediaInsertion as { markdown: string }).markdown)
      .toBe('![funny.gif](assets/funny.gif "mmd:meme")');
  });

  it('inserts nothing when the picker is cancelled', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession(true) as unknown as Record<string, unknown>);
    appMocks.pickMediaResources.mockResolvedValue([]);

    await act(async () => root.render(<App />));
    const onMediaCommandPick = lastEditorPaneProps().onMediaCommandPick as (command: 'video') => void;
    await act(async () => onMediaCommandPick('video'));

    expect(appMocks.pickMediaResources).toHaveBeenCalledWith(expect.objectContaining({ mediaKind: 'video' }));
    expect(lastEditorPaneProps().mediaInsertion ?? null).toBeNull();
  });

  it('explains that media picking requires a workspace document', async () => {
    const session = createMarkdownSession(false);
    appMocks.useDocumentSession.mockReturnValue(session as unknown as Record<string, unknown>);

    await act(async () => root.render(<App />));
    const onMediaCommandPick = lastEditorPaneProps().onMediaCommandPick as (command: 'image') => void;
    await act(async () => onMediaCommandPick('image'));

    expect(appMocks.pickMediaResources).not.toHaveBeenCalled();
    expect(session.setError).toHaveBeenCalledWith('Inserting media requires a Markdown document opened from a workspace.');
    expect(session.setNotice).toHaveBeenCalledWith(null);
  });
});
