/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import { copyWorkspaceEntry, deleteWorkspaceEntry, moveWorkspaceEntry, renameWorkspaceEntry } from '../../lib/tauriCommands';
import {
  deleteWorkspaceEntryAndReconcile,
  moveWorkspaceEntryAndReconcile,
  renameWorkspaceEntryAndReconcile,
} from '../../lib/documentSession';
import type { WorkspaceMutationsDeps } from './workspaceMutations';

// 重命名条目：路径变更同步活动文档路径并刷新。
export function useWorkspaceRenameEntry(deps: WorkspaceMutationsDeps) {
  const { activePathRef, applyWorkspaceSnapshot, consumeMutationOutcome, executeSessionOperation } = deps;
  const { getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked } = deps;
  const { refreshWorkspaceDirect, setActiveDocumentPath, setError } = deps;
  const { workspaceGenerationRef, workspaceIdentityRef } = deps;

  const renameWorkspaceEntryPath = useCallback(async (path: string, newName: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => renameWorkspaceEntry(requestedWorkspace.workspaceToken, path, newName),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await renameWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          newName,
          {
            renameEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            setActivePath: setActiveDocumentPath,
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
    setActiveDocumentPath,
  ]);

  return { renameWorkspaceEntryPath };
}

// 移动条目：路径变更同步活动文档路径并刷新。
export function useWorkspaceMoveEntry(deps: WorkspaceMutationsDeps) {
  const { activePathRef, applyWorkspaceSnapshot, consumeMutationOutcome, executeSessionOperation } = deps;
  const { getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked } = deps;
  const { refreshWorkspaceDirect, setActiveDocumentPath, setError } = deps;
  const { workspaceGenerationRef, workspaceIdentityRef } = deps;

  const moveWorkspaceEntryPath = useCallback(async (
    path: string,
    destinationParentPath: string,
  ) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => moveWorkspaceEntry(requestedWorkspace.workspaceToken, path, destinationParentPath),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await moveWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          destinationParentPath,
          {
            moveEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            setActivePath: setActiveDocumentPath,
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
    setActiveDocumentPath,
  ]);

  return { moveWorkspaceEntryPath };
}

// 复制条目：完成后仅对账工作区回执。
export function useWorkspaceCopyEntry(deps: WorkspaceMutationsDeps) {
  const { consumeMutationOutcome, executeSessionOperation, getActiveWorkspace } = deps;
  const { isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked } = deps;
  const { reconcileRequestedWorkspaceReceipt, setError, workspaceGenerationRef } = deps;

  const copyWorkspaceEntryPath = useCallback(async (
    sourcePath: string,
    destinationParentPath: string,
  ) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => copyWorkspaceEntry(requestedWorkspace.workspaceToken, sourcePath, destinationParentPath),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await reconcileRequestedWorkspaceReceipt(
          requestedWorkspace,
          requestedGeneration,
          outcome.receipt.workspace,
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    consumeMutationOutcome,
    executeSessionOperation,
    ordinaryDocumentActionsBlocked,
  ]);

  return { copyWorkspaceEntryPath };
}

// 删除条目：活动文档位于删除范围时清空文档。
export function useWorkspaceDeleteEntry(deps: WorkspaceMutationsDeps) {
  const { activePathRef, applyWorkspaceSnapshot, clearActiveDocument, consumeMutationOutcome } = deps;
  const { executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest } = deps;
  const { ordinaryDocumentActionsBlocked, refreshWorkspaceDirect, setError } = deps;
  const { workspaceGenerationRef, workspaceIdentityRef } = deps;

  const deleteWorkspaceEntryPath = useCallback(async (path: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => deleteWorkspaceEntry(requestedWorkspace.workspaceToken, path),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await deleteWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          {
            deleteEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            clearActiveDocument,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    clearActiveDocument,
    consumeMutationOutcome,
    executeSessionOperation,
    ordinaryDocumentActionsBlocked,
  ]);

  return { deleteWorkspaceEntryPath };
}
