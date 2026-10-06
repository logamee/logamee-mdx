/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect } from 'react';
import { persistWorkspaceSession } from '../../lib/tauriCommands';
import { isCurrentWorkspaceIdentity } from '../../lib/documentSession';
import { activePathInWorkspaceSnapshot } from './sessionFacts';
import { normalizeAppError } from '../../lib/appFeedback';
import type { ExternalChangesDeps } from './externalChangesTypes';
import type { ActiveWorkspaceIdentity } from './sessionTypes';
import type { } from '../../types';
import {
  useWorkspaceRefreshDirect,
  useWorkspaceRefreshEntry } from './externalChangesWorkspaceRefresh';

// 工作区会话的持久化（尾链 + 恢复结算）与刷新（直刷/外部路径变更/回执对账/入口）。
export function useExternalChangesWorkspace(deps: ExternalChangesDeps) {

  const persistence = useWorkspaceSessionPersistence(deps);
  const {
    flushWorkspaceSession,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    settleWorkspaceSessionRestore } = persistence;
  const direct = useWorkspaceRefreshDirect(deps, persistence);
  const refresh = useWorkspaceRefreshEntry(deps, persistence, direct);

  return {
    flushWorkspaceSession,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    reconcileRequestedWorkspaceReceipt: refresh.reconcileRequestedWorkspaceReceipt,
    refreshWorkspace: refresh.refreshWorkspace,
    refreshWorkspaceAfterExternalPathChange: refresh.refreshWorkspaceAfterExternalPathChange,
    refreshWorkspaceDirect: refresh.refreshWorkspaceDirect,
    settleWorkspaceSessionRestore };
}

function useWorkspaceSessionPersistence(deps: ExternalChangesDeps) {
  const {
    activePath, authorityStatus, files, isPopout, localeRef, setError,
    workspaceGenerationRef, workspaceIdentityRef, 
    workspaceSessionPersistRevisionRef, workspaceSessionPersistTailRef,
    workspaceSessionRestoreMountedRef, workspaceSessionRestoreSettled,
    workspaceSessionRestoreSettledRef, setWorkspaceSessionRestoreSettled } = deps;
    const settleWorkspaceSessionRestore = useCallback(() => settleWorkspaceRestoreTail({
      mounted: workspaceSessionRestoreMountedRef.current,
      setSettled: setWorkspaceSessionRestoreSettled,
      settledRef: workspaceSessionRestoreSettledRef }), []);
    const getActiveWorkspace = useCallback(
      () => activeWorkspaceFromIdentity(workspaceIdentityRef.current), []);
    const enqueueWorkspaceSessionPersist = useCallback((
      workspace: ActiveWorkspaceIdentity,
      activePath: string | null,
    ): Promise<void> => persistWorkspaceTail({
      activePath,
      isPopout,
      localeRef,
      setError,
      revisionRef: workspaceSessionPersistRevisionRef,
      settledRef: workspaceSessionRestoreSettledRef,
      tailRef: workspaceSessionPersistTailRef,
      workspace }), [isPopout, localeRef, setError]);
    useEffect(runWorkspaceRestorePersist(deps, { enqueueWorkspaceSessionPersist, getActiveWorkspace }), [
      activePath,
      authorityStatus,
      enqueueWorkspaceSessionPersist,
      files,
      getActiveWorkspace,
      isPopout,
      workspaceSessionRestoreSettled,
    ]);
    const flushWorkspaceSession = useCallback(async () => {
      await flushWorkspaceTail(deps, { enqueueWorkspaceSessionPersist, getActiveWorkspace });
    }, [enqueueWorkspaceSessionPersist, isPopout]);
    const isCurrentWorkspaceRequest = useCallback((
      requestedWorkspace: ActiveWorkspaceIdentity,
      requestedGeneration: number,
    ) => workspaceGenerationRef.current === requestedGeneration
      && isCurrentWorkspaceIdentity(workspaceIdentityRef.current, requestedWorkspace), []);
  return {
    enqueueWorkspaceSessionPersist,
    flushWorkspaceSession,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    settleWorkspaceSessionRestore };
}

function settleWorkspaceRestoreTail(input: {
  mounted: boolean;
  setSettled: (settled: boolean) => void;
  settledRef: { current: boolean };
}): void {
  input.settledRef.current = true;
  if (input.mounted) input.setSettled(true);
}

function activeWorkspaceFromIdentity(identity: {
  workspaceRoot: string | null;
  workspaceToken: string | null;
}): ActiveWorkspaceIdentity | null {
  const { workspaceRoot: currentRoot, workspaceToken: currentToken } = identity;
  if (!currentRoot || !currentToken) return null;
  return { workspaceRoot: currentRoot, workspaceToken: currentToken };
}

function persistWorkspaceTail(input: {
  activePath: string | null;
  isPopout: boolean;
  localeRef: ExternalChangesDeps['localeRef'];
  setError: (message: string | null) => void;
  revisionRef: { current: number };
  settledRef: { current: boolean };
  tailRef: { current: Promise<void> };
  workspace: ActiveWorkspaceIdentity;
}): Promise<void> {
  const revision = ++input.revisionRef.current;
  const persist = input.tailRef.current
    .catch(() => undefined)
    .then(async () => {
      if (revision !== input.revisionRef.current
        || input.isPopout
        || !input.settledRef.current) {
        return;
      }
      await persistWorkspaceSession(
        input.workspace.workspaceToken,
        input.workspace.workspaceRoot,
        input.activePath,
      );
    });
  const tracked = persist.catch((persistError: unknown) => {
    if (revision === input.revisionRef.current) {
      input.setError(normalizeAppError(persistError, input.localeRef.current));
    }
    throw persistError;
  });
  input.tailRef.current = tracked.catch(() => undefined);
  return tracked;
}

function runWorkspaceRestorePersist(
  deps: ExternalChangesDeps,
  handles: {
    enqueueWorkspaceSessionPersist: (workspace: ActiveWorkspaceIdentity, activePath: string | null) => Promise<void>;
    getActiveWorkspace: () => ActiveWorkspaceIdentity | null;
  },
) {
  const { activePath, authorityStatus, files, isPopout, workspaceSessionRestoreSettled } = deps;
  const { enqueueWorkspaceSessionPersist, getActiveWorkspace } = handles;
  return () => {
    if (
      isPopout
      || !workspaceSessionRestoreSettled
      || authorityStatus !== 'committed'
    ) return;
    const workspace = getActiveWorkspace();
    if (!workspace) return;
    const persistedActivePath = activePathInWorkspaceSnapshot(activePath, files);
    void enqueueWorkspaceSessionPersist(workspace, persistedActivePath).catch(() => undefined);
  };
}

async function flushWorkspaceTail(
  deps: ExternalChangesDeps,
  handles: {
    enqueueWorkspaceSessionPersist: (workspace: ActiveWorkspaceIdentity, activePath: string | null) => Promise<void>;
    getActiveWorkspace: () => ActiveWorkspaceIdentity | null;
  },
): Promise<void> {
  const { isPopout, paneStateRef, workspaceFilesRef, workspaceSessionRestoreSettledRef } = deps;
  const { enqueueWorkspaceSessionPersist, getActiveWorkspace } = handles;
  if (isPopout || !workspaceSessionRestoreSettledRef.current) return;
  const workspace = getActiveWorkspace();
  if (!workspace) return;
  const current = paneStateRef.current;
  if ((current.authorityStatus ?? 'unknown') !== 'committed') return;
  await enqueueWorkspaceSessionPersist(
    workspace,
    activePathInWorkspaceSnapshot(current.activePath, workspaceFilesRef.current),
  );
}
