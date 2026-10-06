/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { createWorkspaceDirectory, createWorkspaceFile } from '../../lib/tauriCommands';
import { createWorkspaceDirectoryAndReconcile, type WorkspaceIdentity } from '../../lib/documentSession';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import type { DocumentSessionQueueOperation, DocumentSessionQueueResult } from '../../lib/documentSessionQueue';
import type { ActiveWorkspaceIdentity } from './sessionTypes';
import type { MutationOutcome, OpenFileResponse, SnapshotReceipt, WorkspaceFileKind, WorkspaceSnapshot } from '../../types';

export interface WorkspaceMutationsDeps {
  activePathRef: RefObject<string | null>;
  advanceCrashDraftIdentity: (priorDocumentId: string) => void;
  applyOpenFileResponse: (response: OpenFileResponse) => void;
  applyWorkspaceSnapshot: (response: WorkspaceSnapshot) => void;
  clearActiveDocument: () => void;
  consumeMutationOutcome: (outcome: MutationOutcome<unknown> | null) => void;
  crashDraftDocumentIdRef: RefObject<string>;
  crashDraftSchedulerRef: RefObject<CrashDraftScheduler | null>;
  documentGenerationRef: RefObject<number>;
  executeSessionOperation: <T>(operation: DocumentSessionQueueOperation<T>) => Promise<DocumentSessionQueueResult<T> | null>;
  getActiveWorkspace: () => ActiveWorkspaceIdentity | null;
  isCurrentWorkspaceRequest: (requestedWorkspace: ActiveWorkspaceIdentity, requestedGeneration: number) => boolean;
  ordinaryDocumentActionsBlocked: () => boolean;
  reconcileRequestedWorkspaceReceipt: (
    requestedWorkspace: ActiveWorkspaceIdentity,
    requestedGeneration: number,
    receipt: SnapshotReceipt,
  ) => Promise<string | null>;
  refreshWorkspaceDirect: (requestedWorkspace: ActiveWorkspaceIdentity, requestedGeneration: number) => Promise<void>;
  setActiveDocumentPath: (path: string | null) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  workspaceGenerationRef: RefObject<number>;
  workspaceIdentityRef: RefObject<WorkspaceIdentity>;
}

// 创建文件：先冲刷崩溃草稿再切换文档，随后对账工作区回执。
export function useWorkspaceCreateFile(deps: WorkspaceMutationsDeps) {
  const { advanceCrashDraftIdentity, applyOpenFileResponse, consumeMutationOutcome } = deps;
  const { crashDraftDocumentIdRef, crashDraftSchedulerRef, documentGenerationRef } = deps;
  const { executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest } = deps;
  const { ordinaryDocumentActionsBlocked, reconcileRequestedWorkspaceReceipt } = deps;
  const { setError, workspaceGenerationRef } = deps;

  const createFileInWorkspace = useCallback(async (
    parentPath: string,
    name: string,
    fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'> = 'markdown',
  ) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedWorkspaceGeneration = workspaceGenerationRef.current;
    const requestedDocumentGeneration = documentGenerationRef.current;

    await executeSessionOperation({
      run: () => createWorkspaceFile(requestedWorkspace.workspaceToken, parentPath, name, fileKind),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        if (documentGenerationRef.current === requestedDocumentGeneration) {
          const priorCrashDocumentId = crashDraftDocumentIdRef.current;
          await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
          documentGenerationRef.current = requestedDocumentGeneration + 1;
          applyOpenFileResponse(outcome.receipt.committed);
          advanceCrashDraftIdentity(priorCrashDocumentId);
        }
        const receiptError = await reconcileRequestedWorkspaceReceipt(
          requestedWorkspace,
          requestedWorkspaceGeneration,
          outcome.receipt.workspace,
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyOpenFileResponse,
    advanceCrashDraftIdentity,
    consumeMutationOutcome,
    executeSessionOperation,
    ordinaryDocumentActionsBlocked,
  ]);

  return { createFileInWorkspace };
}

// 创建文件夹：走目录创建与快照对账。
export function useWorkspaceCreateFolder(deps: WorkspaceMutationsDeps) {
  const { applyWorkspaceSnapshot, consumeMutationOutcome, executeSessionOperation } = deps;
  const { getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked } = deps;
  const { refreshWorkspaceDirect, setError, workspaceGenerationRef, workspaceIdentityRef } = deps;

  const createFolderInWorkspace = useCallback(async (parentPath: string, name: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => createWorkspaceDirectory(requestedWorkspace.workspaceToken, parentPath, name),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await createWorkspaceDirectoryAndReconcile(
          requestedWorkspace,
          parentPath,
          name,
          {
            createDirectory: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    consumeMutationOutcome,
    executeSessionOperation,
    ordinaryDocumentActionsBlocked,
  ]);

  return { createFolderInWorkspace };
}

