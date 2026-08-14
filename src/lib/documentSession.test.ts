import { describe, expect, it, vi } from 'vitest';
import type {
  DeleteWorkspaceEntryResponse,
  MutationOutcome,
  OpenCommitResult,
  OpenCommitStatus,
  PreparedOpenFileResponse,
  RenameWorkspaceEntryResponse,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from '../types';
import {
  applyWorkspaceSelection,
  createProvisionalDocumentTransition,
  createDocumentSaveOperationId,
  createWorkspaceDirectoryAndReconcile,
  deleteWorkspaceEntryAndReconcile,
  getEditableFileKindForPath,
  getOpenedDocumentState,
  getMutationOutcomeMessage,
  getWorkspaceDirectoryListingState,
  finalizeProvisionalDocument,
  isCurrentWorkspaceIdentity,
  isDocumentDirty,
  nextPreparedOpenGeneration,
  moveWorkspaceEntryAndReconcile,
  renameWorkspaceEntryAndReconcile,
  restoreDocumentSnapshot,
  reconcileWorkspaceReceipt,
  resolveOpenCommitOutcome,
} from './documentSession';

const fileVersion = {
  canonicalPath: '/workspace/notes.md', platformIdentity: '1', length: '7', modifiedNanos: '1', sha256: 'c'.repeat(64),
};

describe('document session state', () => {
  const preparedOpen: PreparedOpenFileResponse = {
    file: {
      kind: 'markdown',
      path: '/workspace/opened.md',
      content_mode: 'text',
      content: '# Opened',
      file_version: fileVersion,
    },
    open_receipt: '11111111111111111111111111111111',
    commit_operation_id: '22222222222222222222222222222222',
  };

  it('creates fresh bounded save operation identifiers', () => {
    const first = createDocumentSaveOperationId();
    const second = createDocumentSaveOperationId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^document-save-[a-z0-9]+-[a-z0-9]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it('advances document generation only for a prepared winner', () => {
    expect(nextPreparedOpenGeneration(4, 4, preparedOpen)).toBe(5);
    expect(nextPreparedOpenGeneration(4, 4, null)).toBeNull();
    expect(nextPreparedOpenGeneration(5, 4, preparedOpen)).toBeNull();
  });

  it('preserves an exact prior snapshot while a prepared open is provisional', () => {
    const current = {
      documentId: 'document-old',
      documentEpoch: 7,
      authorityStatus: 'committed' as const,
      activeFileKind: 'markdown' as const,
      activeMimeType: null,
      activePath: '/workspace/draft.md',
      bytesBase64: null,
      content: '# Dirty draft',
      lastSavedContent: '# Saved draft',
      previewRevision: 0,
    };

    const transition = createProvisionalDocumentTransition(
      current,
      {
        kind: 'html',
        path: '/workspace/page.html',
        content_mode: 'text',
        content: '<h1>Page</h1>',
        file_version: fileVersion,
        mime_type: 'text/html',
      },
      { documentId: 'document-new', documentEpoch: 8 },
    );

    expect(transition.prior).toEqual(current);
    expect(transition.provisional).toEqual({
      documentId: 'document-new',
      documentEpoch: 8,
      authorityStatus: 'provisional',
      activeFileKind: 'html',
      activeMimeType: 'text/html',
      activePath: '/workspace/page.html',
      bytesBase64: null,
      content: '<h1>Page</h1>',
      lastSavedContent: '<h1>Page</h1>',
      previewRevision: 0,
    });
    expect(finalizeProvisionalDocument(transition.provisional)).toEqual({
      ...transition.provisional,
      authorityStatus: 'committed',
    });
    expect(restoreDocumentSnapshot(transition.prior)).toEqual(current);
    expect(restoreDocumentSnapshot(transition.prior)).not.toBe(transition.prior);
  });

  it('accepts a direct terminal open commit result without querying status', async () => {
    const commit = vi.fn<(openReceipt: string) => Promise<OpenCommitResult>>(async () => ({
      status: 'committed' as const,
      recent_files: { entries: [] },
    }));
    const getStatus = vi.fn<(commitOperationId: string) => Promise<OpenCommitStatus>>();

    await expect(resolveOpenCommitOutcome(preparedOpen, { commit, getStatus }))
      .resolves.toEqual({ status: 'committed', recent_files: { entries: [] } });
    expect(commit).toHaveBeenCalledWith(preparedOpen.open_receipt);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('reconciles a lost commit response by the operation id', async () => {
    const commit = vi.fn<(openReceipt: string) => Promise<OpenCommitResult>>(async () => {
      throw new Error('IPC response lost');
    });
    const getStatus = vi.fn<(commitOperationId: string) => Promise<OpenCommitStatus>>(async () => ({
      status: 'not_committed' as const,
      message: 'The file could not be committed.',
    }));

    await expect(resolveOpenCommitOutcome(preparedOpen, { commit, getStatus }))
      .resolves.toEqual({
        status: 'not_committed',
        message: 'The file could not be committed.',
      });
    expect(getStatus).toHaveBeenCalledWith(preparedOpen.commit_operation_id);
  });

  it('retries pending commit status within a fixed bound', async () => {
    const commit = vi.fn<(openReceipt: string) => Promise<OpenCommitResult>>(async () => {
      throw new Error('IPC response lost');
    });
    const getStatus = vi.fn<(commitOperationId: string) => Promise<OpenCommitStatus>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'committed', recent_files: { entries: [] } });
    const waitBeforeRetry = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(resolveOpenCommitOutcome(preparedOpen, {
      commit,
      getStatus,
      waitBeforeRetry,
    })).resolves.toEqual({ status: 'committed', recent_files: { entries: [] } });
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });

  it('returns unknown instead of guessing after pending status exceeds the retry bound', async () => {
    const commit = vi.fn<(openReceipt: string) => Promise<OpenCommitResult>>(async () => {
      throw new Error('IPC response lost');
    });
    const getStatus = vi.fn<(commitOperationId: string) => Promise<OpenCommitStatus>>(
      async () => ({ status: 'pending' }),
    );
    const waitBeforeRetry = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(resolveOpenCommitOutcome(preparedOpen, {
      commit,
      getStatus,
      waitBeforeRetry,
    })).resolves.toEqual({ status: 'unknown' });
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });

  it('returns unknown when commit status reconciliation is unavailable', async () => {
    const commit = vi.fn<(openReceipt: string) => Promise<OpenCommitResult>>(async () => {
      throw new Error('IPC response lost');
    });
    const getStatus = vi.fn<(commitOperationId: string) => Promise<OpenCommitStatus>>(async () => {
      throw new Error('status unavailable');
    });

    await expect(resolveOpenCommitOutcome(preparedOpen, { commit, getStatus }))
      .resolves.toEqual({ status: 'unknown' });
  });

  it('advances_workspace_generation_only_after_a_directory_is_selected', () => {
    const snapshot: WorkspaceSnapshot = {
      workspace_token: 'workspace-8',
      root: '/selected',
      files: [],
      directories: [],
    };
    const events: string[] = [];

    expect(applyWorkspaceSelection(null, {
      advanceGeneration: () => events.push('generation:advanced'),
      applySnapshot: () => events.push('snapshot:applied'),
    })).toBe(false);
    expect(events).toEqual([]);

    expect(applyWorkspaceSelection(snapshot, {
      advanceGeneration: () => events.push('generation:advanced'),
      applySnapshot: (selected) => events.push(`snapshot:${selected.root}`),
    })).toBe(true);
    expect(events).toEqual(['generation:advanced', 'snapshot:/selected']);
  });

  it('extracts_global_mutation_warnings_before_generation_gates_state_application', () => {
    expect(getMutationOutcomeMessage({
      status: 'indeterminate',
      operation: 'write',
      paths: ['/workspace/draft.md'],
      recovery_message: 'Reopen and inspect the file before retrying.',
    })).toBe('Reopen and inspect the file before retrying.');
    expect(getMutationOutcomeMessage({
      status: 'confirmed-not-committed',
      message: 'Nothing changed.',
    })).toBe('Nothing changed.');
    expect(getMutationOutcomeMessage({
      status: 'confirmed-committed',
      receipt: {
        committed: { path: '/workspace/draft.md' },
        workspace: { status: 'not-applicable' },
      },
    })).toBeNull();
  });

  it('opens image files as clean read-only documents without editor content', () => {
    const state = getOpenedDocumentState({
      kind: 'image',
      path: '/workspace/assets/cover.png',
      content_mode: 'binary',
      mime_type: 'image/png',
    });

    expect(state).toEqual({
      activeFileKind: 'image',
      activeMimeType: 'image/png',
      activePath: '/workspace/assets/cover.png',
      bytesBase64: null,
      content: '',
      lastSavedContent: '',
      previewRevision: 0,
    });
    expect(isDocumentDirty(state)).toBe(false);
  });

  it('opens HTML source as an editable document with render metadata', () => {
    const state = getOpenedDocumentState({
      kind: 'html',
      path: '/workspace/site/index.html',
      content_mode: 'text',
      content: '<h1>Hello</h1>',
      file_version: fileVersion,
      mime_type: 'text/html',
    });

    expect(state).toEqual({
      activeFileKind: 'html',
      activeMimeType: 'text/html',
      activePath: '/workspace/site/index.html',
      bytesBase64: null,
      content: '<h1>Hello</h1>',
      lastSavedContent: '<h1>Hello</h1>',
      previewRevision: 0,
    });
    expect(isDocumentDirty({ ...state, content: '<h1>Changed</h1>' })).toBe(true);
  });

  it('marks only editable document kinds dirty when content differs', () => {
    expect(isDocumentDirty({ activeFileKind: 'markdown', content: '# Changed', lastSavedContent: '# Saved' })).toBe(true);
    expect(isDocumentDirty({ activeFileKind: 'html', content: '<p>Changed</p>', lastSavedContent: '<p>Saved</p>' })).toBe(true);

    for (const activeFileKind of ['image', 'video', 'audio', 'pdf', 'docx'] as const) {
      expect(isDocumentDirty({ activeFileKind, content: 'changed', lastSavedContent: 'saved' })).toBe(false);
    }
  });

  it('derives the editable preview mode after save-as', () => {
    expect(getEditableFileKindForPath('/workspace/page.HTML')).toBe('html');
    expect(getEditableFileKindForPath('/workspace/page.xhtml')).toBe('html');
    expect(getEditableFileKindForPath('/workspace/notes.md')).toBe('markdown');
  });

  it('legacy directory listings preserve the active workspace identity', () => {
    const activeWorkspace = {
      workspaceToken: 'workspace-inner',
      workspaceRoot: '/workspace/inner',
      files: [
        {
          kind: 'markdown' as const,
          path: '/workspace/inner/current.md',
          relative_path: 'current.md',
          name: 'current.md',
        },
      ],
      directories: [],
    };
    const listing = {
      root: '/workspace',
      files: [
        {
          kind: 'markdown' as const,
          path: '/workspace/outer.md',
          relative_path: 'outer.md',
          name: 'outer.md',
        },
      ],
      directories: [],
    };

    const update = getWorkspaceDirectoryListingState(activeWorkspace.workspaceRoot, listing);

    expect(update).toBeNull();
    expect(update ? { ...activeWorkspace, ...update } : activeWorkspace).toEqual(activeWorkspace);
  });

  it('applies fresh receipts without refresh and repairs matching stale receipts once', async () => {
    const snapshot = {
      workspace_token: 'workspace-inner',
      root: '/workspace/inner',
      files: [],
      directories: [],
    };
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(reconcileWorkspaceReceipt(
      'workspace-inner',
      { status: 'fresh', snapshot },
      { workspaceRoot: '/workspace/inner', applySnapshot, refresh },
    )).resolves.toBeNull();
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();

    applySnapshot.mockClear();
    await expect(reconcileWorkspaceReceipt(
      'workspace-inner',
      {
        status: 'stale',
        workspace_token: 'workspace-inner',
        repair_reason: 'injected post-commit snapshot failure',
      },
      { workspaceRoot: '/workspace/inner', applySnapshot, refresh },
    )).resolves.toBeNull();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();

    refresh.mockClear();
    await expect(reconcileWorkspaceReceipt(
      'workspace-inner',
      {
        status: 'stale',
        workspace_token: 'workspace-outer',
        repair_reason: 'wrong workspace',
      },
      { workspaceRoot: '/workspace/inner', applySnapshot, refresh },
    )).resolves.toBe('Workspace mutation receipt does not match the active workspace');
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a fresh receipt whose root does not match the active workspace', async () => {
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(reconcileWorkspaceReceipt(
      'workspace-inner',
      {
        status: 'fresh',
        snapshot: {
          workspace_token: 'workspace-inner',
          root: '/workspace/outer',
          files: [],
          directories: [],
        },
      },
      {
        workspaceRoot: '/workspace/inner',
        applySnapshot,
        refresh,
      },
    )).resolves.toBe('Workspace mutation receipt does not match the active workspace');
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a mutation response after the active workspace changes', () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-a',
      workspaceRoot: '/workspace/a',
    };

    expect(isCurrentWorkspaceIdentity(
      { workspaceToken: 'workspace-b', workspaceRoot: '/workspace/b' },
      requestedWorkspace,
    )).toBe(false);
    expect(isCurrentWorkspaceIdentity(requestedWorkspace, requestedWorkspace)).toBe(true);
  });

  it('repairs a stale create-directory receipt exactly once', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const createDirectory = vi.fn<() => Promise<MutationOutcome<WorkspaceMutation>>>(async () => ({
      status: 'confirmed-committed' as const,
      receipt: {
        committed: { path: '/workspace/notes' },
        workspace: {
          status: 'stale' as const,
          workspace_token: 'workspace-7',
          repair_reason: 'injected post-commit snapshot failure',
        },
      },
    }));
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(createWorkspaceDirectoryAndReconcile(
      requestedWorkspace,
      '/workspace',
      'notes',
      {
        createDirectory,
        getCurrentWorkspace: () => requestedWorkspace,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(createDirectory).toHaveBeenCalledOnce();
    expect(createDirectory).toHaveBeenCalledWith('workspace-7', '/workspace', 'notes');
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('applies a committed directory rename before repairing its stale receipt exactly once', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const renameEntry = vi.fn<() => Promise<MutationOutcome<RenameWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: {
          entry_kind: 'directory',
          old_path: '/workspace/drafts',
          new_path: '/workspace/archive',
        },
        workspace: {
          status: 'stale',
          workspace_token: 'workspace-7',
          repair_reason: 'injected post-commit snapshot failure',
        },
      },
    }));
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    let activePath: string | null = '/workspace/drafts/nested/note.md';
    const events: string[] = [];
    const refresh = vi.fn<() => Promise<void>>(async () => {
      events.push(`refresh:${activePath}`);
    });

    await expect(renameWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/drafts',
      'archive',
      {
        renameEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => activePath,
        setActivePath: (path) => {
          activePath = path;
          events.push(`active:${path}`);
        },
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(renameEntry).toHaveBeenCalledOnce();
    expect(renameEntry).toHaveBeenCalledWith('workspace-7', '/workspace/drafts', 'archive');
    expect(activePath).toBe('/workspace/archive/nested/note.md');
    expect(events).toEqual([
      'active:/workspace/archive/nested/note.md',
      'refresh:/workspace/archive/nested/note.md',
    ]);
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('moves an active descendant before repairing a stale workspace receipt', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const moveEntry = vi.fn<() => Promise<MutationOutcome<RenameWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: {
          entry_kind: 'directory',
          old_path: '/workspace/drafts',
          new_path: '/workspace/archive/drafts',
        },
        workspace: {
          status: 'stale',
          workspace_token: 'workspace-7',
          repair_reason: 'injected post-commit snapshot failure',
        },
      },
    }));
    let activePath: string | null = '/workspace/drafts/nested/note.md';
    const events: string[] = [];

    await expect(moveWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/drafts',
      '/workspace/archive',
      {
        moveEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => activePath,
        setActivePath: (path) => {
          activePath = path;
          events.push(`active:${path}`);
        },
        applySnapshot: vi.fn<(snapshot: WorkspaceSnapshot) => void>(),
        refresh: vi.fn<() => Promise<void>>(async () => {
          events.push(`refresh:${activePath}`);
        }),
      },
    )).resolves.toBeNull();

    expect(moveEntry).toHaveBeenCalledWith(
      'workspace-7',
      '/workspace/drafts',
      '/workspace/archive',
    );
    expect(activePath).toBe('/workspace/archive/drafts/nested/note.md');
    expect(events).toEqual([
      'active:/workspace/archive/drafts/nested/note.md',
      'refresh:/workspace/archive/drafts/nested/note.md',
    ]);
  });

  it('clears an active descendant before repairing a committed stale delete exactly once', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const deleteEntry = vi.fn<() => Promise<MutationOutcome<DeleteWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: { deleted_path: '/workspace/drafts' },
        workspace: {
          status: 'stale',
          workspace_token: 'workspace-7',
          repair_reason: 'injected post-commit snapshot failure',
        },
      },
    }));
    let activePath: string | null = '/workspace/drafts/nested/note.md';
    const events: string[] = [];
    const clearActiveDocument = vi.fn<() => void>(() => {
      activePath = null;
      events.push('document:cleared');
    });
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => {
      events.push(`refresh:${activePath}`);
    });

    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/drafts',
      {
        deleteEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => activePath,
        clearActiveDocument,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(deleteEntry).toHaveBeenCalledOnce();
    expect(deleteEntry).toHaveBeenCalledWith('workspace-7', '/workspace/drafts');
    expect(events).toEqual(['document:cleared', 'refresh:null']);
    expect(clearActiveDocument).toHaveBeenCalledOnce();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('applies a fresh delete snapshot without clearing an unrelated prefixed path', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const snapshot: WorkspaceSnapshot = {
      workspace_token: 'workspace-7',
      root: '/workspace',
      files: [],
      directories: [],
    };
    const deleteEntry = vi.fn<() => Promise<MutationOutcome<DeleteWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: { deleted_path: '/workspace/drafts' },
        workspace: { status: 'fresh', snapshot },
      },
    }));
    const clearActiveDocument = vi.fn<() => void>();
    const applySnapshot = vi.fn<(value: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/drafts',
      {
        deleteEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => '/workspace/drafts-old/note.md',
        clearActiveDocument,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(clearActiveDocument).not.toHaveBeenCalled();
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(applySnapshot).toHaveBeenCalledWith(snapshot);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('clears an active document before applying a fresh delete snapshot', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const snapshot: WorkspaceSnapshot = {
      workspace_token: 'workspace-7',
      root: '/workspace',
      files: [],
      directories: [],
    };
    const deleteEntry = vi.fn<() => Promise<MutationOutcome<DeleteWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: { deleted_path: '/workspace/note.md' },
        workspace: { status: 'fresh', snapshot },
      },
    }));
    const events: string[] = [];
    const clearActiveDocument = vi.fn<() => void>(() => {
      events.push('document:cleared');
    });
    const applySnapshot = vi.fn<(value: WorkspaceSnapshot) => void>(() => events.push('snapshot:applied'));
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/note.md',
      {
        deleteEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => '/workspace/note.md',
        clearActiveDocument,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(events).toEqual(['document:cleared', 'snapshot:applied']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores a committed delete response after the active workspace changes', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-old',
      workspaceRoot: '/workspace/old',
    };
    const deleteEntry = vi.fn<() => Promise<MutationOutcome<DeleteWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: { deleted_path: '/workspace/old/drafts' },
        workspace: {
          status: 'fresh',
          snapshot: {
            workspace_token: 'workspace-old',
            root: '/workspace/old',
            files: [],
            directories: [],
          },
        },
      },
    }));
    const clearActiveDocument = vi.fn<() => void>();
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/old/drafts',
      {
        deleteEntry,
        getCurrentWorkspace: () => ({
          workspaceToken: 'workspace-current',
          workspaceRoot: '/workspace/current',
        }),
        getActivePath: () => '/workspace/old/drafts/note.md',
        clearActiveDocument,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(deleteEntry).toHaveBeenCalledWith('workspace-old', '/workspace/old/drafts');
    expect(clearActiveDocument).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes after an indeterminate delete before returning recovery guidance', async () => {
    const requestedWorkspace = { workspaceToken: 'workspace-7', workspaceRoot: '/workspace' };
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);
    const recoveryMessage = 'Refresh and inspect the workspace before retrying.';
    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/note.md',
      {
        deleteEntry: async () => ({
          status: 'indeterminate', operation: 'delete', paths: ['/workspace/note.md'], recovery_message: recoveryMessage,
        }),
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => '/workspace/note.md',
        clearActiveDocument: vi.fn<() => void>(),
        applySnapshot: vi.fn<(snapshot: WorkspaceSnapshot) => void>(),
        refresh,
      },
    )).resolves.toBe(recoveryMessage);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh after a confirmed-not-committed delete', async () => {
    const requestedWorkspace = { workspaceToken: 'workspace-7', workspaceRoot: '/workspace' };
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);
    await expect(deleteWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/note.md',
      {
        deleteEntry: async () => ({ status: 'confirmed-not-committed', message: 'Delete rejected.' }),
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => '/workspace/note.md',
        clearActiveDocument: vi.fn<() => void>(),
        applySnapshot: vi.fn<(snapshot: WorkspaceSnapshot) => void>(),
        refresh,
      },
    )).resolves.toBe('Delete rejected.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('repairs the active path before applying a fresh rename snapshot without refresh', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-7',
      workspaceRoot: '/workspace',
    };
    const snapshot: WorkspaceSnapshot = {
      workspace_token: 'workspace-7',
      root: '/workspace',
      files: [],
      directories: [],
    };
    const renameEntry = vi.fn<() => Promise<MutationOutcome<RenameWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: {
          entry_kind: 'directory',
          old_path: '/workspace/drafts',
          new_path: '/workspace/archive',
        },
        workspace: { status: 'fresh', snapshot },
      },
    }));
    let activePath: string | null = '/workspace/drafts/nested/note.md';
    const events: string[] = [];
    const applySnapshot = vi.fn<(value: WorkspaceSnapshot) => void>(() => {
      events.push(`snapshot:${activePath}`);
    });
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(renameWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/drafts',
      'archive',
      {
        renameEntry,
        getCurrentWorkspace: () => requestedWorkspace,
        getActivePath: () => activePath,
        setActivePath: (path) => {
          activePath = path;
          events.push(`active:${path}`);
        },
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(renameEntry).toHaveBeenCalledWith('workspace-7', '/workspace/drafts', 'archive');
    expect(activePath).toBe('/workspace/archive/nested/note.md');
    expect(events).toEqual([
      'active:/workspace/archive/nested/note.md',
      'snapshot:/workspace/archive/nested/note.md',
    ]);
    expect(applySnapshot).toHaveBeenCalledWith(snapshot);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores a committed rename response after the active workspace changes', async () => {
    const requestedWorkspace = {
      workspaceToken: 'workspace-old',
      workspaceRoot: '/workspace/old',
    };
    const renameEntry = vi.fn<() => Promise<MutationOutcome<RenameWorkspaceEntryResponse>>>(async () => ({
      status: 'confirmed-committed',
      receipt: {
        committed: {
          entry_kind: 'file',
          old_path: '/workspace/old/draft.md',
          new_path: '/workspace/old/renamed.md',
        },
        workspace: {
          status: 'fresh',
          snapshot: {
            workspace_token: 'workspace-old',
            root: '/workspace/old',
            files: [],
            directories: [],
          },
        },
      },
    }));
    const setActivePath = vi.fn<(path: string) => void>();
    const applySnapshot = vi.fn<(snapshot: WorkspaceSnapshot) => void>();
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(renameWorkspaceEntryAndReconcile(
      requestedWorkspace,
      '/workspace/old/draft.md',
      'renamed.md',
      {
        renameEntry,
        getCurrentWorkspace: () => ({
          workspaceToken: 'workspace-current',
          workspaceRoot: '/workspace/current',
        }),
        getActivePath: () => '/workspace/current/note.md',
        setActivePath,
        applySnapshot,
        refresh,
      },
    )).resolves.toBeNull();

    expect(renameEntry).toHaveBeenCalledWith(
      'workspace-old',
      '/workspace/old/draft.md',
      'renamed.md',
    );
    expect(setActivePath).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
