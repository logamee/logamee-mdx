// @vitest-environment jsdom
// oxlint-disable vitest/require-mock-type-parameters -- Incidental UI stubs are not assertion surfaces in this wiring test.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, {
  syncOpenIntentCoordinatorModalState,
  updatePackagedSettlementBarrier,
} from './App';
import { NATIVE_MENU_EVENT } from './lib/nativeMenu';
import { OPEN_INTENT_FOCUS_EVENT, OPEN_INTENT_PENDING_EVENT } from './lib/openIntent';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

const mocks = vi.hoisted(() => ({
  discardOpenIntent: vi.fn<(id: string) => Promise<boolean>>(),
  focusMainWindow: vi.fn<(intentId?: string, coalesced?: boolean) => Promise<void>>(),
  getPackagedOpenE2eConfig: vi.fn<() => Promise<unknown>>(),
  fileSwitchCancelHandler: null as null | (() => void),
  fileSwitchQuitHandler: null as null | (() => void),
  listen: vi.fn<(event: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  crashOnRecoverDraft: null as null | ((draft: unknown) => Promise<void> | void),
  peekOpenIntent: vi.fn<() => Promise<unknown>>(),
  requestSessionRestore: vi.fn<() => Promise<void>>(),
  resolveOpenIntentRequest: vi.fn<(
    id: string,
    targetKind: string,
    discardCurrentCrashDraft?: boolean,
  ) => Promise<'blocked' | 'accepted' | 'failed'>>(),
  recordPackagedOpenAppEvent: vi.fn<(event: unknown) => Promise<void>>(),
  session: null as unknown as Record<string, unknown>,
  useDocumentSession: vi.fn<() => Record<string, unknown>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn<() => Promise<void>>(async () => undefined),
  emitTo: vi.fn<() => Promise<void>>(async () => undefined),
  listen: mocks.listen,
}));
vi.mock('./hooks/useDocumentSession', () => ({ useDocumentSession: mocks.useDocumentSession }));
vi.mock('./lib/tauriCommands', () => ({
  discardOpenIntent: mocks.discardOpenIntent,
  focusMainWindow: mocks.focusMainWindow,
  getPackagedOpenE2eConfig: mocks.getPackagedOpenE2eConfig,
  peekOpenIntent: mocks.peekOpenIntent,
  requestSessionRestore: mocks.requestSessionRestore,
  recordPackagedOpenAppEvent: mocks.recordPackagedOpenAppEvent,
  setNativeSaveMenuEnabled: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./hooks/useCrashDraftRecovery', () => ({
  useCrashDraftRecovery: ({ onRecoverDraft }: { onRecoverDraft: (draft: unknown) => Promise<void> | void }) => {
    mocks.crashOnRecoverDraft = onRecoverDraft;
    return ({
    busy: false,
    canRepairOverflow: false,
    catalog: null,
    confirmDiscarded: vi.fn(),
    discard: vi.fn(),
    discardAll: vi.fn(),
    error: null,
    recover: vi.fn(),
    repairOverflowBatch: vi.fn(),
    retry: vi.fn(),
    afterConfirmedSave: vi.fn(async () => true),
    });
  },
}));
vi.mock('./hooks/useSettings', () => ({
  useSettings: () => ({
    busy: false,
    recovery: null,
    reset: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    settings: { autosaveDelayMs: 1500, autosaveEnabled: false, editorPaneRatio: 0.5, spellcheckEnabled: true },
    updateSettings: vi.fn(async () => undefined),
  }),
}));
vi.mock('./hooks/usePanePopouts', () => ({
  usePanePopouts: () => ({
    closePopoutWindows: vi.fn(async () => undefined),
    editorPopoutButton: undefined,
    openPanePopout: vi.fn(async () => ({ status: 'opened' })),
    previewPopoutButton: undefined,
  }),
}));
vi.mock('./hooks/usePaneResize', () => ({
  usePaneResize: () => ({
    editorPaneRef: { current: null },
    movePaneResize: vi.fn(),
    previewPaneRef: { current: null },
    resizePaneWithKeyboard: vi.fn(),
    startPaneResize: vi.fn(),
    stopPaneResize: vi.fn(),
  }),
}));
vi.mock('./hooks/useWorkspaceSidebarResize', () => ({
  useWorkspaceSidebarResize: () => ({
    moveWorkspaceSidebarResize: vi.fn(),
    resizeWorkspaceSidebarWithKeyboard: vi.fn(),
    startWorkspaceSidebarResize: vi.fn(),
    stopWorkspaceSidebarResize: vi.fn(),
  }),
}));
vi.mock('./hooks/useProgramCloseGuard', () => ({
  useProgramCloseGuard: () => ({ forceCloseProgram: vi.fn(async () => undefined) }),
}));

vi.mock('./components/AppToolbar', () => ({
  AppToolbar: ({ onQuickOpen }: { onQuickOpen: () => void }) => (
    <button type="button" data-testid="quick-open" onClick={onQuickOpen}>Quick Open</button>
  ),
}));
vi.mock('./components/EditorPane', () => ({
  EditorPane: ({ spellcheckEnabled }: { spellcheckEnabled: boolean }) => (
    <section className="editor-pane">
      <div className="editor-host">
        <div className="cm-content" spellCheck={spellcheckEnabled} />
      </div>
    </section>
  ),
}));
vi.mock('./components/FileSidebar', () => ({
  FileSidebar: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => (
    <button type="button" data-testid="sidebar-file" onClick={() => onOpenFile('/workspace/sidebar.md')}>Sidebar file</button>
  ),
}));
vi.mock('./components/PaneResizer', () => ({ PaneResizer: () => null }));
vi.mock('./components/PreviewPane', () => ({ PreviewPane: ({ children }: { children?: unknown }) => children ?? null }));
vi.mock('./components/JinxiuMarkdown', () => ({ default: () => null }));
vi.mock('./components/WorkspaceSidebarResizer', () => ({ WorkspaceSidebarResizer: () => null }));
vi.mock('./components/WorkspaceImagePreview', () => ({ WorkspaceImagePreview: () => null }));
vi.mock('./components/WorkspaceHtmlPreview', () => ({ WorkspaceHtmlPreview: () => null }));
vi.mock('./components/WorkspaceMediaPreview', () => ({ WorkspaceMediaPreview: () => null }));
vi.mock('./components/WorkspaceEntryDialog', () => ({ WorkspaceEntryDialog: () => null }));
vi.mock('./components/WorkspaceMoveDialog', () => ({ WorkspaceMoveDialog: () => null }));
vi.mock('./components/ExternalFileChangeDialog', () => ({ ExternalFileChangeDialog: () => null }));
vi.mock('./components/DocumentSaveConflictDialog', () => ({ DocumentSaveConflictDialog: () => null }));
vi.mock('./components/CrashDraftRecoveryDialog', () => ({ CrashDraftRecoveryDialog: () => null }));
vi.mock('./components/CrashDraftStoreRepairDialog', () => ({ CrashDraftStoreRepairDialog: () => null }));
vi.mock('./components/FeedbackDialog', () => ({ FeedbackDialog: () => null }));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('./components/UnsavedExitDialog', () => ({
  UnsavedExitDialog: ({ prompt, onCancelExit, onQuitWithoutSaving, onSaveAndQuit }: {
    prompt: { cancelLabel: string; quitLabel: string; saveLabel: string };
    onCancelExit: () => void;
    onQuitWithoutSaving: () => void;
    onSaveAndQuit: () => void;
  }) => {
    mocks.fileSwitchCancelHandler = onCancelExit;
    mocks.fileSwitchQuitHandler = onQuitWithoutSaving;
    return (
      <div className="unsaved-dialog">
        <button type="button" onClick={onSaveAndQuit}>{prompt.saveLabel}</button>
        <button type="button" onClick={onCancelExit}>{prompt.cancelLabel}</button>
        <button type="button" onClick={onQuitWithoutSaving}>{prompt.quitLabel}</button>
      </div>
    );
  },
}));
vi.mock('./components/PopoutPaneShell', () => ({ PopoutPaneShell: ({ children }: { children?: unknown }) => children ?? null }));
vi.mock('./components/LazyPreviewBoundary', () => ({ LazyPreviewBoundary: ({ children }: { children?: unknown }) => children ?? null }));
vi.mock('./components/DocxPreview', () => ({ DocxPreview: () => null }));
vi.mock('./components/ExcalidrawPane', () => ({ ExcalidrawPane: () => null }));
vi.mock('./components/PdfPreview', () => ({ PdfPreview: () => null }));
vi.mock('./components/QuickOpenDialog', () => ({
  QuickOpenDialog: ({ onSelect }: {
    onSelect: (selection: {
      workspaceToken: string;
      workspaceRoot: string;
      indexGeneration: number;
      relativePath: string;
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="quick-open-result"
      onClick={() => onSelect({
        workspaceToken: 'workspace-7',
        workspaceRoot: '/workspace',
        indexGeneration: 3,
        relativePath: 'notes/search-result.md',
      })}
    >
      Search result
    </button>
  ),
}));

function createSession(dirty = false) {
  return {
    activeFileKind: 'markdown', activeMimeType: null, activePath: '/workspace/current.md', authorityStatus: 'committed',
    broadcastPaneState: vi.fn(async () => undefined), busy: false, bytesBase64: null, content: '# Current', dirty,
    createFileInWorkspace: vi.fn(async () => undefined), createFolderInWorkspace: vi.fn(async () => undefined),
    deleteWorkspaceEntryPath: vi.fn(async () => undefined), documentEpoch: 1, documentId: 'document-current', error: null,
    externalFileAction: null, files: [], fileTree: [], flushCrashDraft: vi.fn(async () => undefined),
    flushWorkspaceSession: vi.fn(async () => undefined), handleCancelSaveConflict: vi.fn(), handleClearRecent: vi.fn(async () => undefined),
    handleCloseDeletedDraft: vi.fn(async () => undefined), handleKeepCurrentExternal: vi.fn(async () => undefined), handleNew: vi.fn(),
    handleOpenDirectory: vi.fn(async () => undefined), handleOpenFile: vi.fn(async () => undefined), handleOpenRecent: vi.fn(async () => undefined),
    handleOverwriteSaveConflict: vi.fn(async () => undefined), handleSave: vi.fn(async () => undefined), handleSaveAs: vi.fn(async () => undefined),
    handleSaveDeletedDraftAs: vi.fn(async () => undefined), handleUseExternal: vi.fn(async () => undefined), moveWorkspaceEntryPath: vi.fn(async () => undefined),
    notice: null, openWorkspaceFilePath: vi.fn(async () => undefined), previewRevision: 0,
    openWorkspaceIndexResult: vi.fn(async () => undefined),
    recoverCrashDraft: vi.fn(async () => undefined), refreshWorkspace: vi.fn(async () => undefined), renameWorkspaceEntryPath: vi.fn(async () => undefined),
    resolveOpenIntentRequest: mocks.resolveOpenIntentRequest, saveConflict: null, saveCurrentDocument: vi.fn(async () => true),
    settleWorkspaceSessionRestore: vi.fn(),
    seedCrashDraftRevision: vi.fn(), getCrashDraftStoredEntryToken: vi.fn(() => null), confirmCrashDraftDiscarded: vi.fn(),
    setError: vi.fn(), setNotice: vi.fn(), updateContent: vi.fn(), workspaceRoot: '/workspace',
    workspaceToken: 'workspace-7',
  };
}

function useReactiveDirtySession(session: ReturnType<typeof createSession>) {
  const [dirty, setDirty] = useState(session.dirty);
  return {
    ...session,
    dirty,
    updateContent: (content: string) => {
      session.updateContent(content);
      setDirty(true);
    },
  };
}

function useReactiveFeedbackSession(session: ReturnType<typeof createSession>) {
  const [error, setError] = useState<string | null>(session.error);
  const [notice, setNotice] = useState<string | null>(session.notice);
  return {
    ...session,
    error,
    notice,
    setError: (message: string | null) => {
      session.setError(message);
      setError(message);
    },
    setNotice: (message: string | null) => {
      session.setNotice(message);
      setNotice(message);
    },
  };
}

describe('App open intent routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.listeners.clear();
    mocks.listen.mockReset().mockImplementation(async (event, callback) => {
      mocks.listeners.set(event, callback);
      return () => mocks.listeners.delete(event);
    });
    mocks.discardOpenIntent.mockReset().mockResolvedValue(true);
    mocks.focusMainWindow.mockReset().mockResolvedValue(undefined);
    mocks.fileSwitchCancelHandler = null;
    mocks.fileSwitchQuitHandler = null;
    mocks.getPackagedOpenE2eConfig.mockReset().mockResolvedValue(null);
    mocks.peekOpenIntent.mockReset();
    mocks.requestSessionRestore.mockReset().mockResolvedValue(undefined);
    mocks.resolveOpenIntentRequest.mockReset().mockResolvedValue('accepted');
    mocks.recordPackagedOpenAppEvent.mockReset().mockResolvedValue(undefined);
    mocks.useDocumentSession.mockReset();
    mocks.crashOnRecoverDraft = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.unstubAllEnvs();
  });

  it('keeps the coordinator blocked when a stale modal effect flushes during barrier activation', () => {
    const barrierRef = { current: false };
    const coordinator = { setModalActive: vi.fn<(active: boolean) => void>() };
    const setRenderedActive = vi.fn<(active: boolean) => void>(() => {
      syncOpenIntentCoordinatorModalState(coordinator, false, barrierRef);
    });

    updatePackagedSettlementBarrier(barrierRef, setRenderedActive, true);

    expect(setRenderedActive).toHaveBeenCalledWith(true);
    expect(coordinator.setModalActive).toHaveBeenCalledWith(true);
  });

  it('polls the backend queue and resolves a clean request', async () => {
    const preview = {
      id: 'open-intent-1', source: 'startup_args', displayPath: '/workspace/next.md', targetKind: 'unknown',
    };
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);
    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(preview.id, preview.targetKind);
    expect(mocks.discardOpenIntent).not.toHaveBeenCalled();
    expect(mocks.focusMainWindow).toHaveBeenCalledWith(preview.id, false);
    expect(mocks.requestSessionRestore).toHaveBeenCalledOnce();
  });

  it('settles startup and reports a restore-request failure through app feedback', async () => {
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValue(null);
    mocks.requestSessionRestore.mockRejectedValueOnce(new Error('restore request unavailable'));

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.requestSessionRestore).toHaveBeenCalledOnce();
    expect(session.settleWorkspaceSessionRestore).toHaveBeenCalledOnce();
    expect(session.setError).toHaveBeenCalledWith('The operation could not be completed. Please try again.');
    expect(session.setNotice).toHaveBeenCalledWith(null);
  });

  it('settles startup and reports an open-intent listener failure through app feedback', async () => {
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValue(null);
    mocks.listen.mockRejectedValueOnce(new Error('open listener unavailable'));

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.requestSessionRestore).not.toHaveBeenCalled();
    expect(session.settleWorkspaceSessionRestore).toHaveBeenCalledOnce();
    expect(session.setError).toHaveBeenCalledWith('The operation could not be completed. Please try again.');
    expect(session.setNotice).toHaveBeenCalledWith(null);
  });

  it('records real backend App lifecycle and final spellcheck DOM state in evidence builds', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const preview = {
      id: 'open-intent-1', source: 'startup_args', displayPath: '/fixtures/primary.md', targetKind: 'file',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValueOnce({
      profile: 'apply-reobserve',
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    });
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const events = mocks.recordPackagedOpenAppEvent.mock.calls.map(([event]) => event as {
      type: string; fields: Record<string, unknown>;
    });
    expect(events.map((event) => event.type)).toEqual(['app_activated', 'app_applied', 'app_settled']);
    expect(session.updateContent).toHaveBeenCalledOnce();
    expect(session.updateContent).toHaveBeenCalledWith(expect.stringContaining('mmd-packaged-open-dirty'));
    expect(events[2]?.fields).toMatchObject({
      status: 'accepted',
      app: {
        activeFile: '/workspace/current.md', workspaceRoot: '/workspace', workspaceToken: 'workspace-7',
        authorityStatus: 'committed', dirty: false,
      },
      spellcheck: {
        realEditorCount: 1, enabledRealEditorCount: 1, enabledNonEditorCount: 0,
        dictionaryConsistency: 'not_claimed',
      },
    });
  });

  it('settles a clean packaged intent before dirty-seeding and protects the next intent once', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const firstApplied = deferred<void>();
    const first = {
      id: 'open-intent-first', source: 'opened_event',
      displayPath: '/fixtures/association.md', targetKind: 'file',
    };
    const next = {
      id: 'open-intent-restore', source: 'session_restore',
      displayPath: 'Restore previous workspace', targetKind: 'session_restore',
    };
    const config = {
      profile: 'apply-reobserve' as const,
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: first.displayPath,
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    };
    let backendHead: typeof first | typeof next | null = first;
    mocks.getPackagedOpenE2eConfig.mockResolvedValue(config);
    mocks.peekOpenIntent.mockImplementation(async () => backendHead);
    mocks.resolveOpenIntentRequest.mockImplementation(async (intentId) => {
      if (intentId === first.id) backendHead = next;
      else if (intentId === next.id) backendHead = null;
      return 'accepted';
    });
    mocks.recordPackagedOpenAppEvent.mockImplementation((event) => {
      const appEvent = event as { intentId: string; type: string };
      return appEvent.intentId === first.id && appEvent.type === 'app_applied'
        ? firstApplied.promise
        : Promise.resolve();
    });
    const session = createSession(false);
    mocks.useDocumentSession.mockImplementation(() => useReactiveDirtySession(session));

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.listeners.get(OPEN_INTENT_PENDING_EVENT)?.({ payload: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.peekOpenIntent).toHaveBeenCalledWith();
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledTimes(1);

    firstApplied.resolve();
    await act(async () => {
      await firstApplied.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const events = mocks.recordPackagedOpenAppEvent.mock.calls.map(([event]) => event as {
      fields: Record<string, unknown>; intentId: string; type: string;
    });
    const firstEvents = events.filter((event) => event.intentId === first.id);
    const nextEvents = events.filter((event) => event.intentId === next.id);
    expect(firstEvents.map((event) => event.type)).toEqual([
      'app_activated', 'app_applied', 'app_settled',
    ]);
    expect(firstEvents[0]?.fields).toMatchObject({ dirty: false });
    expect(firstEvents[2]?.fields).toMatchObject({ app: { dirty: false } });
    expect(nextEvents[0]).toMatchObject({ type: 'app_activated', fields: { dirty: true } });
    expect(nextEvents.map((event) => event.type)).toContain('dirty_modal_opened');
    expect(nextEvents.map((event) => event.type)).toContain('dirty_decision');
    expect(session.resolveOpenIntentRequest.mock.calls.map(([intentId]) => intentId)).toEqual([
      first.id,
      next.id,
    ]);
    expect(session.updateContent).toHaveBeenCalledOnce();
  });

  it('keeps the packaged settlement barrier until the dirty seed is observable', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const first = {
      id: 'open-intent-first', source: 'opened_event',
      displayPath: '/fixtures/association.md', targetKind: 'file',
    };
    const next = {
      id: 'open-intent-restore', source: 'session_restore',
      displayPath: 'Restore previous workspace', targetKind: 'session_restore',
    };
    const config = {
      profile: 'apply-reobserve' as const,
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: first.displayPath,
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    };
    let backendHead: typeof first | typeof next | null = first;
    mocks.getPackagedOpenE2eConfig.mockResolvedValue(config);
    mocks.peekOpenIntent.mockImplementation(async () => backendHead);
    mocks.resolveOpenIntentRequest.mockImplementation(async (intentId) => {
      if (intentId === first.id) backendHead = next;
      else if (intentId === next.id) backendHead = null;
      return 'accepted';
    });
    const session = createSession(false);
    let markDirty: () => void = () => undefined;
    mocks.useDocumentSession.mockImplementation(() => {
      const [dirty, setDirty] = useState(false);
      markDirty = () => setDirty(true);
      return { ...session, dirty };
    });

    await act(async () => root.render(<App />));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(session.updateContent).toHaveBeenCalledOnce();
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      markDirty();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const nextEvents = mocks.recordPackagedOpenAppEvent.mock.calls
      .map(([event]) => event as { fields: Record<string, unknown>; intentId: string; type: string })
      .filter((event) => event.intentId === next.id);
    expect(nextEvents[0]).toMatchObject({ type: 'app_activated', fields: { dirty: true } });
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(next.id, next.targetKind, true);
  });

  it('records a rejected packaged intent and continues with the queued successor', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const failed = {
      id: 'open-intent-unicode-rejected', source: 'opened_event',
      displayPath: '/fixtures/unicode space.md', targetKind: 'file',
    };
    const successor = {
      id: 'open-intent-directory-successor', source: 'opened_event',
      displayPath: '/fixtures/workspace', targetKind: 'directory',
    };
    const finalSuccessor = {
      id: 'open-intent-stale-successor', source: 'opened_event',
      displayPath: '/fixtures/stale.md', targetKind: 'file',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValue({
      profile: 'apply-reobserve',
      unicodeRenameReady: true,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: failed.displayPath,
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: successor.displayPath, staleFile: finalSuccessor.displayPath,
      },
    });
    let backendHead: typeof failed | typeof successor | typeof finalSuccessor | null = failed;
    mocks.peekOpenIntent.mockImplementation(async () => backendHead);
    mocks.resolveOpenIntentRequest.mockImplementation(async (intentId) => {
      if (intentId === failed.id) {
        backendHead = successor;
        throw new Error('backend rejected Unicode path');
      }
      if (intentId === successor.id) {
        backendHead = finalSuccessor;
        return 'accepted';
      }
      backendHead = null;
      return 'accepted';
    });
    const session = createSession(false);
    mocks.useDocumentSession.mockImplementation(() => useReactiveFeedbackSession(session));

    await act(async () => root.render(<App />));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const events = mocks.recordPackagedOpenAppEvent.mock.calls.map(([event]) => event as {
      fields: Record<string, unknown>; intentId: string; type: string;
    });
    expect(events.filter((event) => event.intentId === failed.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'app_settled', fields: expect.objectContaining({ status: 'failed' }) }),
    ]));
    expect(session.resolveOpenIntentRequest.mock.calls.map(([intentId]) => intentId)).toEqual([
      failed.id,
      successor.id,
      finalSuccessor.id,
    ]);
    expect(events.filter((event) => event.intentId === successor.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'app_settled', fields: expect.objectContaining({ status: 'accepted' }) }),
    ]));
    expect(events.filter((event) => event.intentId === finalSuccessor.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'app_settled', fields: expect.objectContaining({ status: 'accepted' }) }),
    ]));
  });

  it('records activation evidence before resolving a clean backend intent', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const activationRecorded = deferred<void>();
    const preview = {
      id: 'open-intent-activation-order', source: 'startup_args',
      displayPath: '/fixtures/primary.md', targetKind: 'file',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValueOnce({
      profile: 'apply-reobserve',
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    });
    mocks.recordPackagedOpenAppEvent.mockImplementation((event) => (
      (event as { type: string }).type === 'app_activated'
        ? activationRecorded.promise
        : Promise.resolve()
    ));
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.recordPackagedOpenAppEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'app_activated', intentId: preview.id,
    }));
    expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();

    activationRecorded.resolve();
    await act(async () => { await activationRecorded.promise; await Promise.resolve(); });
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(preview.id, preview.targetKind);
  });

  it('records a dirty decision before resolving the guarded backend intent', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const decisionRecorded = deferred<void>();
    const preview = {
      id: 'open-intent-decision-order', source: 'secondary_instance',
      displayPath: '/fixtures/primary.md', targetKind: 'file',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValueOnce({
      profile: 'apply-reobserve',
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    });
    mocks.recordPackagedOpenAppEvent.mockImplementation((event) => (
      (event as { type: string }).type === 'dirty_decision'
        ? decisionRecorded.promise
        : Promise.resolve()
    ));
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.recordPackagedOpenAppEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dirty_decision', intentId: preview.id,
    }));
    expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();

    decisionRecorded.resolve();
    await act(async () => { await decisionRecorded.promise; await Promise.resolve(); });
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(preview.id, preview.targetKind, true);
  });

  it('does not replay a stale pending intent after an accepted resolve clears active ownership', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const preview = {
      id: 'open-intent-stale-pending', source: 'secondary_instance',
      displayPath: '/fixtures/primary.md', targetKind: 'file',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValue({
      profile: 'apply-reobserve',
      unicodeRenameReady: false,
      paths: {
        primaryFile: preview.displayPath, unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    });
    mocks.peekOpenIntent.mockResolvedValue(preview);
    const session = createSession(true);
    const accepted = deferred<'accepted'>();
    let markClean: () => void = () => undefined;
    mocks.useDocumentSession.mockImplementation(() => {
      const [dirty, setDirty] = useState(true);
      markClean = () => setDirty(false);
      return { ...session, dirty };
    });
    mocks.resolveOpenIntentRequest
      .mockImplementationOnce(async () => {
        const outcome = await accepted.promise;
        markClean();
        return outcome;
      })
      .mockResolvedValue('failed');

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.resolveOpenIntentRequest).toHaveBeenCalledOnce();
    const staleCancelHandler = mocks.fileSwitchCancelHandler;
    const staleQuitHandler = mocks.fileSwitchQuitHandler;
    expect(staleCancelHandler).not.toBeNull();
    expect(staleQuitHandler).not.toBeNull();

    await act(async () => {
      accepted.resolve('accepted');
      await accepted.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const dirtyDecisionCountBeforeStaleHandler = mocks.recordPackagedOpenAppEvent.mock.calls.filter(([event]) => (
      (event as { type: string }).type === 'dirty_decision'
    )).length;
    staleCancelHandler?.();
    staleQuitHandler?.();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.peekOpenIntent.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.resolveOpenIntentRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordPackagedOpenAppEvent.mock.calls.filter(([event]) => (
      (event as { type: string }).type === 'dirty_decision'
    ))).toHaveLength(dirtyDecisionCountBeforeStaleHandler);
    expect(mocks.discardOpenIntent).not.toHaveBeenCalled();
    expect(session.setError).not.toHaveBeenCalled();
  });

  it('records dirty modal decisions for backend intents but ignores local intents', async () => {
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const preview = {
      id: 'open-intent-2', source: 'session_restore', displayPath: 'Restore previous workspace', targetKind: 'session_restore',
    };
    mocks.getPackagedOpenE2eConfig.mockResolvedValueOnce({
      profile: 'restore-cancel',
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    });
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);

    await act(async () => root.render(<App />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.recordPackagedOpenAppEvent.mock.calls.map(([event]) => (
      event as { type: string }
    ).type)).toEqual(['app_activated', 'dirty_modal_opened', 'dirty_decision', 'app_settled']);
    expect(mocks.recordPackagedOpenAppEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dirty_decision', fields: { decision: 'cancel' },
    }));
    expect(mocks.discardOpenIntent).toHaveBeenCalledOnce();

    mocks.recordPackagedOpenAppEvent.mockClear();
    act(() => mocks.listeners.get(NATIVE_MENU_EVENT)?.({ payload: 'open-file' }));
    await act(async () => Promise.resolve());
    expect(mocks.recordPackagedOpenAppEvent).not.toHaveBeenCalled();
  });

  it('waits for the Unicode rename gate before making one discard decision', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const config = {
      profile: 'apply-reobserve' as const,
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    };
    mocks.getPackagedOpenE2eConfig
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce({ ...config, unicodeRenameReady: true });
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce({
      id: 'open-intent-3', source: 'secondary_instance',
      displayPath: config.paths.unicodeFile, targetKind: 'file',
    }).mockResolvedValue(null);

    try {
      await act(async () => root.render(<App />));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(50));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(session.resolveOpenIntentRequest).toHaveBeenCalledOnce();
      expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(
        'open-intent-3',
        'file',
        true,
      );
      expect(mocks.recordPackagedOpenAppEvent.mock.calls.filter(([event]) => (
        (event as { type: string }).type === 'dirty_decision'
      ))).toHaveLength(1);
      expect(mocks.recordPackagedOpenAppEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'dirty_decision', fields: { decision: 'discard' },
      }));

      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(session.resolveOpenIntentRequest).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the Unicode rename gate before resolving a clean packaged intent', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_MMD_PACKAGED_OPEN_E2E', '1');
    const config = {
      profile: 'apply-reobserve' as const,
      unicodeRenameReady: false,
      paths: {
        primaryFile: '/fixtures/primary.md', unicodeFile: '/fixtures/unicode space.md',
        renamedUnicodeFile: '/fixtures/unicode renamed.md', associationFile: '/fixtures/association.md',
        workspaceDirectory: '/fixtures/workspace', staleFile: '/fixtures/stale.md',
      },
    };
    mocks.getPackagedOpenE2eConfig
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce({ ...config, unicodeRenameReady: true });
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce({
      id: 'open-intent-clean-unicode', source: 'secondary_instance',
      displayPath: config.paths.unicodeFile, targetKind: 'file',
    }).mockResolvedValue(null);

    try {
      await act(async () => root.render(<App />));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(50));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(session.resolveOpenIntentRequest).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('focuses the active main window for a coalesced native request without resolving it twice', async () => {
    const preview = {
      id: 'open-intent-1', source: 'secondary_instance', displayPath: '/workspace/next.md', targetKind: 'unknown',
    };
    const resolution = new Promise<'accepted'>(() => undefined);
    const session = createSession(false);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.resolveOpenIntentRequest.mockReturnValueOnce(resolution);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview);

    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());
    expect(mocks.focusMainWindow).toHaveBeenCalledWith(preview.id, false);

    await act(async () => {
      mocks.listeners.get(OPEN_INTENT_FOCUS_EVENT)?.({ payload: null });
      await Promise.resolve();
    });

    expect(mocks.focusMainWindow).toHaveBeenCalledTimes(2);
    expect(mocks.focusMainWindow).toHaveBeenLastCalledWith(preview.id, true);
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledOnce();
  });

  it('holds a dirty request behind the shared unsaved modal', async () => {
    const preview = {
      id: 'open-intent-2', source: 'secondary_instance', displayPath: '/workspace/next.md', targetKind: 'unknown',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);
    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());
    expect(container.querySelector('.unsaved-dialog')).not.toBeNull();
    expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => Promise.resolve());
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(preview.id, preview.targetKind, true);
  });

  it('discards a cancelled dirty request without resolving a path', async () => {
    const preview = {
      id: 'open-intent-3', source: 'opened_event', displayPath: '/workspace/next.md', targetKind: 'unknown',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);
    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click());
    await act(async () => Promise.resolve());
    expect(mocks.discardOpenIntent).toHaveBeenCalledWith(preview.id);
    expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();
  });

  it('settles the startup gate when a session-restore intent is cancelled', async () => {
    const preview = {
      id: 'open-intent-4', source: 'session_restore', displayPath: 'Restore previous workspace', targetKind: 'session_restore',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);
    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click());
    await act(async () => Promise.resolve());

    expect(mocks.discardOpenIntent).toHaveBeenCalledWith(preview.id);
    expect(session.settleWorkspaceSessionRestore).toHaveBeenCalledOnce();
    expect(session.resolveOpenIntentRequest).not.toHaveBeenCalled();
  });

  it('continues with the next queued intent after cancelling session restore', async () => {
    const restore = {
      id: 'open-intent-restore', source: 'session_restore', displayPath: 'Restore previous workspace', targetKind: 'session_restore',
    };
    const next = {
      id: 'open-intent-next', source: 'secondary_instance', displayPath: '/workspace/next.md', targetKind: 'unknown',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent
      .mockResolvedValueOnce(restore)
      .mockResolvedValueOnce(next)
      .mockResolvedValue(null);

    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.discardOpenIntent).toHaveBeenCalledWith(restore.id);
    expect(session.settleWorkspaceSessionRestore).toHaveBeenCalledOnce();
    expect(mocks.peekOpenIntent).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.unsaved-dialog')).not.toBeNull();

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => Promise.resolve());

    expect(session.resolveOpenIntentRequest).toHaveBeenCalledOnce();
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(next.id, next.targetKind, true);
  });

  it('keeps a dirty document behind the shared guard before opening a search result', async () => {
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValue(null);

    await act(async () => root.render(<App />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="quick-open"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="quick-open-result"]')?.click());

    expect(container.querySelector('.unsaved-dialog')).not.toBeNull();
    expect(session.openWorkspaceIndexResult).not.toHaveBeenCalled();

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => Promise.resolve());

    expect(session.openWorkspaceIndexResult).toHaveBeenCalledWith(
      'workspace-7',
      '/workspace',
      3,
      'notes/search-result.md',
    );
  });

  it('queues native menu document replacements behind the same dirty modal in FIFO order', async () => {
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValue(null);
    await act(async () => root.render(<App />));
    const nativeMenu = mocks.listeners.get(NATIVE_MENU_EVENT);
    expect(nativeMenu).toBeDefined();

    act(() => {
      nativeMenu?.({ payload: 'open-file' });
      nativeMenu?.({ payload: 'open-directory' });
      nativeMenu?.({ payload: 'open-recent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      nativeMenu?.({ payload: 'new' });
    });
    expect(container.querySelectorAll('.unsaved-dialog')).toHaveLength(1);

    for (const expected of [
      session.handleOpenFile,
      session.handleOpenDirectory,
      session.handleOpenRecent,
      session.handleNew,
    ]) {
      act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(expected).toHaveBeenCalledOnce();
    }
    expect(session.handleOpenRecent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('keeps a queued menu request behind an active backend request', async () => {
    const preview = {
      id: 'open-intent-10', source: 'opened_event', displayPath: '/workspace/native.md', targetKind: 'unknown',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValueOnce(preview).mockResolvedValue(null);
    await act(async () => root.render(<App />));
    await act(async () => Promise.resolve());

    act(() => mocks.listeners.get(NATIVE_MENU_EVENT)?.({ payload: 'open-file' }));
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(session.resolveOpenIntentRequest).toHaveBeenCalledWith(preview.id, preview.targetKind, true);
    expect(session.handleOpenFile).not.toHaveBeenCalled();

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(session.handleOpenFile).toHaveBeenCalledOnce();
  });

  it('routes sidebar and recovered crash drafts through the shared dirty guard', async () => {
    const recovered = {
      documentId: 'document-recovered', fileKind: 'markdown', pathHint: '/workspace/recovered.md',
      baseVersionToken: null, content: '# recovered', draftRevision: 2, updatedAtUnixMs: 10,
      entryToken: 'entry-token-1234567890',
    };
    const session = createSession(true);
    mocks.useDocumentSession.mockReturnValue(session);
    mocks.peekOpenIntent.mockResolvedValue(null);
    await act(async () => root.render(<App />));

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-file"]')?.click());
    await act(async () => mocks.crashOnRecoverDraft?.(recovered));
    expect(container.querySelectorAll('.unsaved-dialog')).toHaveLength(1);
    expect(session.openWorkspaceFilePath).not.toHaveBeenCalled();
    expect(session.recoverCrashDraft).not.toHaveBeenCalled();

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(session.openWorkspaceFilePath).toHaveBeenCalledWith('/workspace/sidebar.md');
    expect(session.recoverCrashDraft).not.toHaveBeenCalled();

    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Switch Without Saving')?.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(session.recoverCrashDraft).toHaveBeenCalledWith(recovered);
  });
});
