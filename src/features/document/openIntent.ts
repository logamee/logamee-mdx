/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect } from 'react';




import { applyWorkspaceSelection, nextPreparedOpenGeneration } from '../../lib/documentSession';



import { normalizeAppError } from '../../lib/appFeedback';



import type { OpenIntentTargetKind } from '../../lib/openIntent';

import { clearRecentFiles, openDirectoryDialog, openFileParentDirectory, resolveOpenIntent as resolveNativeOpenIntent } from '../../lib/tauriCommands';
import type { OpenFileResponse, PreparedOpenFileResponse, WorkspaceSnapshot } from '../../types';
import type { ResolvedOpenIntent } from '../../lib/openIntent';
import { editableFileVersion } from './sessionFacts';
import { applyPreparedOpenBody } from './openIntentApply';
import { applyResolvedOpenIntent, discardResolvedOpenReceipts, openIntentRequestStale } from './openIntentResolve';
import {
  applyOpenFileResponseBody,
  handleOpenFileBody,
  handleOpenRecentBody,
  openWorkspaceFilePathBody,
  openWorkspaceIndexResultBody } from './openIntentOpens';
import type { OpenIntentDeps } from './openIntentTypes';

export type { OpenIntentDeps } from './openIntentTypes';

import type { } from 'react';
import type { } from '../../lib/locale';
import type { PreparedOpenApplyResult } from './sessionTypes';


export function useOpenIntent(deps: OpenIntentDeps) {
  const primitives = useOpenIntentPrimitives(deps);
  const {
    applyOpenFileResponse,
    applyPreparedOpen,
    claimPreparedOpen,
    synchronizeWorkspaceForStandaloneFile } = primitives;
  const workspaceOpens = useOpenIntentWorkspaceOpens(deps, primitives);
  const { openWorkspaceFilePath, openWorkspaceIndexResult } = workspaceOpens;
  const dialogOpens = useOpenIntentDialogOpens(deps, primitives);
  const { handleClearRecent, handleOpenDirectory, handleOpenFile, handleOpenRecent } = dialogOpens;
  const resolveOpenIntentRequest = useOpenIntentResolution(deps, primitives);

  return { handleClearRecent, applyOpenFileResponse, applyPreparedOpen, claimPreparedOpen, synchronizeWorkspaceForStandaloneFile, openWorkspaceFilePath, openWorkspaceIndexResult, handleOpenFile, handleOpenRecent, handleOpenDirectory, resolveOpenIntentRequest };
}


function useOpenIntentPrimitives(deps: OpenIntentDeps) {
  const { advanceCrashDraftIdentity, afterConfirmedSave, applyDocumentSessionState, applyWorkspaceSnapshot, currentDocumentSessionState, documentGenerationRef, workspaceSessionRestoreMountedRef } = deps;
    const applyOpenFileResponse = useCallback((response: OpenFileResponse) => {
      applyOpenFileResponseBody(response, deps);
    }, [applyDocumentSessionState, currentDocumentSessionState]);
    const applyPreparedOpen = useCallback(async (
      prepared: PreparedOpenFileResponse,
      requestedGeneration: number,
      reportFailure = true,
      discardCurrentCrashDraft = false,
    ): Promise<PreparedOpenApplyResult> => applyPreparedOpenBody(
      prepared,
      requestedGeneration,
      preparedOpenDeps(deps),
      { discardCurrentCrashDraft, reportFailure },
    ), [advanceCrashDraftIdentity, afterConfirmedSave, applyDocumentSessionState, currentDocumentSessionState]);
    const synchronizeWorkspaceForStandaloneFile = useCallback(async (
      path: string,
      requestedDocumentGeneration: number,
      intentId: string,
    ) => {
      await synchronizeStandaloneFileBody(
        { path, requestedDocumentGeneration, intentId },
        deps);
    }, [applyWorkspaceSnapshot]);
    const claimPreparedOpen = useCallback((
      prepared: PreparedOpenFileResponse | null,
      requestedGeneration: number,
    ) => {
      const nextGeneration = nextPreparedOpenGeneration(
        documentGenerationRef.current,
        requestedGeneration,
        prepared,
      );
      if (nextGeneration !== null) documentGenerationRef.current = nextGeneration;
      return nextGeneration;
    }, []);
    useEffect(() => {
      workspaceSessionRestoreMountedRef.current = true;
      return () => {
        workspaceSessionRestoreMountedRef.current = false;
      };
    }, []);
  return { applyOpenFileResponse, applyPreparedOpen, claimPreparedOpen, synchronizeWorkspaceForStandaloneFile };
}
function useOpenIntentWorkspaceOpens(
  deps: OpenIntentDeps,
  primitives: ReturnType<typeof useOpenIntentPrimitives>,
) {
  const { applyPreparedOpen, claimPreparedOpen } = primitives;
  const { executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked } = deps;

    const openWorkspaceFilePath = useCallback(async (path: string) => {
      await openWorkspaceFilePathBody(path, deps, { applyPreparedOpen, claimPreparedOpen });
    }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked]);



    const openWorkspaceIndexResult = useCallback(async (
      workspaceToken: string,
      workspaceRoot: string,
      indexGeneration: number,
      relativePath: string,
    ) => {
      await openWorkspaceIndexResultBody(
        { workspaceToken, workspaceRoot, indexGeneration, relativePath },
        deps,
        { applyPreparedOpen, claimPreparedOpen });
    }, [
      applyPreparedOpen,
      claimPreparedOpen,
      executeSessionOperation,
      getActiveWorkspace,
      isCurrentWorkspaceRequest,
      ordinaryDocumentActionsBlocked,
    ]);



  return { openWorkspaceFilePath, openWorkspaceIndexResult };
}

function useOpenIntentDialogOpens(
  deps: OpenIntentDeps,
  primitives: ReturnType<typeof useOpenIntentPrimitives>,
) {
  const { applyPreparedOpen, claimPreparedOpen } = primitives;
  const { executeSessionOperation, ordinaryDocumentActionsBlocked, workspaceGenerationRef, applyWorkspaceSnapshot } = deps;

    const handleOpenFile = useCallback(async () => {
      await handleOpenFileBody(deps, { applyPreparedOpen, claimPreparedOpen });
    }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, ordinaryDocumentActionsBlocked]);



    const handleOpenRecent = useCallback(async (entryId: string) => {
      await handleOpenRecentBody(entryId, deps, { applyPreparedOpen, claimPreparedOpen });
    }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, ordinaryDocumentActionsBlocked]);



    const handleClearRecent = useCallback(async () => {
      await executeSessionOperation({ run: clearRecentFiles });
    }, [executeSessionOperation]);

    const handleOpenDirectory = useCallback(async () => {
      if (ordinaryDocumentActionsBlocked()) return;
      const requestedGeneration = workspaceGenerationRef.current;
      await executeSessionOperation({
        run: openDirectoryDialog,
        isCurrent: () => workspaceGenerationRef.current === requestedGeneration,
        apply: (response: WorkspaceSnapshot | null) => {
          applyWorkspaceSelection(response, {
            advanceGeneration: () => {
              workspaceGenerationRef.current += 1;
            },
            applySnapshot: applyWorkspaceSnapshot,
          });
        },
      });
    }, [applyWorkspaceSnapshot, executeSessionOperation, ordinaryDocumentActionsBlocked]);

  return { handleClearRecent, handleOpenDirectory, handleOpenFile, handleOpenRecent };
}

function useOpenIntentResolution(
  deps: OpenIntentDeps,
  primitives: ReturnType<typeof useOpenIntentPrimitives>,
) {
  const { applyPreparedOpen, claimPreparedOpen, synchronizeWorkspaceForStandaloneFile } = primitives;
  const { applyWorkspaceSnapshot, executeSessionOperation, documentGenerationRef, documentOpenRequestRef, openIntentResolutionBlocked, rollbackWorkspaceState, settleWorkspaceSessionRestore, workspaceSessionRestoreMountedRef } = deps;

    const resolveOpenIntentRequest = useCallback(async (
      intentId: string,
      targetKind: OpenIntentTargetKind = 'unknown',
      discardCurrentCrashDraft = false,
    ): Promise<'blocked' | 'accepted' | 'failed'> => {
      if (openIntentResolutionBlocked()) return 'blocked';
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedOpen = ++documentOpenRequestRef.current;
      let applied = false;
      const result = await executeSessionOperation({
        run: () => resolveNativeOpenIntent(intentId),
        consume: async (resolved: ResolvedOpenIntent) => {
          if (openIntentRequestStale(deps, requestedOpen, requestedDocumentGeneration)) {
            await discardResolvedOpenReceipts(resolved);
          }
        },
        isCurrent: () => documentOpenRequestRef.current === requestedOpen
          && documentGenerationRef.current === requestedDocumentGeneration
          && workspaceSessionRestoreMountedRef.current,
        apply: async (resolved: ResolvedOpenIntent) => {
          applied = await applyResolvedOpenIntent(resolved, {
            deps,
            claimPreparedOpen,
            applyPreparedOpen,
            synchronizeWorkspaceForStandaloneFile,
            requestedDocumentGeneration,
            intentId,
            discardCurrentCrashDraft });
        },
      });
      if (targetKind === 'session_restore') settleWorkspaceSessionRestore();
      if (!result || result.status !== 'applied' || !applied) return 'failed';
      return 'accepted';
    }, [applyPreparedOpen, applyWorkspaceSnapshot, claimPreparedOpen, executeSessionOperation, openIntentResolutionBlocked, rollbackWorkspaceState, settleWorkspaceSessionRestore, synchronizeWorkspaceForStandaloneFile]);

  return resolveOpenIntentRequest;
}

async function synchronizeStandaloneFileBody(
  request: { path: string; requestedDocumentGeneration: number; intentId: string },
  deps: OpenIntentDeps,
): Promise<void> {
  const { applyWorkspaceSnapshot, documentGenerationRef, localeRef, setError, setNotice, workspaceGenerationRef, workspaceSessionRestoreMountedRef } = deps;
  const { path, requestedDocumentGeneration, intentId } = request;
  try {
    const response = await openFileParentDirectory(path, intentId);
    if (
      documentGenerationRef.current !== requestedDocumentGeneration
      || !workspaceSessionRestoreMountedRef.current
    ) return;
    workspaceGenerationRef.current += 1;
    applyWorkspaceSnapshot(response);
  } catch (error) {
    setError(normalizeAppError(error, localeRef.current));
    setNotice(null);
  }
}

function preparedOpenDeps(deps: OpenIntentDeps) {
  return {
    activeFileVersionRef: deps.activeFileVersionRef,
    advanceCrashDraftIdentity: deps.advanceCrashDraftIdentity,
    afterConfirmedSave: deps.afterConfirmedSave as ((documentId: string) => Promise<boolean>) | undefined,
    applyDocumentSessionState: deps.applyDocumentSessionState,
    crashDraftDocumentIdRef: deps.crashDraftDocumentIdRef,
    crashDraftSchedulerRef: deps.crashDraftSchedulerRef,
    currentDocumentSessionState: deps.currentDocumentSessionState,
    documentGenerationRef: deps.documentGenerationRef,
    editableFileVersion: editableFileVersion as never,
    setError: deps.setError };
}
