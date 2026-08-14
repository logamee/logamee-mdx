// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MARKDOWN } from '../lib/documentNames';
import type {
  DocumentSessionState,
} from '../lib/documentSession';
import type { PaneSnapshotEnvelope } from '../lib/paneSync';
import type {
  OpenCommitResult,
  PreparedOpenFileResponse,
  WorkspaceSessionRestore,
  WorkspaceSnapshot,
} from '../types';
import { useDocumentSession } from './useDocumentSession';

interface FakePaneReplicationOptions {
  observe: (snapshot: PaneSnapshotEnvelope) => void;
  role: 'main' | 'editor-popout' | 'preview-popout';
}

interface FakePaneReplication {
  options: FakePaneReplicationOptions;
  dispose: () => void;
  publishAuthoritativeState: (state: unknown) => void;
  publishEditorContent: (content: string) => void;
  start: () => void;
}

const restoreDocumentSnapshotMock = vi.hoisted(() => (
  vi.fn<(snapshot: DocumentSessionState) => DocumentSessionState>()
));

const tauriMocks = vi.hoisted(() => ({
  clearRecentFiles: vi.fn<typeof import('../lib/tauriCommands').clearRecentFiles>(),
  commitRecentOpen: vi.fn<typeof import('../lib/tauriCommands').commitRecentOpen>(),
  createWorkspaceDirectory: vi.fn<typeof import('../lib/tauriCommands').createWorkspaceDirectory>(),
  createWorkspaceFile: vi.fn<typeof import('../lib/tauriCommands').createWorkspaceFile>(),
  deleteWorkspaceEntry: vi.fn<typeof import('../lib/tauriCommands').deleteWorkspaceEntry>(),
  discardOpenReceipt: vi.fn<typeof import('../lib/tauriCommands').discardOpenReceipt>(),
  getOpenCommitStatus: vi.fn<typeof import('../lib/tauriCommands').getOpenCommitStatus>(),
  issueDocumentOverwriteToken: vi.fn<typeof import('../lib/tauriCommands').issueDocumentOverwriteToken>(),
  retryDocumentSaveWithToken: vi.fn<typeof import('../lib/tauriCommands').retryDocumentSaveWithToken>(),
  cancelDocumentOverwriteToken: vi.fn<typeof import('../lib/tauriCommands').cancelDocumentOverwriteToken>(),
  moveWorkspaceEntry: vi.fn<typeof import('../lib/tauriCommands').moveWorkspaceEntry>(),
  openDirectoryDialog: vi.fn<typeof import('../lib/tauriCommands').openDirectoryDialog>(),
  openFileDialog: vi.fn<typeof import('../lib/tauriCommands').openFileDialog>(),
  openRecentFile: vi.fn<typeof import('../lib/tauriCommands').openRecentFile>(),
  openWorkspaceFile: vi.fn<typeof import('../lib/tauriCommands').openWorkspaceFile>(),
  persistWorkspaceSession: vi.fn<typeof import('../lib/tauriCommands').persistWorkspaceSession>(),
  refreshDirectory: vi.fn<typeof import('../lib/tauriCommands').refreshDirectory>(),
  renameWorkspaceEntry: vi.fn<typeof import('../lib/tauriCommands').renameWorkspaceEntry>(),
  resolveOpenIntent: vi.fn<typeof import('../lib/tauriCommands').resolveOpenIntent>(),
  settleOpenIntentWorkspace: vi.fn<typeof import('../lib/tauriCommands').settleOpenIntentWorkspace>(),
  saveAsDialog: vi.fn<typeof import('../lib/tauriCommands').saveAsDialog>(),
  writeFile: vi.fn<typeof import('../lib/tauriCommands').writeFile>(),
}));
const crashDraftMocks = vi.hoisted(() => ({
  write: vi.fn<(request: import('../lib/crashDrafts').CrashDraftWriteRequest) => Promise<unknown>>(),
}));

const paneMocks = vi.hoisted(() => ({
  createPaneProtocolId: vi.fn<(prefix: string) => string>(),
  createTauriPaneReplication: vi.fn<(
    options: FakePaneReplicationOptions,
  ) => FakePaneReplication>(),
  instances: [] as FakePaneReplication[],
}));

vi.mock('../lib/documentSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/documentSession')>();
  return {
    ...actual,
    restoreDocumentSnapshot: restoreDocumentSnapshotMock,
  };
});

vi.mock('../lib/tauriCommands', () => tauriMocks);
vi.mock('../lib/crashDraftCommands', () => ({ crashDraftCommands: { write: crashDraftMocks.write } }));

vi.mock('../lib/tauriPaneReplication', () => ({
  createPaneProtocolId: paneMocks.createPaneProtocolId,
  createTauriPaneReplication: paneMocks.createTauriPaneReplication,
}));

type Session = ReturnType<typeof useDocumentSession>;
type OpenKind = 'normal' | 'recent';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

let currentSession: Session | null = null;
const fileVersion = {
  canonicalPath: '/workspace/notes.md', platformIdentity: '1', length: '7', modifiedNanos: '1', sha256: 'a'.repeat(64),
};

function SessionHarness({ isPopout = false, popoutPane = 'main', autosaveEnabled, autosaveDelayMs, afterConfirmedSave }: {
  isPopout?: boolean;
  popoutPane?: 'main' | 'editor' | 'preview';
  autosaveEnabled?: boolean;
  autosaveDelayMs?: number;
  afterConfirmedSave?: (documentId: string) => boolean | void | Promise<boolean | void>;
}) {
  currentSession = useDocumentSession({
    activeDocumentWatchTransport: null,
    isPopout,
    popoutPane,
    autosaveEnabled,
    autosaveDelayMs,
    afterConfirmedSave,
  });
  return null;
}

function session(): Session {
  if (!currentSession) throw new Error('Expected a mounted document session');
  return currentSession;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function preparedOpen(
  name: string,
  file: PreparedOpenFileResponse['file'] = {
    kind: 'markdown',
    path: `/workspace/${name}.md`,
    content_mode: 'text',
    content: `# ${name}`,
    file_version: fileVersion,
  },
): PreparedOpenFileResponse {
  return {
    file,
    open_receipt: `${name}-open-receipt`,
    commit_operation_id: `${name}-commit-operation`,
  };
}

function committed(): OpenCommitResult {
  return { status: 'committed', recent_files: { entries: [] } };
}

function workspaceSnapshot(
  files: WorkspaceSnapshot['files'] = [],
): WorkspaceSnapshot {
  return {
    workspace_token: 'restored-workspace-token',
    root: '/workspace',
    files,
    directories: [],
  };
}

function enableTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
}

function disableTauriRuntime() {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function flushSessionEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mockWorkspaceSessionRestore(restore: WorkspaceSessionRestore | null) {
  tauriMocks.resolveOpenIntent.mockResolvedValue({
    kind: 'session_restore',
    restore,
    workspace_open_receipt: restore ? 'workspace-open-restore' : null,
  });
}

async function requestWorkspaceSessionRestore(intentId = 'session-restore-intent') {
  let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
  await act(async () => {
    outcome = await session().resolveOpenIntentRequest(intentId, 'session_restore');
  });
  return outcome;
}

function documentSnapshot(value: Session) {
  return {
    activeFileKind: value.activeFileKind,
    activeMimeType: value.activeMimeType,
    activePath: value.activePath,
    authorityStatus: value.authorityStatus,
    content: value.content,
    dirty: value.dirty,
    previewRevision: 0,
    documentEpoch: value.documentEpoch,
    documentId: value.documentId,
    lastSavedContent: value.lastSavedContent,
  };
}

async function beginOpen(
  kind: OpenKind,
  entryId = 'recent-entry',
): Promise<{ completion: Promise<void> }> {
  let openPromise!: Promise<void>;
  await act(async () => {
    openPromise = kind === 'normal'
      ? session().handleOpenFile()
      : session().handleOpenRecent(entryId);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { completion: openPromise };
}

function provisionalPaneSnapshot(): PaneSnapshotEnvelope {
  return {
    protocolVersion: 2,
    authorityId: 'main-authority',
    revision: 1,
    documentId: 'provisional-document',
    documentEpoch: 9,
    state: {
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: '/workspace/provisional.md',
      authorityStatus: 'provisional',
      content: '# Provisional',
      lastSavedContent: '# Provisional',
      workspaceRoot: '/workspace',
      documentId: 'provisional-document',
      previewRevision: 0,
      documentEpoch: 9,
    },
  };
}

describe('useDocumentSession prepared-open authority workflow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextPaneId: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    currentSession = null;
    nextPaneId = 0;

    restoreDocumentSnapshotMock.mockReset();
    restoreDocumentSnapshotMock.mockImplementation((snapshot: DocumentSessionState) => ({ ...snapshot }));

    tauriMocks.clearRecentFiles.mockReset();
    tauriMocks.commitRecentOpen.mockReset();
    tauriMocks.createWorkspaceDirectory.mockReset();
    tauriMocks.createWorkspaceFile.mockReset();
    tauriMocks.deleteWorkspaceEntry.mockReset();
    tauriMocks.discardOpenReceipt.mockReset();
    tauriMocks.getOpenCommitStatus.mockReset();
    tauriMocks.issueDocumentOverwriteToken.mockReset();
    tauriMocks.retryDocumentSaveWithToken.mockReset();
    tauriMocks.cancelDocumentOverwriteToken.mockReset();
    tauriMocks.moveWorkspaceEntry.mockReset();
    tauriMocks.openDirectoryDialog.mockReset();
    tauriMocks.openFileDialog.mockReset();
    tauriMocks.openRecentFile.mockReset();
    tauriMocks.openWorkspaceFile.mockReset();
    tauriMocks.persistWorkspaceSession.mockReset();
    tauriMocks.refreshDirectory.mockReset();
    tauriMocks.renameWorkspaceEntry.mockReset();
    tauriMocks.resolveOpenIntent.mockReset();
    tauriMocks.settleOpenIntentWorkspace.mockReset();
    tauriMocks.saveAsDialog.mockReset();
    tauriMocks.writeFile.mockReset();
    crashDraftMocks.write.mockReset();
    crashDraftMocks.write.mockImplementation(async (request) => ({
      status: 'stored', documentId: request.documentId, draftRevision: request.draftRevision,
      entryToken: '9'.repeat(64), updatedAtUnixMs: 1, evictedDocumentIds: [],
    }));

    tauriMocks.clearRecentFiles.mockResolvedValue({ entries: [] });
    tauriMocks.commitRecentOpen.mockResolvedValue(committed());
    tauriMocks.discardOpenReceipt.mockResolvedValue(true);
    tauriMocks.getOpenCommitStatus.mockResolvedValue({ status: 'unknown' });
    tauriMocks.issueDocumentOverwriteToken.mockResolvedValue({ overwriteToken: 'e'.repeat(64) });
    tauriMocks.retryDocumentSaveWithToken.mockResolvedValue({ status: 'confirmed_committed', path: '/workspace/notes.md', version: fileVersion });
    tauriMocks.cancelDocumentOverwriteToken.mockResolvedValue(undefined);
    tauriMocks.openFileDialog.mockResolvedValue(null);
    tauriMocks.persistWorkspaceSession.mockResolvedValue(undefined);
    tauriMocks.settleOpenIntentWorkspace.mockResolvedValue('applied');
    tauriMocks.saveAsDialog.mockResolvedValue(null);
    tauriMocks.writeFile.mockResolvedValue({
      status: 'confirmed_committed', path: '/workspace/notes.md', version: fileVersion,
    });

    paneMocks.instances.splice(0);
    paneMocks.createPaneProtocolId.mockReset();
    paneMocks.createTauriPaneReplication.mockReset();
    paneMocks.createPaneProtocolId.mockImplementation((prefix) => `${prefix}-${++nextPaneId}`);
    paneMocks.createTauriPaneReplication.mockImplementation((options) => {
      const replication: FakePaneReplication = {
        options,
        dispose: vi.fn<() => void>(),
        publishAuthoritativeState: vi.fn<(state: unknown) => void>(),
        publishEditorContent: vi.fn<(content: string) => void>(),
        start: vi.fn<() => void>(),
      };
      paneMocks.instances.push(replication);
      return replication;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    currentSession = null;
    disableTauriRuntime();
    vi.useRealTimers();
  });

  it.each(['normal', 'recent'] as const)(
    'keeps a %s prepared open provisional and blocks edit, save, and save-as until commit',
    async (kind) => {
      const commit = deferred<OpenCommitResult>();
      const prepared = preparedOpen(`${kind}-prepared`);
      if (kind === 'normal') tauriMocks.openFileDialog.mockResolvedValueOnce(prepared);
      else tauriMocks.openRecentFile.mockResolvedValueOnce(prepared);
      tauriMocks.commitRecentOpen.mockReturnValueOnce(commit.promise);

      act(() => root.render(<SessionHarness />));
      const { completion: openPromise } = await beginOpen(kind);

      expect(documentSnapshot(session())).toMatchObject({
        activePath: prepared.file.path,
        authorityStatus: 'provisional',
        content: prepared.file.content,
        dirty: false,
      });

      await act(async () => {
        session().updateContent('# Escaped mutation');
        await Promise.all([
          session().handleSave(),
          session().handleSaveAs(),
          session().saveCurrentDocument(),
        ]);
      });

      expect(session().content).toBe(prepared.file.content);
      expect(tauriMocks.writeFile).not.toHaveBeenCalled();
      expect(tauriMocks.saveAsDialog).not.toHaveBeenCalled();

      commit.resolve(committed());
      await act(async () => openPromise);

      expect(session().authorityStatus).toBe('committed');
      act(() => session().updateContent('# Committed mutation'));
      expect(session().content).toBe('# Committed mutation');
      expect(tauriMocks.commitRecentOpen).toHaveBeenCalledOnce();
      expect(tauriMocks.openRecentFile.mock.calls).toEqual(
        kind === 'recent' ? [['recent-entry']] : [],
      );
    },
  );

  it('saves with the opened version and resolves a conflict only after explicit overwrite', async () => {
    const afterConfirmedSave = vi.fn<(documentId: string) => void>();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockResolvedValueOnce({
      status: 'conflict', path: '/workspace/notes.md', current_version: fileVersion, message: 'changed',
    });
    act(() => root.render(<SessionHarness afterConfirmedSave={afterConfirmedSave} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Dirty'));

    await act(async () => session().handleSave());

    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      '/workspace/notes.md', '# Dirty', fileVersion, expect.stringMatching(/^document-save-/),
    );
    expect(session().dirty).toBe(true);
    expect(session().saveConflict).toEqual({ busy: false, path: '/workspace/notes.md' });
    expect(afterConfirmedSave).not.toHaveBeenCalled();

    await act(async () => session().handleOverwriteSaveConflict());

    const operationId = tauriMocks.writeFile.mock.calls[0]?.[3];
    expect(tauriMocks.issueDocumentOverwriteToken).toHaveBeenCalledWith(
      '/workspace/notes.md', '# Dirty', operationId,
    );
    expect(tauriMocks.retryDocumentSaveWithToken).toHaveBeenCalledWith(
      '/workspace/notes.md', '# Dirty', operationId, 'e'.repeat(64),
    );
    expect(session().dirty).toBe(false);
    expect(session().saveConflict).toBeNull();
    expect(afterConfirmedSave).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{32}$/));
  });

  it('cancels an ordinary save conflict without issuing an overwrite token', async () => {
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockResolvedValueOnce({
      status: 'conflict', path: '/workspace/notes.md', message: 'changed',
    });
    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Dirty'));
    await act(async () => session().handleSave());

    act(() => session().handleCancelSaveConflict());

    expect(session().saveConflict).toBeNull();
    expect(session().dirty).toBe(true);
    expect(tauriMocks.issueDocumentOverwriteToken).not.toHaveBeenCalled();
    expect(tauriMocks.cancelDocumentOverwriteToken).not.toHaveBeenCalled();
  });

  it('locks the document after an indeterminate overwrite and cannot replay the decision', async () => {
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockResolvedValueOnce({ status: 'conflict', path: '/workspace/notes.md', message: 'changed' });
    tauriMocks.retryDocumentSaveWithToken.mockResolvedValueOnce({
      status: 'indeterminate', path: '/workspace/notes.md', message: 'Inspect the file before continuing.',
    });
    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Dirty'));
    await act(async () => session().handleSave());
    await act(async () => session().handleOverwriteSaveConflict());
    await act(async () => session().handleOverwriteSaveConflict());

    expect(session().authorityStatus).toBe('unknown');
    expect(session().dirty).toBe(true);
    expect(session().saveConflict).toBeNull();
    expect(tauriMocks.issueDocumentOverwriteToken).toHaveBeenCalledOnce();
    expect(tauriMocks.retryDocumentSaveWithToken).toHaveBeenCalledOnce();
  });

  it('uses and cancels only the preissued token from a Save As race', async () => {
    const overwriteToken = 'f'.repeat(64);
    tauriMocks.saveAsDialog.mockResolvedValueOnce({
      status: 'conflict', path: '/workspace/new.md', message: 'already exists', overwrite_token: overwriteToken,
    });
    act(() => root.render(<SessionHarness />));
    act(() => session().updateContent('# New draft'));
    await act(async () => session().handleSave());
    expect(session().saveConflict).toEqual({ busy: false, path: '/workspace/new.md' });

    act(() => session().handleCancelSaveConflict());
    await flushSessionEffects();
    expect(tauriMocks.cancelDocumentOverwriteToken).toHaveBeenCalledWith('/workspace/new.md', overwriteToken);
    expect(tauriMocks.issueDocumentOverwriteToken).not.toHaveBeenCalled();

    tauriMocks.saveAsDialog.mockResolvedValueOnce({
      status: 'conflict', path: '/workspace/new.md', message: 'already exists', overwrite_token: overwriteToken,
    });
    await act(async () => session().handleSave());
    tauriMocks.retryDocumentSaveWithToken.mockResolvedValueOnce({
      status: 'confirmed_committed',
      path: '/workspace/new.md',
      version: { ...fileVersion, canonicalPath: '/workspace/new.md' },
    });
    await act(async () => session().handleOverwriteSaveConflict());
    expect(tauriMocks.issueDocumentOverwriteToken).not.toHaveBeenCalled();
    expect(tauriMocks.retryDocumentSaveWithToken).toHaveBeenCalledWith(
      '/workspace/new.md', '# New draft', expect.stringMatching(/^document-save-/), overwriteToken,
    );
    expect(session().activePath).toBe('/workspace/new.md');
    expect(session().dirty).toBe(false);
    expect(session().saveConflict).toBeNull();
  });

  it('autosaves the latest dirty content after the configured delay and cancels on New', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={500} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# First'));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => session().updateContent('# Latest'));
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      '/workspace/notes.md', '# Latest', fileVersion, expect.stringMatching(/^document-save-/),
    );

    act(() => session().updateContent('# Again'));
    await act(async () => session().handleNew());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(tauriMocks.writeFile).toHaveBeenCalledOnce();
  });

  it('owns one main-window crash scheduler with exact existing-file metadata', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Crash protected'));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(crashDraftMocks.write).toHaveBeenCalledOnce();
    expect(crashDraftMocks.write).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.stringMatching(/^[0-9a-f]{32}$/),
      fileKind: 'markdown',
      pathHint: '/workspace/notes.md',
      baseVersionToken: fileVersion.sha256,
      content: '# Crash protected',
      draftRevision: 1,
    }));
  });

  it('never schedules crash drafts from an editor popout', async () => {
    vi.useFakeTimers();
    act(() => root.render(<SessionHarness isPopout popoutPane="editor" />));
    const replication = paneMocks.instances[0]!;
    act(() => replication.options.observe({
      ...provisionalPaneSnapshot(),
      revision: 2,
      state: { ...provisionalPaneSnapshot().state, authorityStatus: 'committed' },
    }));
    act(() => session().updateContent('# Popout edit'));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(crashDraftMocks.write).not.toHaveBeenCalled();
  });

  it('flushes the current crash draft before New invalidates the logical document', async () => {
    vi.useFakeTimers();
    act(() => root.render(<SessionHarness />));
    act(() => session().updateContent('# Untitled draft'));
    await act(async () => session().handleNew());
    expect(crashDraftMocks.write).toHaveBeenCalledWith(expect.objectContaining({
      pathHint: null, baseVersionToken: null, content: '# Untitled draft',
    }));
    expect(session().content).toBe(EMPTY_MARKDOWN);
  });

  it('hydrates recovery as a detached dirty document without following the path hint', async () => {
    act(() => root.render(<SessionHarness />));
    const recoveredId = '7'.repeat(32);
    await act(async () => session().recoverCrashDraft({
      documentId: recoveredId,
      draftRevision: 3,
      fileKind: 'html',
      pathHint: '/private/original.html',
      baseVersionToken: '8'.repeat(64),
      content: '<h1>Recovered</h1>',
      updatedAtUnixMs: 1,
      entryToken: '9'.repeat(64),
    }));
    expect(session().activePath).toBeNull();
    expect(session().content).toBe('<h1>Recovered</h1>');
    expect(session().dirty).toBe(true);
    expect(tauriMocks.openWorkspaceFile).not.toHaveBeenCalled();
    expect(tauriMocks.openRecentFile).not.toHaveBeenCalled();
    expect(tauriMocks.openFileDialog).not.toHaveBeenCalled();
  });

  it('preserves the recovered crash document ID through confirmed-save cleanup', async () => {
    const afterConfirmedSave = vi.fn<(documentId: string) => Promise<boolean>>(async () => true);
    const recoveredId = '7'.repeat(32);
    tauriMocks.saveAsDialog.mockResolvedValueOnce({
      status: 'confirmed_committed', path: '/workspace/recovered.md',
      version: { ...fileVersion, canonicalPath: '/workspace/recovered.md' },
    });
    act(() => root.render(<SessionHarness afterConfirmedSave={afterConfirmedSave} />));
    await act(async () => session().recoverCrashDraft({
      documentId: recoveredId, draftRevision: 3, fileKind: 'markdown',
      pathHint: '/private/original.md', baseVersionToken: '8'.repeat(64), content: '# Recovered',
      updatedAtUnixMs: 1, entryToken: '9'.repeat(64),
    }));
    await act(async () => session().handleSave());
    expect(afterConfirmedSave).toHaveBeenCalledWith(recoveredId);
    expect(session().activePath).toBe('/workspace/recovered.md');
    expect(session().dirty).toBe(false);
  });

  it('flushes a dirty crash draft before committing an actual document switch', async () => {
    const events: string[] = [];
    tauriMocks.openFileDialog
      .mockResolvedValueOnce(preparedOpen('first'))
      .mockResolvedValueOnce(preparedOpen('second'));
    crashDraftMocks.write.mockImplementation(async (request) => {
      events.push(`draft:${request.content}`);
      return {
        status: 'stored', documentId: request.documentId, draftRevision: request.draftRevision,
        entryToken: '9'.repeat(64), updatedAtUnixMs: 1, evictedDocumentIds: [],
      };
    });
    tauriMocks.commitRecentOpen.mockImplementation(async () => {
      events.push('open:commit');
      return committed();
    });
    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());
    events.length = 0;
    act(() => session().updateContent('# Before switch'));
    await act(async () => session().handleOpenFile());
    expect(events).toEqual(['draft:# Before switch', 'open:commit']);
    expect(session().activePath).toBe('/workspace/second.md');
  });

  it('discards the flushed crash draft after a confirmed dirty open-intent switch', async () => {
    const events: string[] = [];
    const afterConfirmedSave = vi.fn<(documentId: string) => Promise<boolean>>(async () => {
      events.push('draft:discard');
      return true;
    });
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('first'));
    tauriMocks.resolveOpenIntent.mockResolvedValueOnce({
      kind: 'file',
      prepared: preparedOpen('second'),
    });
    crashDraftMocks.write.mockImplementation(async (request) => {
      events.push(`draft:flush:${request.content}`);
      return {
        status: 'stored', documentId: request.documentId, draftRevision: request.draftRevision,
        entryToken: '9'.repeat(64), updatedAtUnixMs: 1, evictedDocumentIds: [],
      };
    });
    tauriMocks.commitRecentOpen.mockImplementation(async () => {
      events.push('open:commit');
      return committed();
    });
    act(() => root.render(<SessionHarness afterConfirmedSave={afterConfirmedSave} />));
    await act(async () => session().handleOpenFile());
    events.length = 0;
    act(() => session().updateContent('# Discard before switch'));

    let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
    await act(async () => {
      outcome = await session().resolveOpenIntentRequest('open-intent-discard', 'file', true);
    });

    expect(outcome).toBe('accepted');
    expect(events).toEqual([
      'draft:flush:# Discard before switch',
      'open:commit',
      'draft:discard',
    ]);
    expect(afterConfirmedSave).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(session().activePath).toBe('/workspace/second.md');
  });

  it('retains and reschedules newer edits when an older save commits', async () => {
    vi.useFakeTimers();
    const afterConfirmedSave = vi.fn<(documentId: string) => Promise<boolean>>(async () => true);
    const write = deferred<Awaited<ReturnType<typeof tauriMocks.writeFile>>>();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockReturnValueOnce(write.promise);
    act(() => root.render(<SessionHarness afterConfirmedSave={afterConfirmedSave} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Saving'));
    let completion!: Promise<boolean>;
    act(() => { completion = session().saveCurrentDocument(); });
    act(() => session().updateContent('# Newer edit'));
    write.resolve({
      status: 'confirmed_committed', path: '/workspace/notes.md',
      version: { ...fileVersion, sha256: 'f'.repeat(64) },
    });
    await expect(act(async () => completion)).resolves.toBe(false);
    expect(session().dirty).toBe(true);
    expect(afterConfirmedSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(crashDraftMocks.write).toHaveBeenLastCalledWith(expect.objectContaining({
      content: '# Newer edit', baseVersionToken: 'f'.repeat(64),
    }));
  });

  it('returns false when newer edits remain after an older Save As snapshot commits', async () => {
    const saveAs = deferred<Awaited<ReturnType<typeof tauriMocks.saveAsDialog>>>();
    tauriMocks.saveAsDialog.mockReturnValueOnce(saveAs.promise);
    act(() => root.render(<SessionHarness />));
    act(() => session().updateContent('# Saving'));

    let completion!: Promise<boolean>;
    act(() => { completion = session().saveCurrentDocument(); });
    act(() => session().updateContent('# Newer edit'));
    saveAs.resolve({
      status: 'confirmed_committed', path: '/workspace/notes.md', version: fileVersion,
    });

    await expect(act(async () => completion)).resolves.toBe(false);
    expect(session().activePath).toBe('/workspace/notes.md');
    expect(session().content).toBe('# Newer edit');
    expect(session().dirty).toBe(true);
  });

  it('locks initial indeterminate saves and never schedules another autosave', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockResolvedValueOnce({
      status: 'indeterminate', path: '/workspace/notes.md', message: 'Inspect before retrying.',
    });
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={250} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Dirty'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(session().authorityStatus).toBe('unknown');
    expect(session().dirty).toBe(true);
    await expect(session().saveCurrentDocument()).resolves.toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => session().handleSave());
    expect(tauriMocks.writeFile).toHaveBeenCalledOnce();
  });

  it('stops autosave after a conflict until the content changes', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockResolvedValue({ status: 'conflict', path: '/workspace/notes.md', message: 'changed' });
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={250} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Conflict'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(session().saveConflict).not.toBeNull();
    act(() => session().handleCancelSaveConflict());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(tauriMocks.writeFile).toHaveBeenCalledOnce();
  });

  it('retains dirty content and does not loop autosave after transport failure', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.writeFile.mockRejectedValue(new Error('transport failed'));
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={250} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Offline'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(session().dirty).toBe(true);
    expect(session().error).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(tauriMocks.writeFile).toHaveBeenCalledOnce();
  });

  it('cancels a pending autosave when Save As commits the document', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.saveAsDialog.mockResolvedValueOnce({
      status: 'confirmed_committed', path: '/workspace/copy.md',
      version: { ...fileVersion, canonicalPath: '/workspace/copy.md' },
    });
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={500} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Save As'));
    await act(async () => session().handleSaveAs());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(session().activePath).toBe('/workspace/copy.md');
  });

  it('cancels a pending autosave when another document wins the switch', async () => {
    vi.useFakeTimers();
    tauriMocks.openFileDialog
      .mockResolvedValueOnce(preparedOpen('first'))
      .mockResolvedValueOnce(preparedOpen('second'));
    act(() => root.render(<SessionHarness autosaveEnabled autosaveDelayMs={500} />));
    await act(async () => session().handleOpenFile());
    act(() => session().updateContent('# Before switch'));
    await act(async () => session().handleOpenFile());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(session().activePath).toBe('/workspace/second.md');
  });

  it('updates the expected version path after an active file rename', async () => {
    const workspace = workspaceSnapshot([{
      kind: 'markdown', path: '/workspace/notes.md', relative_path: 'notes.md', name: 'notes.md',
    }]);
    tauriMocks.openDirectoryDialog.mockResolvedValueOnce(workspace);
    tauriMocks.openFileDialog.mockResolvedValueOnce(preparedOpen('notes'));
    tauriMocks.renameWorkspaceEntry.mockResolvedValueOnce({
      status: 'confirmed-committed',
      receipt: {
        committed: { entry_kind: 'file', old_path: '/workspace/notes.md', new_path: '/workspace/renamed.md' },
        workspace: { status: 'fresh', snapshot: { ...workspace, files: [] } },
      },
    });
    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenDirectory());
    await act(async () => session().handleOpenFile());
    await act(async () => session().renameWorkspaceEntryPath('/workspace/notes.md', 'renamed.md'));
    act(() => session().updateContent('# Renamed edit'));
    await act(async () => session().handleSave());
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      '/workspace/renamed.md',
      '# Renamed edit',
      { ...fileVersion, canonicalPath: '/workspace/renamed.md' },
      expect.stringMatching(/^document-save-/),
    );
  });

  it('blocks editor-popout mutation publication while its authoritative snapshot is provisional', async () => {
    act(() => root.render(<SessionHarness isPopout popoutPane="editor" />));
    const replication = paneMocks.instances[0];
    if (!replication) throw new Error('Expected an editor-popout replication port');
    const provisional = provisionalPaneSnapshot();

    act(() => replication.options.observe(provisional));
    expect(session().authorityStatus).toBe('provisional');

    await act(async () => {
      session().updateContent('# Escaped popout mutation');
      await Promise.all([session().handleSave(), session().handleSaveAs()]);
    });

    expect(session().content).toBe('# Provisional');
    expect(replication.publishEditorContent).not.toHaveBeenCalled();
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(tauriMocks.saveAsDialog).not.toHaveBeenCalled();

    act(() => replication.options.observe({
      ...provisional,
      revision: 2,
      state: { ...provisional.state, authorityStatus: 'committed' },
    }));
    act(() => session().updateContent('# Committed popout mutation'));

    expect(session().content).toBe('# Committed popout mutation');
    expect(replication.publishEditorContent).toHaveBeenCalledWith('# Committed popout mutation');
  });

  it.each(['normal', 'recent'] as const)(
    'restores the complete dirty prior snapshot after a same-generation %s not_committed result',
    async (kind) => {
      const priorOpen = preparedOpen('prior-html', {
        kind: 'html',
        path: '/workspace/prior.html',
        content_mode: 'text',
        content: '<h1>Saved prior</h1>',
        file_version: fileVersion,
        mime_type: 'text/html',
      });
      tauriMocks.openFileDialog.mockResolvedValueOnce(priorOpen);

      act(() => root.render(<SessionHarness />));
      await act(async () => session().handleOpenFile());
      act(() => session().updateContent('<h1>Dirty prior</h1>'));
      const prior = documentSnapshot(session());
      expect(prior.dirty).toBe(true);

      const rejectedOpen = preparedOpen(`${kind}-rejected`);
      if (kind === 'normal') tauriMocks.openFileDialog.mockResolvedValueOnce(rejectedOpen);
      else tauriMocks.openRecentFile.mockResolvedValueOnce(rejectedOpen);
      tauriMocks.commitRecentOpen.mockResolvedValueOnce({
        status: 'not_committed',
        message: 'The prepared open could not be committed.',
      });

      await act(async () => {
        if (kind === 'normal') await session().handleOpenFile();
        else await session().handleOpenRecent('recent-rejected');
      });

      expect(documentSnapshot(session())).toEqual(prior);
      expect(session().error).toBe('The prepared open could not be committed.');
      expect(restoreDocumentSnapshotMock).toHaveBeenCalledOnce();
    },
  );

  it('falls back to failed authority and remains read-only when prior restoration throws', async () => {
    const rejectedOpen = preparedOpen('restore-failed');
    tauriMocks.openFileDialog.mockResolvedValueOnce(rejectedOpen);
    tauriMocks.commitRecentOpen.mockResolvedValueOnce({
      status: 'not_committed',
      message: 'The prepared open could not be committed.',
    });
    restoreDocumentSnapshotMock.mockImplementationOnce(() => {
      throw new Error('injected restoration failure');
    });

    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());

    expect(documentSnapshot(session())).toMatchObject({
      activePath: rejectedOpen.file.path,
      authorityStatus: 'failed',
      content: rejectedOpen.file.content,
      dirty: false,
    });

    await act(async () => {
      session().updateContent('# Escaped failed-state mutation');
      await Promise.all([session().handleSave(), session().handleSaveAs()]);
    });

    expect(session().content).toBe(rejectedOpen.file.content);
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(tauriMocks.saveAsDialog).not.toHaveBeenCalled();
    expect(session().error).toBe('The prepared open could not be committed.');
  });

  it('stays provisional through pending reconciliation and becomes unknown/read-only when unresolved', async () => {
    vi.useFakeTimers();
    const prepared = preparedOpen('unknown-result');
    tauriMocks.openFileDialog.mockResolvedValueOnce(prepared);
    tauriMocks.commitRecentOpen.mockRejectedValueOnce(new Error('commit response lost'));
    tauriMocks.getOpenCommitStatus
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'unknown' });

    act(() => root.render(<SessionHarness />));
    const { completion: openPromise } = await beginOpen('normal');

    expect(session().authorityStatus).toBe('provisional');
    expect(tauriMocks.getOpenCommitStatus).toHaveBeenCalledOnce();
    await act(async () => {
      session().updateContent('# Escaped pending mutation');
      await session().handleSaveAs();
    });
    expect(session().content).toBe(prepared.file.content);
    expect(tauriMocks.saveAsDialog).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await openPromise;
    });

    expect(session().authorityStatus).toBe('unknown');
    expect(session().error).toBe(
      'The file authorization result could not be confirmed. Open another file to continue.',
    );
    await act(async () => {
      session().updateContent('# Escaped unknown mutation');
      await Promise.all([session().handleSave(), session().handleSaveAs()]);
    });
    expect(session().content).toBe(prepared.file.content);
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(tauriMocks.saveAsDialog).not.toHaveBeenCalled();
  });

  it('does not let an older completion restore over a newer winning document generation', async () => {
    const commit = deferred<OpenCommitResult>();
    const olderOpen = preparedOpen('older-open');
    tauriMocks.openFileDialog.mockResolvedValueOnce(olderOpen);
    tauriMocks.commitRecentOpen.mockReturnValueOnce(commit.promise);

    act(() => root.render(<SessionHarness />));
    act(() => session().updateContent('# Dirty prior'));
    const { completion: olderPromise } = await beginOpen('normal');
    expect(session().authorityStatus).toBe('provisional');

    await act(async () => session().handleNew());
    act(() => session().updateContent('# Newer winner'));
    const newer = documentSnapshot(session());
    expect(newer).toMatchObject({
      activePath: null,
      authorityStatus: 'committed',
      content: '# Newer winner',
      dirty: true,
    });

    commit.resolve({
      status: 'not_committed',
      message: 'The older open could not be committed.',
    });
    await act(async () => olderPromise);

    expect(documentSnapshot(session())).toEqual(newer);
    expect(session().error).toBeNull();
    expect(restoreDocumentSnapshotMock).not.toHaveBeenCalled();
  });

  it('restores the main workspace before committing its prepared active document', async () => {
    enableTauriRuntime();
    const restored = preparedOpen('restored');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: restored.file.path,
        relative_path: 'restored.md',
        name: 'restored.md',
      }]),
      active_file: restored,
    });

    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();

    expect(session()).toMatchObject({
      workspaceRoot: '/workspace',
      activePath: '/workspace/restored.md',
      authorityStatus: 'committed',
      content: '# restored',
    });
    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledWith('session-restore-intent');
    expect(tauriMocks.commitRecentOpen).toHaveBeenCalledWith(restored.open_receipt);
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      restored.file.path,
    );
  });

  it('does not restore on mount and restores once when explicitly requested', async () => {
    enableTauriRuntime();
    const restored = preparedOpen('restored-session');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: restored.file.path,
        relative_path: 'restored-session.md',
        name: 'restored-session.md',
      }]),
      active_file: restored,
    });

    act(() => root.render(<SessionHarness />));
    await flushSessionEffects();

    expect(tauriMocks.resolveOpenIntent).not.toHaveBeenCalled();
    expect(session().workspaceRoot).toBeNull();
    expect(session().workspaceSessionRestoreSettled).toBe(false);
    await requestWorkspaceSessionRestore();

    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledOnce();
    expect(session()).toMatchObject({
      activePath: restored.file.path,
      authorityStatus: 'committed',
      content: restored.file.content,
      workspaceSessionRestoreSettled: true,
    });
  });

  it('applies a resolved file open intent through the prepared-open commit flow', async () => {
    const opened = preparedOpen('native-open');
    tauriMocks.resolveOpenIntent.mockResolvedValueOnce({ kind: 'file', prepared: opened });

    act(() => root.render(<SessionHarness />));
    let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
    await act(async () => {
      outcome = await session().resolveOpenIntentRequest('open-intent-1');
    });

    expect(outcome).toBe('accepted');
    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledWith('open-intent-1');
    expect(tauriMocks.commitRecentOpen).toHaveBeenCalledWith(opened.open_receipt);
    expect(session()).toMatchObject({
      activePath: opened.file.path,
      authorityStatus: 'committed',
      content: opened.file.content,
    });
  });

  it('does not accept a resolved file whose prepared authorization cannot commit', async () => {
    const afterConfirmedSave = vi.fn<(documentId: string) => Promise<boolean>>(async () => true);
    const opened = preparedOpen('native-rejected');
    tauriMocks.resolveOpenIntent.mockResolvedValueOnce({ kind: 'file', prepared: opened });
    tauriMocks.commitRecentOpen.mockResolvedValueOnce({
      status: 'not_committed',
      message: 'The prepared open was rejected.',
    });

    act(() => root.render(<SessionHarness afterConfirmedSave={afterConfirmedSave} />));
    let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
    await act(async () => {
      outcome = await session().resolveOpenIntentRequest('open-intent-rejected', 'file', true);
    });

    expect(outcome).toBe('failed');
    expect(afterConfirmedSave).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ activePath: null, authorityStatus: 'committed' });
  });

  it('applies a resolved directory open intent without replacing the current document', async () => {
    const current = preparedOpen('current');
    tauriMocks.openFileDialog.mockResolvedValueOnce(current);
    tauriMocks.resolveOpenIntent.mockResolvedValueOnce({
      kind: 'directory',
      workspace: workspaceSnapshot([{
        kind: 'markdown', path: current.file.path, relative_path: 'current.md', name: 'current.md',
      }]),
      workspace_open_receipt: 'workspace-open-directory',
    });

    act(() => root.render(<SessionHarness />));
    await act(async () => session().handleOpenFile());
    const before = documentSnapshot(session());
    let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
    await act(async () => {
      outcome = await session().resolveOpenIntentRequest('open-intent-2');
    });

    expect(outcome).toBe('accepted');
    expect(session().workspaceRoot).toBe('/workspace');
    expect(documentSnapshot(session())).toEqual(before);
    expect(tauriMocks.settleOpenIntentWorkspace).toHaveBeenCalledWith(
      'workspace-open-directory',
      true,
    );
  });

  it('rejects an applied directory whose provisional workspace receipt expired', async () => {
    tauriMocks.resolveOpenIntent.mockResolvedValueOnce({
      kind: 'directory',
      workspace: workspaceSnapshot(),
      workspace_open_receipt: 'workspace-open-expired',
    });
    tauriMocks.settleOpenIntentWorkspace.mockResolvedValueOnce('expired');

    act(() => root.render(<SessionHarness />));
    let outcome!: Awaited<ReturnType<Session['resolveOpenIntentRequest']>>;
    await act(async () => {
      outcome = await session().resolveOpenIntentRequest('open-intent-expired');
    });

    expect(outcome).toBe('failed');
    expect(session().workspaceRoot).toBeNull();
  });

  it('settles the startup gate only after the session-restore intent resolves', async () => {
    enableTauriRuntime();
    const resolution = deferred<Awaited<ReturnType<typeof import('../lib/tauriCommands').resolveOpenIntent>>>();
    tauriMocks.resolveOpenIntent.mockReturnValueOnce(resolution.promise);

    act(() => root.render(<SessionHarness />));
    let restoreRequest!: Promise<'blocked' | 'accepted' | 'failed'>;
    act(() => {
      restoreRequest = session().resolveOpenIntentRequest('session-restore-intent', 'session_restore');
    });
    await act(async () => Promise.resolve());
    expect(session().workspaceSessionRestoreSettled).toBe(false);
    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledWith('session-restore-intent');

    resolution.resolve({
      kind: 'session_restore',
      restore: null,
      workspace_open_receipt: null,
    });
    await expect(act(async () => restoreRequest)).resolves.toBe('accepted');
    await flushSessionEffects();
    expect(session().workspaceSessionRestoreSettled).toBe(true);
  });

  it('discards a file receipt when a newer open intent supersedes it', async () => {
    const first = deferred<Awaited<ReturnType<typeof import('../lib/tauriCommands').resolveOpenIntent>>>();
    const older = preparedOpen('older-native');
    const newer = preparedOpen('newer-native');
    tauriMocks.resolveOpenIntent
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'file', prepared: newer });

    act(() => root.render(<SessionHarness />));
    let olderOutcome!: Promise<'blocked' | 'accepted' | 'failed'>;
    let newerOutcome!: Promise<'blocked' | 'accepted' | 'failed'>;
    act(() => {
      olderOutcome = session().resolveOpenIntentRequest('open-intent-4');
      newerOutcome = session().resolveOpenIntentRequest('open-intent-5');
    });
    first.resolve({ kind: 'file', prepared: older });

    await expect(act(async () => olderOutcome)).resolves.toBe('failed');
    await expect(act(async () => newerOutcome)).resolves.toBe('accepted');
    expect(tauriMocks.discardOpenReceipt).toHaveBeenCalledWith(older.open_receipt);
    expect(session().activePath).toBe(newer.file.path);
  });

  it('discards both provisional receipts when a session restore becomes stale', async () => {
    const first = deferred<Awaited<ReturnType<typeof import('../lib/tauriCommands').resolveOpenIntent>>>();
    const restored = preparedOpen('stale-restored-file');
    const newer = preparedOpen('newer-after-restore');
    tauriMocks.resolveOpenIntent
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'file', prepared: newer });

    act(() => root.render(<SessionHarness />));
    let olderOutcome!: Promise<'blocked' | 'accepted' | 'failed'>;
    let newerOutcome!: Promise<'blocked' | 'accepted' | 'failed'>;
    act(() => {
      olderOutcome = session().resolveOpenIntentRequest('open-intent-6', 'session_restore');
      newerOutcome = session().resolveOpenIntentRequest('open-intent-7');
    });
    first.resolve({
      kind: 'session_restore',
      restore: { workspace: workspaceSnapshot(), active_file: restored },
      workspace_open_receipt: 'workspace-open-6',
    });

    await expect(act(async () => olderOutcome)).resolves.toBe('failed');
    await expect(act(async () => newerOutcome)).resolves.toBe('accepted');
    expect(tauriMocks.discardOpenReceipt).toHaveBeenCalledWith(restored.open_receipt);
    expect(tauriMocks.settleOpenIntentWorkspace).toHaveBeenCalledWith('workspace-open-6', false);
  });

  it('keeps a restored workspace and silently clears an active file whose receipt cannot commit', async () => {
    enableTauriRuntime();
    const restored = preparedOpen('restore-rejected');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: restored.file.path,
        relative_path: 'restore-rejected.md',
        name: 'restore-rejected.md',
      }]),
      active_file: restored,
    });
    tauriMocks.commitRecentOpen.mockResolvedValueOnce({
      status: 'not_committed',
      message: 'The restored receipt could not be committed.',
    });

    act(() => root.render(<SessionHarness />));
    const outcome = await requestWorkspaceSessionRestore();
    await flushSessionEffects();

    expect(session()).toMatchObject({
      workspaceRoot: '/workspace',
      activePath: null,
      authorityStatus: 'committed',
      error: null,
    });
    expect(outcome).toBe('failed');
    expect(tauriMocks.settleOpenIntentWorkspace).toHaveBeenCalledWith(
      'workspace-open-restore',
      true,
    );
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      null,
    );
  });

  it('settles a missing session to a blank main pane and does not restore or persist in popouts', async () => {
    enableTauriRuntime();
    mockWorkspaceSessionRestore(null);

    act(() => root.render(<SessionHarness isPopout popoutPane="editor" />));
    await flushSessionEffects();

    expect(session()).toMatchObject({
      workspaceRoot: null,
      activePath: null,
      content: EMPTY_MARKDOWN,
    });
    expect(tauriMocks.resolveOpenIntent).not.toHaveBeenCalled();
    expect(tauriMocks.persistWorkspaceSession).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    currentSession = null;
    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();

    expect(session()).toMatchObject({ workspaceRoot: null, activePath: null });
    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledOnce();
    expect(tauriMocks.persistWorkspaceSession).not.toHaveBeenCalled();
  });

  it('persists null for an active document outside the restored workspace', async () => {
    enableTauriRuntime();
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: '/workspace/notes.md',
        relative_path: 'notes.md',
        name: 'notes.md',
      }]),
      active_file: null,
    });
    tauriMocks.openFileDialog.mockResolvedValue(preparedOpen('outside', {
      kind: 'markdown',
      path: '/outside/notes.md',
      content_mode: 'text',
      content: '# Outside',
      file_version: fileVersion,
    }));

    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();
    await act(async () => session().handleOpenFile());
    await flushSessionEffects();

    expect(session().activePath).toBe('/outside/notes.md');
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      null,
    );
  });

  it('blocks user document actions until a pending session restore settles', async () => {
    enableTauriRuntime();
    const resolution = deferred<Awaited<ReturnType<typeof import('../lib/tauriCommands').resolveOpenIntent>>>();
    tauriMocks.resolveOpenIntent.mockReturnValue(resolution.promise);

    act(() => root.render(<SessionHarness />));
    let restoreRequest!: Promise<'blocked' | 'accepted' | 'failed'>;
    act(() => {
      restoreRequest = session().resolveOpenIntentRequest('session-restore-intent', 'session_restore');
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => session().handleOpenDirectory());
    act(() => session().updateContent('# Typed before restore'));
    expect(tauriMocks.openDirectoryDialog).not.toHaveBeenCalled();
    expect(session().content).toBe(EMPTY_MARKDOWN);

    resolution.resolve({
      kind: 'session_restore',
      restore: {
        workspace: workspaceSnapshot(),
        active_file: null,
      },
      workspace_open_receipt: 'workspace-open-blocked-actions',
    });
    await act(async () => restoreRequest);
    await flushSessionEffects();

    expect(session().workspaceRoot).toBe('/workspace');
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      null,
    );
  });

  it('restores only once when StrictMode replays effects', async () => {
    enableTauriRuntime();
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot(),
      active_file: null,
    });

    act(() => root.render(
      <StrictMode>
        <SessionHarness />
      </StrictMode>,
    ));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();

    expect(tauriMocks.resolveOpenIntent).toHaveBeenCalledOnce();
    expect(session().workspaceRoot).toBe('/workspace');
  });

  it('serializes workspace persistence so the newest committed file wins', async () => {
    enableTauriRuntime();
    const firstPersist = deferred<void>();
    const opened = preparedOpen('notes');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: opened.file.path,
        relative_path: 'notes.md',
        name: 'notes.md',
      }]),
      active_file: null,
    });
    tauriMocks.persistWorkspaceSession
      .mockReturnValueOnce(firstPersist.promise)
      .mockResolvedValueOnce(undefined);
    tauriMocks.openWorkspaceFile.mockResolvedValue(opened);

    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenCalledOnce();
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      null,
    );

    await act(async () => session().openWorkspaceFilePath(opened.file.path));
    await flushSessionEffects();
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenCalledOnce();

    firstPersist.resolve(undefined);
    await flushSessionEffects();
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenCalledTimes(2);
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      opened.file.path,
    );
  });

  it('flushes the latest committed workspace snapshot before the program closes', async () => {
    enableTauriRuntime();
    const firstPersist = deferred<void>();
    const opened = preparedOpen('closing');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([{
        kind: 'markdown',
        path: opened.file.path,
        relative_path: 'closing.md',
        name: 'closing.md',
      }]),
      active_file: null,
    });
    tauriMocks.persistWorkspaceSession
      .mockReturnValueOnce(firstPersist.promise)
      .mockResolvedValue(undefined);
    tauriMocks.openWorkspaceFile.mockResolvedValue(opened);

    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      null,
    );

    await act(async () => session().openWorkspaceFilePath(opened.file.path));
    let flush!: Promise<void>;
    await act(async () => {
      flush = session().flushWorkspaceSession();
      await Promise.resolve();
    });
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenCalledOnce();

    firstPersist.resolve(undefined);
    await act(async () => flush);

    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      opened.file.path,
    );
  });

  it('keeps the previously committed workspace file while a new prepared open is pending', async () => {
    enableTauriRuntime();
    const previous = preparedOpen('previous');
    const commit = deferred<OpenCommitResult>();
    const pending = preparedOpen('pending');
    mockWorkspaceSessionRestore({
      workspace: workspaceSnapshot([
        {
          kind: 'markdown',
          path: previous.file.path,
          relative_path: 'previous.md',
          name: 'previous.md',
        },
        {
          kind: 'markdown',
          path: pending.file.path,
          relative_path: 'pending.md',
          name: 'pending.md',
        },
      ]),
      active_file: previous,
    });
    tauriMocks.openWorkspaceFile.mockResolvedValue(pending);

    act(() => root.render(<SessionHarness />));
    await requestWorkspaceSessionRestore();
    await flushSessionEffects();

    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      previous.file.path,
    );
    const persistedBeforePendingOpen = tauriMocks.persistWorkspaceSession.mock.calls.length;
    tauriMocks.commitRecentOpen.mockReturnValueOnce(commit.promise);

    let completion!: Promise<void>;
    await act(async () => {
      completion = session().openWorkspaceFilePath(pending.file.path);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushSessionEffects();

    expect(session().authorityStatus).toBe('provisional');
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenCalledTimes(persistedBeforePendingOpen);
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      previous.file.path,
    );

    commit.resolve(committed());
    await act(async () => completion);
    await flushSessionEffects();

    expect(session().authorityStatus).toBe('committed');
    expect(tauriMocks.persistWorkspaceSession).toHaveBeenLastCalledWith(
      'restored-workspace-token',
      '/workspace',
      pending.file.path,
    );
  });
});
