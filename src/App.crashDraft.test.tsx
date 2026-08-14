// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const mocks = vi.hoisted(() => ({
  closeGuardInput: null as null | {
    flushWorkspaceSession: () => Promise<void>;
    setShowUnsavedExitPrompt: (show: boolean) => void;
  },
  discard: vi.fn<(documentId: string, token: string) => Promise<unknown>>(),
  list: vi.fn<() => Promise<unknown>>(),
  recover: vi.fn<(documentId: string, token: string) => Promise<unknown>>(),
  reset: vi.fn<(token: string) => Promise<unknown>>(),
  resetOverflowBatch: vi.fn<(receipt: string) => Promise<unknown>>(),
  forceCloseProgram: vi.fn<() => Promise<void>>(),
  session: null as unknown as Record<string, unknown>,
  useDocumentSession: vi.fn<() => Record<string, unknown>>(),
  write: vi.fn<(request: unknown) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn<() => Promise<void>>(async () => undefined),
  emitTo: vi.fn<() => Promise<void>>(async () => undefined),
  listen: vi.fn<() => Promise<() => void>>(async () => () => undefined),
}));
vi.mock('./hooks/useDocumentSession', () => ({ useDocumentSession: mocks.useDocumentSession }));
vi.mock('./lib/crashDraftCommands', () => ({
  crashDraftCommands: {
    discard: mocks.discard, list: mocks.list, recover: mocks.recover,
    reset: mocks.reset, resetOverflowBatch: mocks.resetOverflowBatch, write: mocks.write,
  },
}));
vi.mock('./lib/tauriCommands', () => ({
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(async () => undefined),
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
vi.mock('./hooks/usePanePopouts', () => ({
  usePanePopouts: () => ({
    closePopoutWindows: vi.fn<() => Promise<void>>(async () => undefined),
    editorPopoutButton: undefined,
    previewPopoutButton: undefined,
    openPanePopout: vi.fn<(pane: 'editor' | 'preview') => Promise<void>>(async () => undefined),
  }),
}));
vi.mock('./hooks/usePaneResize', () => ({
  usePaneResize: () => ({
    editorPaneRef: { current: null },
    previewPaneRef: { current: null },
    movePaneResize: vi.fn<() => void>(),
    resizePaneWithKeyboard: vi.fn<() => void>(),
    startPaneResize: vi.fn<() => void>(),
    stopPaneResize: vi.fn<() => void>(),
  }),
}));
vi.mock('./hooks/useProgramCloseGuard', () => ({
  useProgramCloseGuard: (input: {
    flushWorkspaceSession: () => Promise<void>;
    setShowUnsavedExitPrompt: (show: boolean) => void;
  }) => {
    mocks.closeGuardInput = input;
    return { forceCloseProgram: mocks.forceCloseProgram };
  },
}));
vi.mock('./components/EditorPane', () => ({ EditorPane: () => null }));
vi.mock('./components/FileSidebar', () => ({ FileSidebar: () => null }));
vi.mock('./components/AppToolbar', () => ({ AppToolbar: () => null }));
vi.mock('./components/PaneResizer', () => ({ PaneResizer: () => null }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: () => null }));

const documentId = '1'.repeat(32);
const entryToken = 'b'.repeat(64);
const catalogToken = 'a'.repeat(64);
const catalog = {
  schemaVersion: 1,
  catalogToken,
  totalBytes: 10,
  limits: { maxDraftBytes: 100, maxDrafts: 10, maxStoreBytes: 1000 },
  entries: [{
    status: 'recoverable', documentId, draftRevision: 1, updatedAtUnixMs: 1,
    contentBytes: 10, pathHint: '/private/original.md', baseVersionToken: 'c'.repeat(64),
    fileKind: 'markdown', entryToken,
  }],
};
const recovered = {
  documentId, draftRevision: 1, fileKind: 'markdown', pathHint: '/private/original.md',
  baseVersionToken: 'c'.repeat(64), content: '# Recovered', updatedAtUnixMs: 1, entryToken,
};

function createSession(events: string[] = []) {
  return {
    activeFileKind: 'markdown', activeMimeType: null, activePath: null as string | null, authorityStatus: 'committed',
    broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined), busy: false, bytesBase64: null, content: '', dirty: false,
    createFileInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    createFolderInWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    documentEpoch: 0, documentId: 'pane-document', error: null, externalFileAction: null, files: [], fileTree: [],
    flushCrashDraft: vi.fn<() => Promise<void>>(async () => { events.push('crash'); }),
    flushWorkspaceSession: vi.fn<() => Promise<void>>(async () => { events.push('workspace'); }),
    handleCancelSaveConflict: vi.fn<() => void>(), handleClearRecent: vi.fn<() => Promise<void>>(async () => undefined),
    handleCloseDeletedDraft: vi.fn<() => void>(), handleKeepCurrentExternal: vi.fn<() => void>(),
    handleNew: vi.fn<() => void>(), handleOpenDirectory: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenFile: vi.fn<() => Promise<void>>(async () => undefined),
    handleOpenRecent: vi.fn<(entryId: string) => Promise<void>>(async () => undefined),
    handleOverwriteSaveConflict: vi.fn<() => Promise<void>>(async () => undefined),
    handleSave: vi.fn<() => Promise<void>>(async () => undefined),
    handleSaveAs: vi.fn<() => Promise<void>>(async () => undefined),
    handleSaveDeletedDraftAs: vi.fn<() => Promise<void>>(async () => undefined),
    handleUseExternal: vi.fn<() => void>(), moveWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined), notice: null,
    openWorkspaceFilePath: vi.fn<(path: string) => Promise<void>>(async () => undefined), previewRevision: 0,
    recoverCrashDraft: vi.fn<(draft: unknown) => Promise<void>>(async () => undefined),
    refreshWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
    renameWorkspaceEntryPath: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    saveConflict: null, saveCurrentDocument: vi.fn<() => Promise<boolean>>(async () => true),
    seedCrashDraftRevision: vi.fn<(documentId: string, revision: number) => void>(),
    getCrashDraftStoredEntryToken: vi.fn<(documentId: string) => string | null>(() => null),
    confirmCrashDraftDiscarded: vi.fn<(documentId: string) => void>(),
    setError: vi.fn<(message: string | null) => void>(), setNotice: vi.fn<(message: string | null) => void>(),
    updateContent: vi.fn<(content: string) => void>(), workspaceRoot: null,
  };
}

describe('App crash draft lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    window.history.replaceState({}, '', '/');
    mocks.closeGuardInput = null;
    mocks.list.mockReset().mockResolvedValue(catalog);
    mocks.recover.mockReset().mockResolvedValue(recovered);
    mocks.discard.mockReset().mockResolvedValue({ status: 'confirmedDiscarded' });
    mocks.reset.mockReset().mockResolvedValue({ status: 'confirmedReset' });
    mocks.resetOverflowBatch.mockReset();
    mocks.forceCloseProgram.mockReset().mockResolvedValue(undefined);
    mocks.useDocumentSession.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not inspect or offer crash drafts during main or popout startup', async () => {
    const session = createSession();
    mocks.useDocumentSession.mockReturnValue(session);
    await act(async () => root.render(<App />));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Recover Unsaved Work');
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(session.recoverCrashDraft).not.toHaveBeenCalled();
    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
    expect(session.handleOpenFile).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.list.mockClear();
    window.history.replaceState({}, '', '/?pane=editor');
    await act(async () => root.render(<App />));
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('combines crash and workspace flushes for program close', async () => {
    const events: string[] = [];
    mocks.useDocumentSession.mockReturnValue(createSession(events));
    mocks.list.mockResolvedValue({ ...catalog, entries: [], totalBytes: 0 });
    await act(async () => root.render(<App />));
    await act(async () => mocks.closeGuardInput?.flushWorkspaceSession());
    expect(events).toEqual(['crash', 'workspace']);
  });

  it('keeps Save and Quit open when the current save leaves newer edits dirty', async () => {
    const session = createSession();
    session.dirty = true;
    session.activePath = '/workspace/notes.md';
    session.saveCurrentDocument.mockResolvedValue(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.list.mockResolvedValue({ ...catalog, entries: [], totalBytes: 0 });
    await act(async () => root.render(<App />));

    act(() => mocks.closeGuardInput?.setShowUnsavedExitPrompt(true));
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.classList.contains('secondary'))?.click();
      await Promise.resolve();
    });

    expect(session.saveCurrentDocument).toHaveBeenCalledOnce();
    expect(mocks.forceCloseProgram).not.toHaveBeenCalled();
    expect(container.querySelector('.unsaved-dialog')).not.toBeNull();
  });

  it('keeps persisted crash drafts silent after an unclean remount', async () => {
    mocks.useDocumentSession.mockReturnValue(createSession());
    await act(async () => root.render(<App />));
    expect(container.textContent).not.toContain('Recover Unsaved Work');
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Recover Unsaved Work');
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('does not surface crash-store repair during startup', async () => {
    mocks.useDocumentSession.mockReturnValue(createSession());
    mocks.list.mockRejectedValue({ code: 'storeFull', repairReceipt: 'd'.repeat(64) });
    mocks.resetOverflowBatch.mockResolvedValue({ removedEntries: 1, blockedEntries: 0, moreWorkRemaining: false });
    await act(async () => root.render(<App />));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.resetOverflowBatch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Repair Draft Storage');
  });
});
