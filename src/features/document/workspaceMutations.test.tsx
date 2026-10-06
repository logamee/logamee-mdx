// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import type { MutationOutcome, OpenFileResponse, SnapshotReceipt, WorkspaceSnapshot } from '../../types';
import { useWorkspaceCreateFile, useWorkspaceCreateFolder, type WorkspaceMutationsDeps } from './workspaceMutations';

vi.mock('../../lib/tauriCommands', () => ({
  createWorkspaceFile: vi.fn<() => Promise<MutationOutcome<OpenFileResponse>>>(() => Promise.resolve(fileOutcome())),
  createWorkspaceDirectory: vi.fn<() => Promise<MutationOutcome<RenameEntryResponse>>>(() => Promise.resolve(directoryOutcome())),
}));

import { createWorkspaceDirectory, createWorkspaceFile } from '../../lib/tauriCommands';

const snapshot: WorkspaceSnapshot = {
  workspace_token: 'token-1',
  root: '/ws',
  files: [],
  directories: [],
};
const receipt: SnapshotReceipt = { status: 'fresh', snapshot };
const committed: OpenFileResponse = {
  kind: 'markdown',
  path: '/ws/a.md',
  content_mode: 'text',
  content: '',
  file_version: { canonicalPath: '/ws/a.md', platformIdentity: 'dev=1 ino=1', length: '1', modifiedNanos: '1', sha256: '0' },
};

function fileOutcome(): MutationOutcome<OpenFileResponse> {
  return { status: 'confirmed-committed', receipt: { committed, workspace: receipt } };
}

function directoryOutcome(): MutationOutcome<RenameEntryResponse> {
  return {
    status: 'confirmed-committed',
    receipt: {
      committed: { entry_kind: 'directory', new_path: '/ws/notes', old_path: '/ws/notes' },
      workspace: receipt,
    },
  };
}

interface RenameEntryResponse {
  entry_kind: 'file' | 'directory';
  new_path: string;
  old_path: string;
}

const runOperationSpy = vi.fn<
  (operation: {
    run: () => Promise<unknown>;
    consume?: (outcome: unknown) => void;
    apply?: (outcome: never) => Promise<void>;
  }) => Promise<{ status: 'applied'; value: unknown }>
>(async (operation) => {
  const value = await operation.run();
  operation.consume?.(value);
  await operation.apply?.(value as never);
  return { status: 'applied', value };
});


function buildDeps(overrides: Partial<WorkspaceMutationsDeps> = {}): WorkspaceMutationsDeps {
  return {
    activePathRef: { current: null },
    advanceCrashDraftIdentity: vi.fn<(...args: unknown[]) => unknown>(),
    applyOpenFileResponse: vi.fn<(...args: unknown[]) => unknown>(),
    applyWorkspaceSnapshot: vi.fn<(...args: unknown[]) => unknown>(),
    clearActiveDocument: vi.fn<(...args: unknown[]) => unknown>(),
    consumeMutationOutcome: vi.fn<(...args: unknown[]) => unknown>(),
    crashDraftDocumentIdRef: { current: 'draft-1' },
    crashDraftSchedulerRef: { current: { flush: vi.fn<() => Promise<void>>(async () => undefined) } as unknown as CrashDraftScheduler },
    documentGenerationRef: { current: 3 },
    executeSessionOperation: runOperationSpy as unknown as WorkspaceMutationsDeps['executeSessionOperation'],
    getActiveWorkspace: vi.fn<() => { workspaceToken: string; workspaceRoot: string }>(() => ({ workspaceToken: 'token-1', workspaceRoot: '/ws' })),
    isCurrentWorkspaceRequest: vi.fn<() => boolean>(() => true),
    ordinaryDocumentActionsBlocked: vi.fn<() => boolean>(() => false),
    reconcileRequestedWorkspaceReceipt: vi.fn<() => Promise<null>>(async () => null),
    refreshWorkspaceDirect: vi.fn<() => Promise<void>>(async () => undefined),
    setActiveDocumentPath: vi.fn<(...args: unknown[]) => unknown>(),
    setError: vi.fn<(...args: unknown[]) => unknown>(),
    workspaceGenerationRef: { current: 7 },
    workspaceIdentityRef: { current: { workspaceToken: 'token-1', workspaceRoot: '/ws' } },
    ...overrides,
  };
}

describe('workspace create mutations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function capture<T>(useHook: () => T): { current: T } {
    const ref = { current: null as unknown as T };
    function Probe() {
      ref.current = useHook();
      return null;
    }
    act(() => root.render(<Probe />));
    return ref;
  }

  it('creates a file, opens it and reconciles the workspace receipt', async () => {
    const deps = buildDeps();
    const create = capture(() => useWorkspaceCreateFile(deps));
    await act(async () => {
      await create.current.createFileInWorkspace('notes', 'a.md', 'markdown');
    });

    expect(createWorkspaceFile).toHaveBeenCalledWith('token-1', 'notes', 'a.md', 'markdown');
    expect(deps.applyOpenFileResponse).toHaveBeenCalledWith(committed);
    expect(deps.advanceCrashDraftIdentity).toHaveBeenCalledWith('draft-1');
    expect(deps.crashDraftSchedulerRef.current?.flush).toHaveBeenCalledWith('draft-1');
    expect(deps.reconcileRequestedWorkspaceReceipt).toHaveBeenCalledWith(
      { workspaceToken: 'token-1', workspaceRoot: '/ws' },
      7,
      receipt,
    );
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('does nothing while ordinary document actions are blocked', async () => {
    const deps = buildDeps({ ordinaryDocumentActionsBlocked: vi.fn<() => boolean>(() => true) });
    const create = capture(() => useWorkspaceCreateFile(deps));
    await act(async () => {
      await create.current.createFileInWorkspace('notes', 'a.md');
    });
    expect(createWorkspaceFile).not.toHaveBeenCalled();
  });

  it('does nothing without an active workspace', async () => {
    const deps = buildDeps({ getActiveWorkspace: vi.fn<() => null>(() => null) });
    const create = capture(() => useWorkspaceCreateFile(deps));
    await act(async () => {
      await create.current.createFileInWorkspace('notes', 'a.md');
    });
    expect(createWorkspaceFile).not.toHaveBeenCalled();
  });

  it('routes a not-committed directory creation through the outcome consumer', async () => {
    const outcome = { status: 'confirmed-not-committed', message: 'directory exists' } as const;
    vi.mocked(createWorkspaceDirectory).mockResolvedValueOnce(outcome);
    const deps = buildDeps();
    const create = capture(() => useWorkspaceCreateFolder(deps));
    await act(async () => {
      await create.current.createFolderInWorkspace('notes', 'assets');
    });

    expect(createWorkspaceDirectory).toHaveBeenCalledWith('token-1', 'notes', 'assets');
    expect(deps.consumeMutationOutcome).toHaveBeenCalledWith(outcome);
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('applies the workspace snapshot after a committed directory creation', async () => {
    const deps = buildDeps();
    const create = capture(() => useWorkspaceCreateFolder(deps));
    await act(async () => {
      await create.current.createFolderInWorkspace('notes', 'assets');
    });

    expect(deps.applyWorkspaceSnapshot).toHaveBeenCalledWith(snapshot);
    expect(deps.setError).not.toHaveBeenCalled();
  });
});
