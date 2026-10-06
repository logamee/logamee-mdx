/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import { refreshDirectory } from '../../lib/tauriCommands';
import { isCurrentWorkspaceIdentity, reconcileWorkspaceReceipt } from '../../lib/documentSession';
import { normalizeAppError } from '../../lib/appFeedback';
import { } from './sessionFacts';
import type { ExternalChangesDeps } from './externalChangesTypes';
import type { ActiveWorkspaceIdentity } from './sessionTypes';
import type { SnapshotReceipt } from '../../types';
import type { WorkspaceSessionPersistence } from './externalChangesWorkspacePersistence';

export function useWorkspaceRefreshDirect(
  deps: ExternalChangesDeps,
  persistence: WorkspaceSessionPersistence,
) {
  const {
    applyWorkspaceSnapshot, localeRef,
    setError, workspaceGenerationRef,
 } = deps;
  const { getActiveWorkspace, isCurrentWorkspaceRequest } = persistence;
    const refreshWorkspaceDirect = useCallback(async (
      requestedWorkspace: ActiveWorkspaceIdentity,
      requestedGeneration: number,
    ) => {
      const response = await refreshDirectory(
        requestedWorkspace.workspaceToken,
        requestedWorkspace.workspaceRoot,
      );
      if (!isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) return;
      if (!isCurrentWorkspaceIdentity(
        {
          workspaceRoot: response.root,
          workspaceToken: response.workspace_token,
        },
        requestedWorkspace,
      )) {
        throw new Error('Workspace refresh response does not match the active workspace');
      }
      applyWorkspaceSnapshot(response);
    }, [applyWorkspaceSnapshot, isCurrentWorkspaceRequest]);
    const refreshWorkspaceAfterExternalPathChange = useCallback(async (previousPath: string) => {
      const requestedWorkspace = getActiveWorkspace();
      if (!requestedWorkspace) return;
      const normalizedRoot = requestedWorkspace.workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedPath = previousPath.replace(/\\/g, '/');
      if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) {
        return;
      }
      const requestedGeneration = workspaceGenerationRef.current;
      try {
        await refreshWorkspaceDirect(requestedWorkspace, requestedGeneration);
      } catch (refreshError) {
        if (isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) {
          setError(normalizeAppError(refreshError, localeRef.current));
        }
      }
    }, [getActiveWorkspace, refreshWorkspaceDirect]);
  return { refreshWorkspaceAfterExternalPathChange, refreshWorkspaceDirect };
}

export function useWorkspaceRefreshEntry(
  deps: ExternalChangesDeps,
  persistence: WorkspaceSessionPersistence,
  direct: ReturnType<typeof useWorkspaceRefreshDirect>,
) {
  const {
    applyWorkspaceSnapshot, executeSessionOperation,
    ordinaryDocumentActionsBlocked } = deps;
  const { isCurrentWorkspaceRequest } = persistence;
  const { refreshWorkspaceDirect } = direct;

    const reconcileRequestedWorkspaceReceipt = useCallback(async (
      requestedWorkspace: ActiveWorkspaceIdentity,
      requestedGeneration: number,
      receipt: SnapshotReceipt,
    ) => {
      if (!isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) return null;
      return reconcileWorkspaceReceipt(
        requestedWorkspace.workspaceToken,
        receipt,
        {
          workspaceRoot: requestedWorkspace.workspaceRoot,
          applySnapshot: (snapshot) => {
            if (isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) {
              applyWorkspaceSnapshot(snapshot);
            }
          },
          refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
        },
      );
    }, [applyWorkspaceSnapshot, refreshWorkspaceDirect]);

    const refreshWorkspace = useCallback(async (root?: string) => {
      await refreshWorkspaceTail(deps, persistence, { root });
    }, [applyWorkspaceSnapshot, executeSessionOperation, ordinaryDocumentActionsBlocked]);

  return {
    reconcileRequestedWorkspaceReceipt,
    refreshWorkspace,
    refreshWorkspaceAfterExternalPathChange: direct.refreshWorkspaceAfterExternalPathChange,
    refreshWorkspaceDirect };
}




async function refreshWorkspaceTail(
  deps: ExternalChangesDeps,
  persistence: WorkspaceSessionPersistence,
  input: { root?: string },
): Promise<void> {
  const {
    applyWorkspaceSnapshot, executeSessionOperation, ordinaryDocumentActionsBlocked,
    workspaceGenerationRef } = deps;
  const { getActiveWorkspace, isCurrentWorkspaceRequest } = persistence;
  const { root } = input;
      if (ordinaryDocumentActionsBlocked()) return;
      const currentWorkspace = getActiveWorkspace();
      if (!currentWorkspace) return;
      const requestedWorkspace = {
        ...currentWorkspace,
        workspaceRoot: root ?? currentWorkspace.workspaceRoot,
      };
      if (!isCurrentWorkspaceIdentity(currentWorkspace, requestedWorkspace)) return;
      const requestedGeneration = workspaceGenerationRef.current;

      await executeSessionOperation({
        run: () => refreshDirectory(
          requestedWorkspace.workspaceToken,
          requestedWorkspace.workspaceRoot,
        ),
        isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
        apply: (response) => {
          if (!isCurrentWorkspaceIdentity(
            {
              workspaceRoot: response.root,
              workspaceToken: response.workspace_token,
            },
            requestedWorkspace,
          )) {
            throw new Error('Workspace refresh response does not match the active workspace');
          }
          applyWorkspaceSnapshot(response);
        },
      });
}


