// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { DocxPreviewFeedback } from './components/DocxPreview';
import { APP_FEEDBACK_ERROR_EVENT } from './lib/appFeedback';

const appMocks = vi.hoisted(() => ({
  editorPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  docxPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
  excalidrawPane: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  jinxiuMarkdown: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  paneResizer: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  pdfPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  workspaceImagePreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  workspaceMediaPreview: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  previewModuleLoads: {
    docx: 0,
    excalidraw: 0,
    pdf: 0,
  },
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
  session: null as unknown as Record<string, unknown>,
  useDocumentSession: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
  useCrashDraftRecovery: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: appMocks.emitTo,
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
    openPanePopout: vi.fn<(pane: 'editor' | 'preview') => Promise<void>>(
      async () => undefined,
    ),
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
    settings: null,
    updateSettings: vi.fn<(settings: unknown) => Promise<void>>(async () => undefined),
  }),
}));
vi.mock('./components/EditorPane', () => ({ EditorPane: appMocks.editorPane }));
vi.mock('./components/DocxPreview', () => {
  appMocks.previewModuleLoads.docx += 1;
  return { DocxPreview: appMocks.docxPreview };
});
vi.mock('./components/ExcalidrawPane', () => {
  appMocks.previewModuleLoads.excalidraw += 1;
  return { ExcalidrawPane: appMocks.excalidrawPane };
});
vi.mock('./components/PaneResizer', () => ({ PaneResizer: appMocks.paneResizer }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: appMocks.jinxiuMarkdown }));
vi.mock('./components/PdfPreview', () => {
  appMocks.previewModuleLoads.pdf += 1;
  return { PdfPreview: appMocks.pdfPreview };
});
vi.mock('./components/WorkspaceImagePreview', () => ({
  WorkspaceImagePreview: (props: Record<string, unknown>) => appMocks.workspaceImagePreview(props),
}));
vi.mock('./components/WorkspaceMediaPreview', () => ({
  WorkspaceMediaPreview: (props: Record<string, unknown>) => appMocks.workspaceMediaPreview(props),
}));

type BinaryKind = 'docx' | 'pdf';
type PreviewAuthority = 'committed' | 'provisional' | 'unknown';

const BINARY_FIXTURES = {
  docx: {
    bytesBase64: 'UEsDBA==',
    documentId: 'document-docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    path: '/workspace/report.docx',
  },
  pdf: {
    bytesBase64: 'JVBERg==',
    documentId: 'document-pdf',
    mimeType: 'application/pdf',
    path: '/workspace/report.pdf',
  },
} as const;

function createBinarySession(kind: BinaryKind, authorityStatus: PreviewAuthority) {
  const fixture = BINARY_FIXTURES[kind];
  const setError = vi.fn<(message: string | null) => void>();
  const setNotice = vi.fn<(message: string | null) => void>();
  return {
    activeFileKind: kind,
    activeMimeType: fixture.mimeType,
    activePath: fixture.path,
    authorityStatus,
    broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined),
    busy: false,
    bytesBase64: fixture.bytesBase64,
    content: '',
    createFileInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    createFolderInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    dirty: false,
    documentEpoch: 7,
    documentId: fixture.documentId,
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

function createAssetSession(kind: 'image' | 'video') {
  return {
    ...createBinarySession('pdf', 'committed'),
    activeFileKind: kind,
    activeMimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    activePath: kind === 'image' ? '/workspace/cover.png' : '/workspace/clip.mp4',
    bytesBase64: null,
    documentId: `document-${kind}`,
    previewRevision: 23,
  };
}

function createTextSession(kind: 'html' | 'markdown', busy = false) {
  return {
    ...createBinarySession('pdf', 'committed'),
    activeFileKind: kind,
    activeMimeType: kind === 'html' ? 'text/html' : null,
    activePath: kind === 'html' ? '/workspace/report.html' : '/workspace/report.md',
    busy,
    bytesBase64: null,
    content: kind === 'html' ? '<h1>Report</h1>' : '# Report',
    documentId: `document-${kind}`,
  };
}

function createExcalidrawSession() {
  return {
    ...createTextSession('markdown'),
    activeFileKind: 'excalidraw',
    activeMimeType: null,
    activePath: '/workspace/architecture.excalidraw',
    content: '{"type":"excalidraw","version":2,"elements":[],"appState":{"currentItemFontFamily":5,"viewBackgroundColor":"transparent"},"files":{}}',
    documentId: 'document-architecture',
  };
}

function createDirtyFileSwitchSession() {
  const currentPath = '/workspace/report.md';
  const targetPath = '/workspace/notes.md';
  return {
    ...createTextSession('markdown'),
    activePath: currentPath,
    dirty: true,
    fileTree: [
      {
        absolutePath: currentPath,
        kind: 'file' as const,
        name: 'report.md',
        path: currentPath,
        relativePath: 'report.md',
        file: {
          kind: 'markdown' as const,
          name: 'report.md',
          path: currentPath,
          relative_path: 'report.md',
        },
      },
      {
        absolutePath: targetPath,
        kind: 'file' as const,
        name: 'notes.md',
        path: targetPath,
        relativePath: 'notes.md',
        file: {
          kind: 'markdown' as const,
          name: 'notes.md',
          path: targetPath,
          relative_path: 'notes.md',
        },
      },
    ],
    targetPath,
  };
}

function findDialogButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.unsaved-dialog button'))
    .find((button) => button.textContent === label);
}

const COMPOSITION_CASES = (['pdf', 'docx'] as const).flatMap((kind) =>
  (['committed', 'provisional', 'unknown'] as const).flatMap((authorityStatus) => [
    [kind, authorityStatus, '', '.workspace.document-mode > .preview-pane', false, 'main'],
    [kind, authorityStatus, '?pane=editor', '.popout-shell > .preview-pane.popout-pane', true, 'editor'],
    [kind, authorityStatus, '?pane=preview', '.popout-shell > .preview-pane.popout-pane', true, 'preview'],
  ] as const),
);

describe('App binary document composition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    appMocks.editorPane.mockClear();
    appMocks.docxPreview.mockClear();
    appMocks.emitTo.mockReset();
    appMocks.emitTo.mockResolvedValue(undefined);
    appMocks.excalidrawPane.mockClear();
    appMocks.jinxiuMarkdown.mockClear();
    appMocks.paneResizer.mockClear();
    appMocks.pdfPreview.mockClear();
    appMocks.workspaceImagePreview.mockClear();
    appMocks.workspaceMediaPreview.mockClear();
    appMocks.setNativeSaveMenuEnabled.mockReset();
    appMocks.setNativeSaveMenuEnabled.mockResolvedValue(undefined);
    appMocks.useDocumentSession.mockReset();
    appMocks.useCrashDraftRecovery.mockReset();
    appMocks.useCrashDraftRecovery.mockReturnValue({
      afterConfirmedSave: vi.fn<(documentId: string) => Promise<boolean>>(async () => true), busy: false, canRepairOverflow: false,
      catalog: null, discard: vi.fn<() => void>(), discardAll: vi.fn<() => void>(), error: null,
      overflowRepairProgress: null, repairOverflowBatch: vi.fn<() => void>(), recover: vi.fn<() => void>(), retry: vi.fn<() => void>(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('loads heavy preview modules only when their file type becomes active', async () => {
    const session = createTextSession('markdown');
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    expect(appMocks.previewModuleLoads).toEqual({ docx: 0, excalidraw: 0, pdf: 0 });

    Object.assign(session, createBinarySession('pdf', 'committed'));
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    expect(appMocks.previewModuleLoads).toEqual({ docx: 0, excalidraw: 0, pdf: 1 });
    expect(appMocks.pdfPreview).toHaveBeenCalledOnce();

    Object.assign(session, createBinarySession('docx', 'committed'));
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    expect(appMocks.previewModuleLoads).toEqual({ docx: 1, excalidraw: 0, pdf: 1 });
    expect(appMocks.docxPreview).toHaveBeenCalledOnce();

    Object.assign(session, createExcalidrawSession());
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    expect(appMocks.previewModuleLoads).toEqual({ docx: 1, excalidraw: 1, pdf: 1 });
    expect(appMocks.excalidrawPane).toHaveBeenCalledOnce();
  });

  it('does not scan crash recovery during main or popout startup', async () => {
    appMocks.useDocumentSession.mockReturnValue(createTextSession('markdown'));
    await act(async () => root.render(<App />));
    expect(appMocks.useCrashDraftRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    act(() => root.unmount());
    root = createRoot(container);
    window.history.replaceState({}, '', '/?pane=editor');
    await act(async () => root.render(<App />));
    expect(appMocks.useCrashDraftRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it.each(COMPOSITION_CASES)(
    'routes %s with %s authority at %s to one read-only full-width preview',
    async (kind, authorityStatus, search, previewSelector, isPopout, popoutPane) => {
      window.history.replaceState({}, '', `/${search}`);
      appMocks.session = createBinarySession(kind, authorityStatus);
      appMocks.useDocumentSession.mockReturnValue(appMocks.session);

      await act(async () => root.render(<App />));

      const expectedPreview = kind === 'pdf' ? appMocks.pdfPreview : appMocks.docxPreview;
      const unexpectedPreview = kind === 'pdf' ? appMocks.docxPreview : appMocks.pdfPreview;
      expect(expectedPreview).toHaveBeenCalledOnce();
      expect(unexpectedPreview).not.toHaveBeenCalled();
      expect(expectedPreview.mock.lastCall?.[0]).toMatchObject({
        bytesBase64: BINARY_FIXTURES[kind].bytesBase64,
        documentEpoch: 7,
        documentId: BINARY_FIXTURES[kind].documentId,
        enabled: authorityStatus === 'committed',
      });
      expect(appMocks.editorPane).not.toHaveBeenCalled();
      expect(appMocks.paneResizer).not.toHaveBeenCalled();
      expect(appMocks.jinxiuMarkdown).not.toHaveBeenCalled();
      expect(container.querySelectorAll('.preview-pane')).toHaveLength(1);
      expect(container.querySelector(previewSelector)).not.toBeNull();
      expect(appMocks.useDocumentSession).toHaveBeenCalledWith({
        afterConfirmedSave: expect.any(Function), autosaveDelayMs: 1500, autosaveEnabled: false, isPopout, popoutPane,
      });
      expect(appMocks.setNativeSaveMenuEnabled.mock.calls).toEqual(isPopout ? [] : [[false]]);
    },
  );

  it.each([
    ['', false, 'main', true],
    ['?pane=editor', true, 'editor', true],
    ['?pane=preview', true, 'preview', false],
  ] as const)(
    'routes an Excalidraw scene at %s to a single %s canvas',
    async (search, isPopout, popoutPane, editable) => {
      window.history.replaceState({}, '', `/${search}`);
      const session = createExcalidrawSession();
      appMocks.useDocumentSession.mockReturnValue(session);

      await act(async () => root.render(<App />));

      expect(appMocks.excalidrawPane).toHaveBeenCalledOnce();
      expect(appMocks.excalidrawPane.mock.lastCall?.[0]).toMatchObject({
        activePath: '/workspace/architecture.excalidraw',
        content: session.content,
        documentEpoch: 7,
        documentId: 'document-architecture',
        editable,
      });
      expect(appMocks.excalidrawPane.mock.lastCall?.[0].popout).toBe(isPopout ? true : undefined);
      expect(appMocks.editorPane).not.toHaveBeenCalled();
      expect(appMocks.jinxiuMarkdown).not.toHaveBeenCalled();
      expect(appMocks.paneResizer).not.toHaveBeenCalled();
      expect(appMocks.useDocumentSession).toHaveBeenCalledWith({
        afterConfirmedSave: expect.any(Function), autosaveDelayMs: 1500, autosaveEnabled: false, isPopout, popoutPane,
      });
      expect(appMocks.setNativeSaveMenuEnabled.mock.calls).toEqual(isPopout ? [] : [[true]]);
    },
  );

  it('syncs Save and Save As availability from the current editable main-window session', async () => {
    const session = createTextSession('markdown');
    appMocks.session = session;
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenLastCalledWith(true);

    session.busy = true;
    await act(async () => root.render(<App />));
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenLastCalledWith(false);
  });

  it('renders the branching save-conflict modal and routes its actions', async () => {
    const session = createTextSession('markdown');
    session.saveConflict = { busy: false, path: '/workspace/report.md' };
    appMocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.document-save-conflict-dialog button'));
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click());
    act(() => buttons.find((button) => button.textContent === 'Overwrite')?.click());
    expect(session.handleCancelSaveConflict).toHaveBeenCalledOnce();
    expect(session.handleOverwriteSaveConflict).toHaveBeenCalledOnce();
  });

  it('keeps startup recovery catalogs silent and executes one explicit repair batch per click', async () => {
    const session = createTextSession('markdown');
    appMocks.useDocumentSession.mockReturnValue(session);
    const recover = vi.fn<() => void>();
    appMocks.useCrashDraftRecovery.mockReturnValue({
      afterConfirmedSave: vi.fn<(documentId: string) => Promise<boolean>>(async () => true), busy: false, canRepairOverflow: false,
      catalog: {
        schemaVersion: 1, catalogToken: 'a'.repeat(64), totalBytes: 10,
        limits: { maxDraftBytes: 100, maxDrafts: 10, maxStoreBytes: 1000 },
        entries: [{
          status: 'recoverable', documentId: '1'.repeat(32), draftRevision: 1,
          updatedAtUnixMs: 1, contentBytes: 10, pathHint: null, baseVersionToken: null,
          fileKind: 'markdown', entryToken: 'b'.repeat(64),
        }],
      },
      discard: vi.fn<() => void>(), discardAll: vi.fn<() => void>(), error: null, overflowRepairProgress: null,
      repairOverflowBatch: vi.fn<() => void>(), recover, retry: vi.fn<() => void>(),
    });
    await act(async () => root.render(<App />));
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent === 'Recover')).toBe(false);
    expect(recover).not.toHaveBeenCalled();

    const repairOverflowBatch = vi.fn<() => void>();
    appMocks.useCrashDraftRecovery.mockReturnValue({
      afterConfirmedSave: vi.fn<(documentId: string) => Promise<boolean>>(async () => true), busy: false, canRepairOverflow: true,
      catalog: null, discard: vi.fn<() => void>(), discardAll: vi.fn<() => void>(),
      error: { code: 'storeFull', message: 'Storage full.', canReset: false },
      overflowRepairProgress: null, repairOverflowBatch, recover: vi.fn<() => void>(), retry: vi.fn<() => void>(),
    });
    await act(async () => root.render(<App />));
    act(() => [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Repair Draft Storage'))?.click());
    expect(repairOverflowBatch).toHaveBeenCalledOnce();
  });

  it('asks before opening another workspace file when the current document is dirty', async () => {
    const session = createDirtyFileSwitchSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    const targetRow = container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    );
    act(() => targetRow?.click());

    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Unsaved Changes');
    expect(dialog?.textContent).toContain('report.md');
    expect(dialog?.textContent).toContain('notes.md');
    expect(dialog?.textContent).toContain('Save and Switch');
    expect(dialog?.textContent).toContain('Cancel');
    expect(dialog?.textContent).toContain('Switch Without Saving');
  });

  it('keeps the dirty document open when file switching is cancelled', async () => {
    const session = createDirtyFileSwitchSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    )?.click());
    act(() => findDialogButton(container, 'Cancel')?.click());

    expect(session.saveCurrentDocument).not.toHaveBeenCalled();
    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
    expect(container.querySelector('.unsaved-dialog')).toBeNull();
  });

  it('opens the requested file without saving when discard is confirmed', async () => {
    const session = createDirtyFileSwitchSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    )?.click());
    act(() => findDialogButton(container, 'Switch Without Saving')?.click());

    expect(session.saveCurrentDocument).not.toHaveBeenCalled();
    expect(session.openWorkspaceFilePath).toHaveBeenCalledOnce();
    expect(session.openWorkspaceFilePath).toHaveBeenCalledWith(session.targetPath);
  });

  it('saves the current document before opening the requested file', async () => {
    const session = createDirtyFileSwitchSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    )?.click());
    await act(async () => {
      findDialogButton(container, 'Save and Switch')?.click();
      await Promise.resolve();
    });

    expect(session.saveCurrentDocument).toHaveBeenCalledOnce();
    expect(session.openWorkspaceFilePath).toHaveBeenCalledOnce();
    expect(session.openWorkspaceFilePath).toHaveBeenCalledWith(session.targetPath);
  });

  it('keeps the switch prompt open when saving does not complete', async () => {
    const session = createDirtyFileSwitchSession();
    session.saveCurrentDocument.mockResolvedValue(false);
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    )?.click());
    await act(async () => {
      findDialogButton(container, '保存并切换')?.click();
      await Promise.resolve();
    });

    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
    expect(container.querySelector('.unsaved-dialog')).not.toBeNull();
  });

  it('opens another file directly when the current document is clean', async () => {
    const session = createDirtyFileSwitchSession();
    session.dirty = false;
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.targetPath}"]`,
    )?.click());

    expect(container.querySelector('.unsaved-dialog')).toBeNull();
    expect(session.openWorkspaceFilePath).toHaveBeenCalledWith(session.targetPath);
  });

  it('does not reload the active file when its row is clicked', async () => {
    const session = createDirtyFileSwitchSession();
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLElement>(
      `[data-tree-entry-path="${session.activePath}"]`,
    )?.click());

    expect(container.querySelector('.unsaved-dialog')).toBeNull();
    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
  });

  it.each([
    ['image', '', false, 'main'],
    ['image', '?pane=preview', true, 'preview'],
    ['video', '', false, 'main'],
    ['video', '?pane=preview', true, 'preview'],
  ] as const)(
    'passes the replicated preview revision to %s in %s',
    async (kind, search, isPopout, popoutPane) => {
      window.history.replaceState({}, '', `/${search}`);
      const session = createAssetSession(kind);
      appMocks.useDocumentSession.mockReturnValue(session);

      await act(async () => root.render(<App />));

      const preview = kind === 'image'
        ? appMocks.workspaceImagePreview
        : appMocks.workspaceMediaPreview;
      expect(preview).toHaveBeenCalledOnce();
      const props = preview.mock.lastCall?.[0];
      expect(props).toMatchObject({
        path: session.activePath,
        previewRevision: 23,
      });
      expect(props?.popout).toBe(isPopout ? true : undefined);
      expect(appMocks.useDocumentSession).toHaveBeenCalledWith({
        afterConfirmedSave: expect.any(Function), autosaveDelayMs: 1500, autosaveEnabled: false, isPopout, popoutPane,
      });
    },
  );

  it('serializes menu updates and routes the latest synchronization failure to modal feedback', async () => {
    let resolveFirst!: () => void;
    const firstUpdate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    appMocks.setNativeSaveMenuEnabled
      .mockReturnValueOnce(firstUpdate)
      .mockRejectedValueOnce(new Error('invoke failed'));
    const session = createTextSession('html');
    appMocks.session = session;
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenCalledOnce();
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenLastCalledWith(true);

    session.busy = true;
    await act(async () => root.render(<App />));
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenCalledOnce();

    await act(async () => resolveFirst());
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenCalledTimes(2);
    expect(appMocks.setNativeSaveMenuEnabled).toHaveBeenLastCalledWith(false);
    expect(session.setError).toHaveBeenLastCalledWith('Communication with the application window failed. Please try again.');
    expect(session.setNotice).toHaveBeenLastCalledWith(null);
  });

  it('keeps one feedback callback across binary kinds and routes feedback through the shared dialog owners', async () => {
    const session = createBinarySession('pdf', 'committed');
    appMocks.session = session;
    appMocks.useDocumentSession.mockReturnValue(session);
    window.history.replaceState({}, '', '/');

    await act(async () => root.render(<App />));
    const firstFeedback = appMocks.pdfPreview.mock.lastCall?.[0].onFeedback as (
      feedback: DocxPreviewFeedback,
    ) => void;

    session.activeFileKind = 'docx';
    session.activeMimeType = BINARY_FIXTURES.docx.mimeType;
    session.activePath = BINARY_FIXTURES.docx.path;
    session.bytesBase64 = BINARY_FIXTURES.docx.bytesBase64;
    session.documentId = BINARY_FIXTURES.docx.documentId;
    await act(async () => root.render(<App />));
    const secondFeedback = appMocks.docxPreview.mock.lastCall?.[0].onFeedback;
    expect(secondFeedback).toBe(firstFeedback);

    act(() => firstFeedback({ kind: 'error', message: 'PDF failed' }));
    expect(session.setError).toHaveBeenLastCalledWith('PDF failed');
    expect(session.setNotice).toHaveBeenLastCalledWith(null);

    act(() => firstFeedback({ kind: 'notice', message: 'PDF degraded' }));
    expect(session.setNotice).toHaveBeenLastCalledWith('PDF degraded');
    expect(session.setError).toHaveBeenLastCalledWith(null);
  });

  it('routes lazy preview module failures into the shared modal feedback owner', async () => {
    const session = createBinarySession('pdf', 'committed');
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));
    act(() => window.dispatchEvent(new CustomEvent(APP_FEEDBACK_ERROR_EVENT, {
      detail: 'The operation could not be completed. Please try again.',
    })));

    expect(session.setError).toHaveBeenLastCalledWith(
      'The operation could not be completed. Please try again.',
    );
    expect(session.setNotice).toHaveBeenLastCalledWith(null);
  });

  it('routes inline rename and the move sheet through the workspace session', async () => {
    const session = {
      ...createTextSession('markdown'),
      activePath: '/workspace/notes/report.md',
      fileTree: [
        {
          absolutePath: '/workspace/archive',
          kind: 'folder' as const,
          name: 'archive',
          path: 'archive',
          children: [],
        },
        {
          absolutePath: '/workspace/notes',
          kind: 'folder' as const,
          name: 'notes',
          path: 'notes',
          children: [{
            absolutePath: '/workspace/notes/report.md',
            kind: 'file' as const,
            name: 'report.md',
            path: '/workspace/notes/report.md',
            relativePath: 'notes/report.md',
            file: {
              kind: 'markdown' as const,
              name: 'report.md',
              path: '/workspace/notes/report.md',
              relative_path: 'notes/report.md',
            },
          }],
        },
      ],
    };
    appMocks.useDocumentSession.mockReturnValue(session);

    await act(async () => root.render(<App />));

    const activeRow = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/notes/report.md"]');
    act(() => activeRow?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
    const renameInput = container.querySelector<HTMLInputElement>('.tree-inline-rename');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(renameInput, 'renamed.md');
      renameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      renameInput?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(session.renameWorkspaceEntryPath).toHaveBeenCalledWith(
      '/workspace/notes/report.md',
      'renamed.md',
    );

    const moreButton = container.querySelector<HTMLButtonElement>('[aria-label="More actions for report.md"]');
    act(() => moreButton?.click());
    const moveMenuItem = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.file-tree-context-menu [role="menuitem"]'),
    )
      .find((button) => button.textContent?.includes('Move'));
    act(() => moveMenuItem?.click());

    expect(container.querySelector('#workspace-move-dialog-title')?.textContent).toContain('report.md');
    const moveButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.workspace-move-dialog button'))
      .find((button) => button.textContent === 'Move');
    act(() => moveButton?.click());
    expect(session.moveWorkspaceEntryPath).toHaveBeenCalledWith(
      '/workspace/notes/report.md',
      '/workspace',
    );
  });
});
