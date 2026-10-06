// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import type { MutationOutcome, SnapshotReceipt, WorkspaceSnapshot } from '../../types';
import type { WorkspaceMutationsDeps } from './workspaceMutations';
import {
  useWorkspaceCopyEntry,
  useWorkspaceDeleteEntry,
  useWorkspaceMoveEntry,
  useWorkspaceRenameEntry,
} from './workspaceEntryMutations';

vi.mock('../../lib/tauriCommands', () => ({
  copyWorkspaceEntry: vi.fn<() => Promise<MutationOutcome<typeof relocation>>>(() => Promise.resolve(entryOutcome())),
  deleteWorkspaceEntry: vi.fn<() => Promise<MutationOutcome<{ deleted_path: string }>>>(() => Promise.resolve(deleteOutcome())),
  moveWorkspaceEntry: vi.fn<() => Promise<MutationOutcome<typeof relocation>>>(() => Promise.resolve(entryOutcome())),
  renameWorkspaceEntry: vi.fn<() => Promise<MutationOutcome<typeof relocation>>>(() => Promise.resolve(entryOutcome())),
}));

import { copyWorkspaceEntry, deleteWorkspaceEntry, moveWorkspaceEntry, renameWorkspaceEntry } from '../../lib/tauriCommands';

const snapshot: WorkspaceSnapshot = { workspace_token: 'token-1', root: '/ws', files: [], directories: [] };
const receipt: SnapshotReceipt = { status: 'fresh', snapshot };
const relocation = { entry_kind: 'file' as const, new_path: '/ws/b.md', old_path: '/ws/a.md' };

function entryOutcome(): MutationOutcome<typeof relocation> {
  return { status: 'confirmed-committed', receipt: { committed: relocation, workspace: receipt } };
}

function deleteOutcome(): MutationOutcome<{ deleted_path: string }> {
  return {
    status: 'confirmed-committed',
    receipt: { committed: { deleted_path: '/ws/a.md' }, workspace: receipt },
  };
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

describe('workspace entry mutations', () => {
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

  it('renames an entry and applies the reconciled snapshot', async () => {
    const deps = buildDeps();
    const rename = capture(() => useWorkspaceRenameEntry(deps));
    await act(async () => {
      await rename.current.renameWorkspaceEntryPath('/ws/a.md', 'b.md');
    });
    expect(renameWorkspaceEntry).toHaveBeenCalledWith('token-1', '/ws/a.md', 'b.md');
    expect(deps.applyWorkspaceSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('routes a not-committed rename through the outcome consumer', async () => {
    const outcome = { status: 'confirmed-not-committed', message: 'rename failed' } as const;
    vi.mocked(renameWorkspaceEntry).mockResolvedValueOnce(outcome);
    const deps = buildDeps();
    const rename = capture(() => useWorkspaceRenameEntry(deps));
    await act(async () => {
      await rename.current.renameWorkspaceEntryPath('/ws/a.md', 'b.md');
    });
    expect(deps.consumeMutationOutcome).toHaveBeenCalledWith(outcome);
  });

  it('moves an entry into the requested parent and reconciles', async () => {
    const deps = buildDeps();
    const move = capture(() => useWorkspaceMoveEntry(deps));
    await act(async () => {
      await move.current.moveWorkspaceEntryPath('/ws/a.md', '/ws/notes');
    });
    expect(moveWorkspaceEntry).toHaveBeenCalledWith('token-1', '/ws/a.md', '/ws/notes');
    expect(deps.applyWorkspaceSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('copies an entry and reconciles only the workspace receipt', async () => {
    const deps = buildDeps();
    const copy = capture(() => useWorkspaceCopyEntry(deps));
    await act(async () => {
      await copy.current.copyWorkspaceEntryPath('/ws/a.md', '/ws/notes');
    });
    expect(copyWorkspaceEntry).toHaveBeenCalledWith('token-1', '/ws/a.md', '/ws/notes');
    expect(deps.reconcileRequestedWorkspaceReceipt).toHaveBeenCalledWith(
      { workspaceToken: 'token-1', workspaceRoot: '/ws' },
      7,
      receipt,
    );
  });

  it('deletes an entry and clears the active document when it was open', async () => {
    const deps = buildDeps({ activePathRef: { current: '/ws/a.md' } });
    const remove = capture(() => useWorkspaceDeleteEntry(deps));
    await act(async () => {
      await remove.current.deleteWorkspaceEntryPath('/ws/a.md');
    });
    expect(deleteWorkspaceEntry).toHaveBeenCalledWith('token-1', '/ws/a.md');
    expect(deps.clearActiveDocument).toHaveBeenCalled();
    expect(deps.applyWorkspaceSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('does nothing while ordinary document actions are blocked', async () => {
    const deps = buildDeps({ ordinaryDocumentActionsBlocked: vi.fn<() => boolean>(() => true) });
    const remove = capture(() => useWorkspaceDeleteEntry(deps));
    await act(async () => {
      await remove.current.deleteWorkspaceEntryPath('/ws/a.md');
    });
    expect(deleteWorkspaceEntry).not.toHaveBeenCalled();
  });
});
