// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const appMocks = vi.hoisted(() => ({
  editorPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  excalidrawPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  emit: vi.fn<(event: string, payload: unknown) => Promise<void>>(),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
  jinxiuMarkdown: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  paneResizer: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  pdfPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  previewPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  outlineJumpListener: null as ((event: { payload: unknown }) => void) | null,
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
  listen: vi.fn<(event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  useDocumentSession: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: appMocks.emit,
  emitTo: appMocks.emitTo,
  listen: appMocks.listen,
}));
vi.mock('./components/EditorPane', () => ({ EditorPane: appMocks.editorPane }));
vi.mock('./components/ExcalidrawPane', () => ({ ExcalidrawPane: appMocks.excalidrawPane }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: appMocks.jinxiuMarkdown }));
vi.mock('./components/PaneResizer', () => ({ PaneResizer: appMocks.paneResizer }));
vi.mock('./components/PdfPreview', () => ({ PdfPreview: appMocks.pdfPreview }));
vi.mock('./components/PreviewPane', () => ({ PreviewPane: appMocks.previewPane }));
vi.mock('./hooks/useDocumentSession', () => ({
  useDocumentSession: appMocks.useDocumentSession,
}));
vi.mock('./hooks/useCrashDraftRecovery', () => ({
  useCrashDraftRecovery: () => ({
    afterConfirmedSave: vi.fn<(documentId: string) => Promise<boolean>>(async () => true), busy: false, canRepairOverflow: false,
    catalog: null, discard: vi.fn<() => void>(), discardAll: vi.fn<() => void>(), error: null,
    overflowRepairProgress: null, repairOverflowBatch: vi.fn<() => void>(), recover: vi.fn<() => void>(), retry: vi.fn<() => void>(),
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
vi.mock('./hooks/usePaneResize', () => ({
  usePaneResize: () => ({
    editorPaneRef: { current: null },
    movePaneResize: vi.fn<() => void>(),
    previewPaneRef: { current: null },
    startPaneResize: vi.fn<() => void>(),
    stopPaneResize: vi.fn<() => void>(),
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
    settings: null,
    updateSettings: vi.fn<(settings: unknown) => Promise<void>>(async () => undefined),
  }),
}));
vi.mock('./lib/tauriCommands', () => ({
  setNativeSaveMenuEnabled: appMocks.setNativeSaveMenuEnabled,
}));

function createMarkdownSession() {
  const setError = vi.fn<(message: string | null) => void>();
  const setNotice = vi.fn<(message: string | null) => void>();
  return {
    activeFileKind: 'markdown',
    activeMimeType: null,
    activePath: '/workspace/guide.md',
    authorityStatus: 'committed',
    broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined),
    busy: false,
    bytesBase64: null,
    content: '# Project\n\n## Install\n',
    createFileInWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    createFolderInWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn<() => Promise<void>>(async () => undefined),
    dirty: false,
    documentEpoch: 1,
    documentId: 'document-guide',
    error: null,
    externalFileAction: null,
    fileTree: [],
    handleClearRecent: vi.fn<() => Promise<void>>(async () => undefined),
    handleCloseDeletedDraft: vi.fn<() => Promise<void>>(async () => undefined),
    handleKeepCurrentExternal: vi.fn<() => Promise<void>>(async () => undefined),
    handleNew: vi.fn<() => void>(),
    handleOpenDirectory: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenFile: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenRecent: vi.fn<(entryId: string) => Promise<void>>(async () => undefined),
    handleSave: vi.fn<() => Promise<void>>(async () => undefined),
    handleSaveAs: vi.fn<() => Promise<void>>(async () => undefined),
    handleSaveDeletedDraftAs: vi.fn<() => Promise<void>>(async () => undefined),
    handleUseExternal: vi.fn<() => Promise<void>>(async () => undefined),
    moveWorkspaceEntryPath: vi.fn<() => Promise<void>>(async () => undefined),
    notice: null,
    openWorkspaceFilePath: vi.fn<() => Promise<void>>(async () => undefined),
    previewRevision: 0,
    refreshWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    renameWorkspaceEntryPath: vi.fn<() => Promise<void>>(async () => undefined),
    saveCurrentDocument: vi.fn<() => Promise<boolean>>(async () => true),
    setError,
    setNotice,
    updateContent: vi.fn<(content: string) => void>(),
    workspaceRoot: '/workspace',
  };
}

describe('App outline navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    appMocks.editorPane.mockClear();
    appMocks.emit.mockReset();
    appMocks.emit.mockResolvedValue(undefined);
    appMocks.emitTo.mockReset();
    appMocks.emitTo.mockResolvedValue(undefined);
    appMocks.jinxiuMarkdown.mockClear();
    appMocks.paneResizer.mockClear();
    appMocks.pdfPreview.mockClear();
    appMocks.previewPane.mockClear();
    appMocks.setNativeSaveMenuEnabled.mockReset();
    appMocks.setNativeSaveMenuEnabled.mockResolvedValue(undefined);
    appMocks.listen.mockReset();
    appMocks.outlineJumpListener = null;
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === 'mmd-outline-jump') appMocks.outlineJumpListener = listener;
      return () => undefined;
    });
    appMocks.useDocumentSession.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('sends one heading selection to both the editor and live preview', async () => {
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));

    const outlineTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === 'Outline');
    act(() => outlineTab?.click());
    const installHeading = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
      .find((item) => item.textContent?.includes('Install'));
    act(() => installHeading?.click());

    const editorNavigation = appMocks.editorPane.mock.lastCall?.[0].outlineJump;
    const previewNavigation = appMocks.previewPane.mock.lastCall?.[0].outlineJump;
    expect(editorNavigation).toBe(previewNavigation);
    expect(editorNavigation).toMatchObject({
      documentId: 'document-guide',
      documentEpoch: 1,
      item: {
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
    });
    expect(appMocks.emit).toHaveBeenCalledWith('mmd-outline-jump', editorNavigation);
  });

  it('delivers a matching outline jump to an editor popout', async () => {
    window.history.replaceState({}, '', '/?pane=editor');
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    const jump = {
      documentEpoch: 1,
      documentId: 'document-guide',
      item: {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
      requestId: 1,
    };
    act(() => appMocks.outlineJumpListener?.({ payload: jump }));

    expect(appMocks.editorPane.mock.lastCall?.[0].outlineJump).toEqual(jump);
  });

  it('delivers a matching outline jump to a preview popout', async () => {
    window.history.replaceState({}, '', '/?pane=preview');
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    const jump = {
      documentEpoch: 1,
      documentId: 'document-guide',
      item: {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
      requestId: 1,
    };
    act(() => appMocks.outlineJumpListener?.({ payload: jump }));

    expect(appMocks.previewPane.mock.lastCall?.[0].outlineJump).toEqual(jump);
  });

  it('drops an old outline jump when the document epoch changes', async () => {
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    const outlineTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === 'Outline');
    act(() => outlineTab?.click());
    const installHeading = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
      .find((item) => item.textContent?.includes('Install'));
    act(() => installHeading?.click());

    session.content = '# Replacement\n\n## Install\n';
    session.documentEpoch = 2;
    await act(async () => root.render(<App />));

    expect(appMocks.editorPane.mock.lastCall?.[0].outlineJump).toBeNull();
    expect(appMocks.previewPane.mock.lastCall?.[0].outlineJump).toBeNull();
  });
});
