// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import {
  MARKDOWN_MEDIA_INSERTION_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
  MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
  MARKDOWN_MEDIA_INSERTION_READY_EVENT,
} from './lib/markdownMedia';
import { getPanePopoutLabel } from './lib/paneLayout';
import type { PanePopoutOpenOutcome } from './lib/paneWindow';

const appMocks = vi.hoisted(() => ({
  authorizeResourceDirectory: vi.fn<() => Promise<Record<string, unknown> | null>>(),
  docxPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  editorPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  editorPopoutButton: undefined as Record<string, unknown> | undefined,
  excalidrawPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  emit: vi.fn<(event: string, payload: unknown) => Promise<void>>(),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
  fileSidebar: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  renderAndSyncExcalidrawAssetPair: vi.fn<() => Promise<Record<string, unknown>>>(),
  jinxiuMarkdown: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  listen: vi.fn<(event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  openPanePopout: vi.fn<(pane: 'editor' | 'preview', instanceId?: string) => Promise<PanePopoutOpenOutcome>>(),
  paneResizer: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  pdfPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  previewPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
  settings: null as null | Record<string, unknown>,
  settingsDialog: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  useDocumentSession: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
  writeWorkspaceResource: vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: appMocks.emit,
  emitTo: appMocks.emitTo,
  listen: appMocks.listen,
}));
vi.mock('./components/EditorPane', () => ({ EditorPane: appMocks.editorPane }));
vi.mock('./components/DocxPreview', () => ({ DocxPreview: appMocks.docxPreview }));
vi.mock('./components/ExcalidrawPane', () => ({ ExcalidrawPane: appMocks.excalidrawPane }));
vi.mock('./components/FileSidebar', () => ({ FileSidebar: appMocks.fileSidebar }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: appMocks.jinxiuMarkdown }));
vi.mock('./components/PaneResizer', () => ({ PaneResizer: appMocks.paneResizer }));
vi.mock('./components/PdfPreview', () => ({ PdfPreview: appMocks.pdfPreview }));
vi.mock('./components/PreviewPane', () => ({ PreviewPane: appMocks.previewPane }));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: appMocks.settingsDialog }));
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
    editorPopoutButton: appMocks.editorPopoutButton,
    openPanePopout: appMocks.openPanePopout,
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
    settings: appMocks.settings,
    updateSettings: vi.fn<(settings: unknown) => Promise<void>>(async () => undefined),
  }),
}));
vi.mock('./lib/tauriCommands', () => ({
  authorizeResourceDirectory: appMocks.authorizeResourceDirectory,
  setNativeSaveMenuEnabled: appMocks.setNativeSaveMenuEnabled,
  writeWorkspaceResource: appMocks.writeWorkspaceResource,
}));
vi.mock('./lib/excalidrawAssetSync', () => ({
  renderAndSyncExcalidrawAssetPair: appMocks.renderAndSyncExcalidrawAssetPair,
}));

function createMarkdownSession() {
  return {
    activeFileKind: 'markdown',
    activeMimeType: null,
    activePath: '/workspace/docs/guide.md',
    authorityStatus: 'committed',
    broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined),
    busy: false,
    bytesBase64: null,
    content: '# Guide',
    createFileInWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    createFolderInWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn<() => Promise<void>>(async () => undefined),
    dirty: false,
    documentEpoch: 1,
    documentId: 'document-guide',
    error: null,
    externalFileAction: null,
    files: [{
      kind: 'markdown',
      name: 'guide.md',
      path: '/workspace/docs/guide.md',
      relative_path: 'docs/guide.md',
    }, {
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }],
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
    setError: vi.fn<(message: string | null) => void>(),
    setNotice: vi.fn<(message: string | null) => void>(),
    updateContent: vi.fn<(content: string) => void>(),
    workspaceRoot: '/workspace',
    workspaceToken: 'workspace-token',
  };
}

type MockEventListener = (event: { payload: unknown }) => void;

const TEST_POPOUT_INSTANCE_ID = 'markdown-media-popout:test';

function readyPayload(
  documentId = 'document-guide',
  documentEpoch = 1,
  popoutInstanceId = TEST_POPOUT_INSTANCE_ID,
  readyRequestId?: string,
) {
  return {
    documentEpoch,
    documentId,
    popoutInstanceId,
    ...(readyRequestId ? { readyRequestId } : {}),
  };
}

function captureEditorPopoutHandshakeListeners() {
  const listeners: {
    handshakeAck: MockEventListener | null;
    ready: MockEventListener | null;
  } = { handshakeAck: null, ready: null };
  appMocks.listen.mockImplementation(async (event, listener) => {
    if (event === MARKDOWN_MEDIA_INSERTION_READY_EVENT) listeners.ready = listener;
    if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT) listeners.handshakeAck = listener;
    return () => undefined;
  });
  return listeners;
}

function emitToCallsFor(eventName: string) {
  return appMocks.emitTo.mock.calls.filter(([, event]) => event === eventName);
}

async function establishEditorPopoutHandshake(listeners: ReturnType<typeof captureEditorPopoutHandshakeListeners>) {
  const readyRequests = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT);
  const readyRequest = readyRequests[readyRequests.length - 1]?.[2] as
    | { readyRequestId?: string }
    | undefined;
  act(() => listeners.ready?.({
    payload: readyPayload('document-guide', 1, TEST_POPOUT_INSTANCE_ID, readyRequest?.readyRequestId),
  }));
  await act(async () => {
    await Promise.resolve();
  });
  const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
  const handshakeCall = handshakeCalls[handshakeCalls.length - 1];
  expect(handshakeCall).toBeDefined();
  act(() => listeners.handshakeAck?.({ payload: handshakeCall?.[2] }));
  await act(async () => {
    await Promise.resolve();
  });
}

describe('App workspace media insertion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    appMocks.editorPane.mockClear();
    appMocks.authorizeResourceDirectory.mockReset();
    appMocks.editorPopoutButton = undefined;
    appMocks.emit.mockReset();
    appMocks.emit.mockResolvedValue(undefined);
    appMocks.emitTo.mockReset();
    appMocks.emitTo.mockResolvedValue(undefined);
    appMocks.fileSidebar.mockClear();
    appMocks.renderAndSyncExcalidrawAssetPair.mockReset();
    appMocks.jinxiuMarkdown.mockClear();
    appMocks.listen.mockReset();
    appMocks.listen.mockResolvedValue(() => undefined);
    appMocks.openPanePopout.mockReset();
    appMocks.openPanePopout.mockImplementation(async (pane) => ({ status: 'created', pane }));
    appMocks.paneResizer.mockClear();
    appMocks.previewPane.mockClear();
    appMocks.setNativeSaveMenuEnabled.mockReset();
    appMocks.setNativeSaveMenuEnabled.mockResolvedValue(undefined);
    appMocks.settings = null;
    appMocks.settingsDialog.mockClear();
    appMocks.useDocumentSession.mockReset();
    appMocks.writeWorkspaceResource.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('routes a dropped workspace image into the current Markdown editor', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'coordinates'; clientX: number; clientY: number }) => void)
      | undefined;
    expect(onInsertWorkspaceAsset).toEqual(expect.any(Function));

    act(() => onInsertWorkspaceAsset?.({
      kind: 'image',
      name: 'cover.png',
      path: '/workspace/assets/cover.png',
      relative_path: 'assets/cover.png',
    }, { kind: 'coordinates', clientX: 240, clientY: 160 }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toEqual({
      documentEpoch: 1,
      documentId: 'document-guide',
      markdown: '![cover.png](../assets/cover.png)',
      requestId: 1,
      target: { kind: 'coordinates', clientX: 240, clientY: 160 },
    });
  });

  it('exports an Excalidraw sidecar pair before inserting its source-linked Markdown', async () => {
    appMocks.settings = {
      autosaveDelayMs: 1500,
      autosaveEnabled: false,
      editorPaneRatio: 0.5,
      resourceDirectory: 'assets',
      spellcheckEnabled: true,
    };
    appMocks.renderAndSyncExcalidrawAssetPair.mockResolvedValue({
      markdown: '<!-- mmd:excalidraw -->\n[![system](../assets/excalidraw-assets/system.svg)](../diagrams/system.excalidraw "mmd:source")',
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => Promise<void>)
      | undefined;
    await act(async () => {
      await onInsertWorkspaceAsset?.({
        kind: 'excalidraw',
        name: 'system.excalidraw',
        path: '/workspace/diagrams/system.excalidraw',
        relative_path: 'diagrams/system.excalidraw',
      }, { kind: 'cursor' });
    });

    expect(appMocks.renderAndSyncExcalidrawAssetPair).toHaveBeenCalledWith(expect.objectContaining({
      documentPath: '/workspace/docs/guide.md',
      sourceRelativePath: 'diagrams/system.excalidraw',
      resourceDirectory: 'assets',
      workspaceRoot: '/workspace',
      workspaceToken: 'workspace-token',
    }));
    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toEqual(expect.objectContaining({
      documentEpoch: 1,
      documentId: 'document-guide',
      markdown: expect.stringContaining('mmd:source'),
      target: { kind: 'cursor' },
    }));
  });

  it('writes a clipboard image to the configured resource directory and returns a document-relative reference', async () => {
    appMocks.settings = {
      autosaveDelayMs: 1500,
      autosaveEnabled: false,
      editorPaneRatio: 0.5,
      resourceDirectory: 'assets',
      spellcheckEnabled: true,
    };
    appMocks.writeWorkspaceResource.mockResolvedValue({
      created: true,
      digestMd5: '0123456789abcdef0123456789abcdef',
      fileName: '0123456789abcdef0123456789abcdef.png',
      markdownPath: '../assets/0123456789abcdef0123456789abcdef.png',
      relativePath: 'assets/0123456789abcdef0123456789abcdef.png',
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));
    const onPasteImage = appMocks.editorPane.mock.lastCall?.[0].onPasteImage as
      | ((request: Record<string, unknown>) => Promise<string | null>)
      | undefined;

    let markdown: string | null | undefined;
    await act(async () => {
      markdown = await onPasteImage?.({
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        documentEpoch: 1,
        documentId: 'document-guide',
        mimeType: 'image/png',
        suggestedName: 'clipboard.png',
      });
    });

    expect(appMocks.writeWorkspaceResource).toHaveBeenCalledWith({
      bytesBase64: 'AQID',
      documentPath: '/workspace/docs/guide.md',
      mimeType: 'image/png',
      resourceDirectory: 'assets',
      suggestedName: 'clipboard.png',
      workspaceRoot: '/workspace',
      workspaceToken: 'workspace-token',
    });
    expect(markdown).toBe('![clipboard.png](../assets/0123456789abcdef0123456789abcdef.png)');
  });

  it('uses a live folder-picker authorization for an absolute resource directory', async () => {
    appMocks.settings = {
      autosaveDelayMs: 1500,
      autosaveEnabled: false,
      editorPaneRatio: 0.5,
      resourceDirectory: '/shared/mmd assets',
      spellcheckEnabled: true,
    };
    appMocks.authorizeResourceDirectory.mockResolvedValue({
      path: '/shared/mmd assets',
      token: 'workspace-resource-9',
    });
    appMocks.writeWorkspaceResource.mockResolvedValue({
      created: true,
      digestMd5: '0123456789abcdef0123456789abcdef',
      fileName: '0123456789abcdef0123456789abcdef.png',
      markdownPath: '../../shared/mmd assets/0123456789abcdef0123456789abcdef.png',
      relativePath: '../../shared/mmd assets/0123456789abcdef0123456789abcdef.png',
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    await act(async () => container.querySelector<HTMLButtonElement>('[title="Settings"]')?.click());
    const onAuthorizeResourceDirectory = appMocks.settingsDialog.mock.lastCall?.[0]
      .onAuthorizeResourceDirectory as (() => Promise<string | null>) | undefined;
    await act(async () => {
      await expect(onAuthorizeResourceDirectory?.()).resolves.toBe('/shared/mmd assets');
    });

    const onPasteImage = appMocks.editorPane.mock.lastCall?.[0].onPasteImage as
      (request: Record<string, unknown>) => Promise<string | null>;
    let markdown: string | null = null;
    await act(async () => {
      markdown = await onPasteImage({
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        documentEpoch: 1,
        documentId: 'document-guide',
        mimeType: 'image/png',
        suggestedName: 'clipboard [final].png',
      });
    });

    expect(appMocks.writeWorkspaceResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceDirectory: '/shared/mmd assets',
      resourceDirectoryToken: 'workspace-resource-9',
    }));
    expect(markdown).toBe(
      '![clipboard \\[final\\].png](../../shared/mmd%20assets/0123456789abcdef0123456789abcdef.png)',
    );
  });

  it('drops a clipboard image result when the active document changes during the write', async () => {
    appMocks.settings = {
      autosaveDelayMs: 1500,
      autosaveEnabled: false,
      editorPaneRatio: 0.5,
      resourceDirectory: 'assets',
      spellcheckEnabled: true,
    };
    let finishWrite: ((value: Record<string, unknown>) => void) | undefined;
    appMocks.writeWorkspaceResource.mockImplementation(() => new Promise((resolve) => {
      finishWrite = resolve;
    }));
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));
    const onPasteImage = appMocks.editorPane.mock.lastCall?.[0].onPasteImage as
      (request: Record<string, unknown>) => Promise<string | null>;
    const pending = onPasteImage({
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      documentEpoch: 1,
      documentId: 'document-guide',
      mimeType: 'image/png',
      suggestedName: 'clipboard.png',
    });
    await act(async () => {
      await Promise.resolve();
    });
    appMocks.useDocumentSession.mockReturnValue({
      ...createMarkdownSession(),
      activePath: '/workspace/docs/next.md',
      documentEpoch: 2,
      documentId: 'document-next',
      files: [{
        kind: 'markdown',
        name: 'next.md',
        path: '/workspace/docs/next.md',
        relative_path: 'docs/next.md',
      }],
    });
    await act(async () => root.render(<App />));
    let markdown: string | null | undefined;
    await act(async () => {
      finishWrite?.({
        created: true,
        digestMd5: '0123456789abcdef0123456789abcdef',
        fileName: 'image.png',
        markdownPath: '../assets/image.png',
        relativePath: 'assets/image.png',
      });
      markdown = await pending;
    });

    expect(markdown).toBeNull();
  });

  it('routes clipboard resource write failures through modal feedback state', async () => {
    appMocks.settings = {
      autosaveDelayMs: 1500,
      autosaveEnabled: false,
      editorPaneRatio: 0.5,
      resourceDirectory: 'assets',
      spellcheckEnabled: true,
    };
    appMocks.writeWorkspaceResource.mockRejectedValue(new Error('resource write failed'));
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    const onPasteImage = appMocks.editorPane.mock.lastCall?.[0].onPasteImage as
      (request: Record<string, unknown>) => Promise<string | null>;

    await act(async () => {
      await expect(onPasteImage({
        blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        documentEpoch: 1,
        documentId: 'document-guide',
        mimeType: 'image/png',
        suggestedName: 'clipboard.png',
      })).resolves.toBeNull();
    });

    expect(session.setError).toHaveBeenCalledWith(expect.any(String));
    expect(session.setNotice).toHaveBeenCalledWith(null);
  });

  it('routes a dropped workspace audio file as a Markdown link', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'coordinates'; clientX: number; clientY: number }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'audio',
      name: 'intro.mp3',
      path: '/workspace/audio/intro.mp3',
      relative_path: 'audio/intro.mp3',
    }, { kind: 'coordinates', clientX: 240, clientY: 160 }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toMatchObject({
      markdown: '[intro.mp3](../audio/intro.mp3)',
    });
  });

  it('routes a context-menu image insertion to the current cursor', async () => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'image',
      name: 'cover.png',
      path: '/workspace/assets/cover.png',
      relative_path: 'assets/cover.png',
    }, { kind: 'cursor' }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toMatchObject({
      markdown: '![cover.png](../assets/cover.png)',
      target: { kind: 'cursor' },
    });
    expect(appMocks.emitTo).not.toHaveBeenCalled();
  });

  it('serializes cursor insertions until an open editor popout is ready', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    let releaseFirstDelivery: (() => void) | null = null;
    appMocks.emitTo.mockImplementation((_target, event) => {
      if (event !== MARKDOWN_MEDIA_INSERTION_EVENT || releaseFirstDelivery) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toBeNull();
    expect(listeners.ready).toEqual(expect.any(Function));
    expect(listeners.handshakeAck).toEqual(expect.any(Function));
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(0);
    await establishEditorPopoutHandshake(listeners);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)[0]).toEqual([
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_EVENT,
      {
        asset: {
          kind: 'html',
          name: 'demo.html',
          relative_path: 'demos/demo.html',
        },
        documentRelativePath: 'docs/guide.md',
        documentEpoch: 1,
        documentId: 'document-guide',
        popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
        requestId: 1,
      },
    ]);
    await act(async () => {
      releaseFirstDelivery?.();
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)[1]).toEqual([
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_EVENT,
      {
        asset: {
          kind: 'excalidraw',
          name: 'diagram.excalidraw',
          relative_path: 'diagrams/diagram.excalidraw',
        },
        documentRelativePath: 'docs/guide.md',
        documentEpoch: 1,
        documentId: 'document-guide',
        popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
        requestId: 2,
      },
    ]);
  });

  it('drops queued deliveries after the editor popout closes', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    let releaseFirstDelivery: (() => void) | null = null;
    appMocks.emitTo.mockImplementation((_target, event) => {
      if (event !== MARKDOWN_MEDIA_INSERTION_EVENT || releaseFirstDelivery) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });
    });
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));
    await establishEditorPopoutHandshake(listeners);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);

    appMocks.editorPopoutButton = undefined;
    await act(async () => root.render(<App />));
    await act(async () => {
      releaseFirstDelivery?.();
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
  });

  it('does not trust a delayed ready event after the editor popout reopens', async () => {
    let mediaInsertionReadyListener: ((event: { payload: unknown }) => void) | null = null;
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === MARKDOWN_MEDIA_INSERTION_READY_EVENT) mediaInsertionReadyListener = listener;
      return () => undefined;
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const firstOpen = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
    act(() => firstOpen?.());
    const firstInstanceId = appMocks.openPanePopout.mock.calls[0]?.[1];
    expect(firstInstanceId).toEqual(expect.any(String));

    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    await act(async () => root.render(<App />));
    act(() => mediaInsertionReadyListener?.({
      payload: readyPayload('document-guide', 1, firstInstanceId as string),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const initialHandshakeCount = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT).length;
    expect(initialHandshakeCount).toBe(1);

    appMocks.editorPopoutButton = undefined;
    await act(async () => root.render(<App />));

    const secondOpen = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
    act(() => secondOpen?.());
    const secondInstanceId = appMocks.openPanePopout.mock.calls[1]?.[1];
    expect(secondInstanceId).toEqual(expect.any(String));
    expect(secondInstanceId).not.toBe(firstInstanceId);

    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    await act(async () => root.render(<App />));

    act(() => mediaInsertionReadyListener?.({
      payload: readyPayload('document-guide', 1, firstInstanceId as string),
    }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(initialHandshakeCount);

    act(() => mediaInsertionReadyListener?.({
      payload: readyPayload('document-guide', 1, secondInstanceId as string),
    }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(initialHandshakeCount + 1);
  });

  it('recovers insertion when a stale closed state discovers an existing editor popout', async () => {
    const listeners = captureEditorPopoutHandshakeListeners();
    const existingInstanceId = 'markdown-media-popout:existing';
    appMocks.openPanePopout.mockResolvedValue({ status: 'existing', pane: 'editor' });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onPopout = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
    act(() => onPopout?.());
    await act(async () => {
      await Promise.resolve();
    });

    const speculativeInstanceId = appMocks.openPanePopout.mock.calls[0]?.[1];
    expect(speculativeInstanceId).toEqual(expect.any(String));
    expect(speculativeInstanceId).not.toBe(existingInstanceId);
    const readyRequest = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT)[0]?.[2] as
      | { documentEpoch: number; documentId: string; readyRequestId: string }
      | undefined;
    expect(readyRequest).toEqual(expect.objectContaining({
      documentEpoch: 1,
      documentId: 'document-guide',
      readyRequestId: expect.any(String),
    }));

    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    await act(async () => root.render(<App />));
    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));

    act(() => listeners.ready?.({
      payload: readyPayload('document-guide', 1, 'markdown-media-popout:stale'),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(0);

    act(() => listeners.ready?.({
      payload: readyPayload('document-guide', 1, existingInstanceId, readyRequest?.readyRequestId),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
    const handshake = handshakeCalls[handshakeCalls.length - 1]?.[2];
    expect(handshake).toEqual(expect.objectContaining({
      documentEpoch: 1,
      documentId: 'document-guide',
      popoutInstanceId: existingInstanceId,
    }));

    act(() => listeners.handshakeAck?.({ payload: handshake }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toEqual([
      [
        getPanePopoutLabel('editor'),
        MARKDOWN_MEDIA_INSERTION_EVENT,
        expect.objectContaining({
          documentEpoch: 1,
          documentId: 'document-guide',
          popoutInstanceId: existingInstanceId,
          requestId: 1,
        }),
      ],
    ]);
  });

  it('recovers a queued insertion from an already-open editor popout that missed its startup ready event', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    const existingInstanceId = 'markdown-media-popout:existing-open';
    appMocks.openPanePopout.mockResolvedValue({ status: 'existing', pane: 'editor' });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onPopout = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
    act(() => onPopout?.());
    await act(async () => {
      await Promise.resolve();
    });
    const readyRequest = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT)[0]?.[2] as
      | { documentEpoch: number; documentId: string; readyRequestId: string }
      | undefined;
    expect(readyRequest).toEqual(expect.objectContaining({
      documentEpoch: 1,
      documentId: 'document-guide',
      readyRequestId: expect.any(String),
    }));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));

    act(() => listeners.ready?.({
      payload: readyPayload('document-guide', 1, 'markdown-media-popout:stale'),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(0);

    act(() => listeners.ready?.({
      payload: readyPayload('document-guide', 1, existingInstanceId, readyRequest?.readyRequestId),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
    const handshake = handshakeCalls[handshakeCalls.length - 1]?.[2];
    expect(handshake).toEqual(expect.objectContaining({
      documentEpoch: 1,
      documentId: 'document-guide',
      popoutInstanceId: existingInstanceId,
    }));

    act(() => listeners.handshakeAck?.({ payload: handshake }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toEqual([
      [
        getPanePopoutLabel('editor'),
        MARKDOWN_MEDIA_INSERTION_EVENT,
        expect.objectContaining({
          documentEpoch: 1,
          documentId: 'document-guide',
          popoutInstanceId: existingInstanceId,
          requestId: 1,
        }),
      ],
    ]);
  });

  it('does not trust a delayed handshake acknowledgement after the editor popout reopens', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    act(() => listeners.ready?.({
      payload: readyPayload(),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
    const oldHandshake = handshakeCalls[handshakeCalls.length - 1]?.[2];
    expect(oldHandshake).toBeDefined();

    appMocks.editorPopoutButton = undefined;
    await act(async () => root.render(<App />));
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    await act(async () => root.render(<App />));

    act(() => listeners.handshakeAck?.({ payload: oldHandshake }));
    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(0);
  });

  it('ignores a disposed ready listener after the active document changes', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const readyListeners: MockEventListener[] = [];
    const handshakeAckListeners: MockEventListener[] = [];
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === MARKDOWN_MEDIA_INSERTION_READY_EVENT) readyListeners.push(listener);
      if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT) handshakeAckListeners.push(listener);
      return () => undefined;
    });
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));

    appMocks.useDocumentSession.mockReturnValue({
      ...session,
      documentEpoch: 2,
      documentId: 'document-next',
    });
    await act(async () => root.render(<App />));
    expect(readyListeners).toHaveLength(2);
    expect(handshakeAckListeners).toHaveLength(2);

    act(() => readyListeners[1]?.({
      payload: readyPayload('document-next', 2),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
    const currentHandshake = handshakeCalls[handshakeCalls.length - 1]?.[2];
    expect(currentHandshake).toEqual(expect.objectContaining({ documentId: 'document-next' }));

    act(() => readyListeners[0]?.({
      payload: readyPayload(),
    }));
    act(() => handshakeAckListeners[1]?.({ payload: currentHandshake }));
    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)[0]?.[2]).toEqual(
      expect.objectContaining({ documentEpoch: 2, documentId: 'document-next' }),
    );
  });

  it('drops queued deliveries after the active document changes', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    let releaseFirstDelivery: (() => void) | null = null;
    appMocks.emitTo.mockImplementation((_target, event) => {
      if (event !== MARKDOWN_MEDIA_INSERTION_EVENT || releaseFirstDelivery) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });
    });
    const session = createMarkdownSession();
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));
    await establishEditorPopoutHandshake(listeners);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);

    appMocks.useDocumentSession.mockReturnValue({
      ...session,
      activePath: '/workspace/docs/next.md',
      documentEpoch: 2,
      documentId: 'document-next',
    });
    await act(async () => root.render(<App />));
    await act(async () => {
      releaseFirstDelivery?.();
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
  });

  it('retries a failed editor popout delivery before continuing the queue', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    let failedFirstDelivery = false;
    appMocks.emitTo.mockImplementation((_target, event) => {
      if (event === MARKDOWN_MEDIA_INSERTION_EVENT && !failedFirstDelivery) {
        failedFirstDelivery = true;
        return Promise.reject(new Error('delivery failed'));
      }
      return Promise.resolve();
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    act(() => onInsertWorkspaceAsset?.({
      kind: 'excalidraw',
      name: 'diagram.excalidraw',
      path: '/workspace/diagrams/diagram.excalidraw',
      relative_path: 'diagrams/diagram.excalidraw',
    }, { kind: 'cursor' }));
    await establishEditorPopoutHandshake(listeners);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(3);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)[1]).toEqual([
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_EVENT,
      expect.objectContaining({
        popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
        requestId: 1,
      }),
    ]);
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)[2]).toEqual([
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_EVENT,
      expect.objectContaining({ requestId: 2 }),
    ]);
  });

  it('retries a transient editor popout handshake failure before flushing insertions', async () => {
    vi.useFakeTimers();
    try {
      const listeners = captureEditorPopoutHandshakeListeners();
      let failedHandshake = false;
      appMocks.emitTo.mockImplementation((_target, event) => {
        if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT && !failedHandshake) {
          failedHandshake = true;
          return Promise.reject(new Error('handshake delivery failed'));
        }
        return Promise.resolve();
      });
      appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
      await act(async () => root.render(<App />));
      const openEditor = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
      act(() => openEditor?.());
      appMocks.editorPopoutButton = {
        ariaLabel: 'Editor popout is open',
        isPoppedOut: true,
        statusLabel: 'Popped out',
        title: 'Editor popout is open',
      };
      await act(async () => root.render(<App />));

      const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
        | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
        | undefined;
      act(() => onInsertWorkspaceAsset?.({
        kind: 'html',
        name: 'demo.html',
        path: '/workspace/demos/demo.html',
        relative_path: 'demos/demo.html',
      }, { kind: 'cursor' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
      expect(handshakeCalls).toHaveLength(2);
      act(() => listeners.handshakeAck?.({ payload: handshakeCalls[1]?.[2] }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a queued insertion when READY arrives after the initial handshake retry budget', async () => {
    vi.useFakeTimers();
    try {
      const listeners = captureEditorPopoutHandshakeListeners();
      const session = createMarkdownSession();
      appMocks.useDocumentSession.mockReturnValue(session);
      await act(async () => root.render(<App />));
      const openEditor = appMocks.editorPane.mock.lastCall?.[0].onPopout as (() => void) | undefined;
      act(() => openEditor?.());
      const popoutInstanceId = appMocks.openPanePopout.mock.calls[0]?.[1];
      expect(popoutInstanceId).toEqual(expect.any(String));
      appMocks.editorPopoutButton = {
        ariaLabel: 'Editor popout is open',
        isPoppedOut: true,
        statusLabel: 'Popped out',
        title: 'Editor popout is open',
      };
      await act(async () => root.render(<App />));

      const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
        | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
        | undefined;
      const asset = {
        kind: 'excalidraw',
        name: 'diagram.excalidraw',
        path: '/workspace/diagrams/diagram.excalidraw',
        relative_path: 'diagrams/diagram.excalidraw',
      } as const;
      act(() => onInsertWorkspaceAsset?.(asset, { kind: 'cursor' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });

      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(3);
      expect(session.setError).toHaveBeenCalledWith(expect.any(String));
      act(() => listeners.ready?.({
        payload: readyPayload('document-guide', 1, popoutInstanceId as string),
      }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT)).toHaveLength(4);
      const handshakeCalls = emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT);
      act(() => listeners.handshakeAck?.({ payload: handshakeCalls[3]?.[2] }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toEqual([
        [
          getPanePopoutLabel('editor'),
          MARKDOWN_MEDIA_INSERTION_EVENT,
          expect.objectContaining({ requestId: 1 }),
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending delivery retries when the App unmounts', async () => {
    vi.useFakeTimers();
    try {
      appMocks.editorPopoutButton = {
        ariaLabel: 'Editor popout is open',
        isPoppedOut: true,
        statusLabel: 'Popped out',
        title: 'Editor popout is open',
      };
      const listeners = captureEditorPopoutHandshakeListeners();
      const session = createMarkdownSession();
      appMocks.emitTo.mockImplementation((_target, event) => (
        event === MARKDOWN_MEDIA_INSERTION_EVENT
          ? Promise.reject(new Error('delivery failed'))
          : Promise.resolve()
      ));
      appMocks.useDocumentSession.mockReturnValue(session);
      await act(async () => root.render(<App />));
      await establishEditorPopoutHandshake(listeners);

      const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
        | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
        | undefined;
      act(() => onInsertWorkspaceAsset?.({
        kind: 'html',
        name: 'demo.html',
        path: '/workspace/demos/demo.html',
        relative_path: 'demos/demo.html',
      }, { kind: 'cursor' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);

      await act(async () => root.unmount());
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toHaveLength(1);
      expect(session.setError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps editor popout delivery active after StrictMode effect replay', async () => {
    appMocks.editorPopoutButton = {
      ariaLabel: 'Editor popout is open',
      isPoppedOut: true,
      statusLabel: 'Popped out',
      title: 'Editor popout is open',
    };
    const listeners = captureEditorPopoutHandshakeListeners();
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    await establishEditorPopoutHandshake(listeners);

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind: 'html',
      name: 'demo.html',
      path: '/workspace/demos/demo.html',
      relative_path: 'demos/demo.html',
    }, { kind: 'cursor' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_EVENT)).toEqual([
      [
        getPanePopoutLabel('editor'),
        MARKDOWN_MEDIA_INSERTION_EVENT,
        expect.objectContaining({ requestId: 1 }),
      ],
    ]);
  });

  it.each([
    ['html', 'demo.html', 'demos/demo.html', '[demo.html](../demos/demo.html "mmd:embed")'],
    ['excalidraw', 'diagram.excalidraw', 'diagrams/diagram.excalidraw', '[diagram.excalidraw](../diagrams/diagram.excalidraw "mmd:embed")'],
  ] as const)('routes a context-menu %s insertion to the current cursor', async (kind, name, relativePath, markdown) => {
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
    await act(async () => root.render(<App />));

    const onInsertWorkspaceAsset = appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset as
      | ((asset: Record<string, unknown>, target: { kind: 'cursor' }) => void)
      | undefined;
    act(() => onInsertWorkspaceAsset?.({
      kind,
      name,
      path: `/workspace/${relativePath}`,
      relative_path: relativePath,
    }, { kind: 'cursor' }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toMatchObject({
      markdown,
      target: { kind: 'cursor' },
    });
  });

  it('rejects stale-instance events and delivers a matching cursor insertion to an editor popout', async () => {
    window.history.replaceState({}, '', `/?pane=editor&instance=${TEST_POPOUT_INSTANCE_ID}`);
    let mediaInsertionListener: ((event: { payload: unknown }) => void) | null = null;
    let mediaInsertionHandshakeListener: ((event: { payload: unknown }) => void) | null = null;
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === MARKDOWN_MEDIA_INSERTION_EVENT) mediaInsertionListener = listener;
      if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT) mediaInsertionHandshakeListener = listener;
      return () => undefined;
    });
    const popoutSession = createMarkdownSession();
    popoutSession.files = [];
    appMocks.useDocumentSession.mockReturnValue(popoutSession);

    await act(async () => root.render(<App />));

    expect(appMocks.emitTo).toHaveBeenCalledWith('main', MARKDOWN_MEDIA_INSERTION_READY_EVENT, {
      documentEpoch: 1,
      documentId: 'document-guide',
      popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
    });
    const handshake = {
      documentEpoch: 1,
      documentId: 'document-guide',
      handshakeId: 'markdown-media-handshake:test',
      popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
    };
    act(() => mediaInsertionHandshakeListener?.({
      payload: { ...handshake, popoutInstanceId: 'markdown-media-popout:old' },
    }));
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT)).toHaveLength(0);
    act(() => mediaInsertionHandshakeListener?.({ payload: handshake }));
    expect(appMocks.emitTo).toHaveBeenCalledWith(
      'main',
      MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
      handshake,
    );

    const insertionEvent = {
      asset: {
        kind: 'html',
        name: 'demo.html',
        relative_path: 'demos/demo.html',
      },
      documentRelativePath: 'docs/guide.md',
      documentEpoch: 1,
      documentId: 'document-guide',
      popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
      requestId: 1,
    };
    act(() => mediaInsertionListener?.({
      payload: { ...insertionEvent, popoutInstanceId: 'markdown-media-popout:old' },
    }));
    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toBeNull();
    act(() => mediaInsertionListener?.({
      payload: { ...insertionEvent, documentRelativePath: 'docs/other.md' },
    }));
    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toBeNull();
    act(() => mediaInsertionListener?.({ payload: insertionEvent }));

    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toEqual({
      documentEpoch: 1,
      documentId: 'document-guide',
      markdown: '[demo.html](../demos/demo.html "mmd:embed")',
      requestId: 1,
      target: { kind: 'cursor' },
    });
  });

  it('re-announces the editor popout identity when the main window requests it', async () => {
    window.history.replaceState({}, '', `/?pane=editor&instance=${TEST_POPOUT_INSTANCE_ID}`);
    let readyRequestListener: MockEventListener | null = null;
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT) readyRequestListener = listener;
      return () => undefined;
    });
    appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());

    await act(async () => root.render(<App />));
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_READY_EVENT)).toHaveLength(1);

    act(() => readyRequestListener?.({
      payload: { documentEpoch: 1, documentId: 'other-document', readyRequestId: 'ready-request:other' },
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_READY_EVENT)).toHaveLength(1);

    act(() => readyRequestListener?.({
      payload: { documentEpoch: 1, documentId: 'document-guide', readyRequestId: 'ready-request:test' },
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_READY_EVENT)).toEqual([
      [
        'main',
        MARKDOWN_MEDIA_INSERTION_READY_EVENT,
        {
          documentEpoch: 1,
          documentId: 'document-guide',
          popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
        },
      ],
      [
        'main',
        MARKDOWN_MEDIA_INSERTION_READY_EVENT,
        {
          documentEpoch: 1,
          documentId: 'document-guide',
          popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
          readyRequestId: 'ready-request:test',
        },
      ],
    ]);
  });

  it('retries an editor popout ready announcement after a transient failure', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', `/?pane=editor&instance=${TEST_POPOUT_INSTANCE_ID}`);
      let failedReady = false;
      appMocks.emitTo.mockImplementation((_target, event) => {
        if (event === MARKDOWN_MEDIA_INSERTION_READY_EVENT && !failedReady) {
          failedReady = true;
          return Promise.reject(new Error('ready delivery failed'));
        }
        return Promise.resolve();
      });
      appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
      await act(async () => root.render(<App />));
      await act(async () => {
        await Promise.resolve();
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_READY_EVENT)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_READY_EVENT)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an editor popout handshake acknowledgement after a transient failure', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', `/?pane=editor&instance=${TEST_POPOUT_INSTANCE_ID}`);
      let mediaInsertionHandshakeListener: MockEventListener | null = null;
      let failedAcknowledgement = false;
      appMocks.listen.mockImplementation(async (event, listener) => {
        if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT) {
          mediaInsertionHandshakeListener = listener;
        }
        return () => undefined;
      });
      appMocks.emitTo.mockImplementation((_target, event) => {
        if (event === MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT && !failedAcknowledgement) {
          failedAcknowledgement = true;
          return Promise.reject(new Error('acknowledgement delivery failed'));
        }
        return Promise.resolve();
      });
      appMocks.useDocumentSession.mockReturnValue(createMarkdownSession());
      await act(async () => root.render(<App />));

      const handshake = {
        documentEpoch: 1,
        documentId: 'document-guide',
        handshakeId: 'markdown-media-handshake:test-retry',
        popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
      };
      act(() => mediaInsertionHandshakeListener?.({ payload: handshake }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(emitToCallsFor(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores delayed and duplicate cursor events in an editor popout', async () => {
    window.history.replaceState({}, '', `/?pane=editor&instance=${TEST_POPOUT_INSTANCE_ID}`);
    let mediaInsertionListener: ((event: { payload: unknown }) => void) | null = null;
    appMocks.listen.mockImplementation(async (event, listener) => {
      if (event === MARKDOWN_MEDIA_INSERTION_EVENT) mediaInsertionListener = listener;
      return () => undefined;
    });
    const popoutSession = createMarkdownSession();
    popoutSession.files = [];
    appMocks.useDocumentSession.mockReturnValue(popoutSession);
    await act(async () => root.render(<App />));
    const initialEditorCalls = appMocks.editorPane.mock.calls.length;
    const event = (requestId: number) => ({
      asset: {
        kind: 'html',
        name: 'demo.html',
        relative_path: 'demos/demo.html',
      },
      documentRelativePath: 'docs/guide.md',
      documentEpoch: 1,
      documentId: 'document-guide',
      popoutInstanceId: TEST_POPOUT_INSTANCE_ID,
      requestId,
    });

    act(() => mediaInsertionListener?.({ payload: event(2) }));
    act(() => mediaInsertionListener?.({ payload: event(1) }));
    act(() => mediaInsertionListener?.({ payload: event(2) }));

    expect(appMocks.editorPane.mock.calls).toHaveLength(initialEditorCalls + 1);
    expect(appMocks.editorPane.mock.lastCall?.[0].mediaInsertion).toMatchObject({ requestId: 2 });
  });

  it('does not expose workspace media insertion for a read-only Markdown document', async () => {
    appMocks.useDocumentSession.mockReturnValue({
      ...createMarkdownSession(),
      authorityStatus: 'pending',
    });
    await act(async () => root.render(<App />));

    expect(appMocks.fileSidebar.mock.lastCall?.[0].onInsertWorkspaceAsset).toBeUndefined();
  });
});
