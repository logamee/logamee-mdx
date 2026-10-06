/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { buildWorkspaceFileTree } from '../../lib/fileTree';
import { createTauriActiveDocumentWatchTransport, isTauriRuntime } from '../../lib/activeDocumentWatch';
import { isDocumentDirty } from '../../lib/documentSession';
import { normalizeAppError } from '../../lib/appFeedback';
import { createCrashDraftDocumentId } from '../../lib/crashDrafts';
import type { PaneReplicatedState } from '../../lib/paneSync';
import type { DocumentSessionStores } from './documentSessionStores';
import {
  useDocumentActionGuards,
  useDocumentStateApplication,
  useSessionOperationQueue,
  useWorkspaceSnapshotState,
} from './documentSessionCoreState';

export function useDocumentDerivedState(stores: DocumentSessionStores) {
  const {
    activeFileKind, activeMimeType, activePath, activeDocumentWatchTransport: supplied, authorityStatus,
    bytesBase64, content, crashDraftDocumentIdRef, directories, documentIdentity, externalFileAction,
    externalFileActionRef, files, forcedDirtyCrashDraftIdRef, lastSavedContent, localeRef,
    previewRevision, saveConflict, saveConflictRef, sessionQueue, setBusy, setError,
    workspaceDirectoriesRef, workspaceFilesRef, workspaceRoot,
  } = stores;
  const activeDocumentWatchTransport = useMemo(() => {
    if (supplied !== undefined) {
      return supplied;
    }
    if (!isTauriRuntime()) return null;
    return createTauriActiveDocumentWatchTransport({
      onError: (watchError) => setError(normalizeAppError(watchError, localeRef.current)),
    });
  }, [supplied]);

  externalFileActionRef.current = externalFileAction;
  saveConflictRef.current = saveConflict;

  const dirty = isDocumentDirty({ activeFileKind, content, lastSavedContent })
    || forcedDirtyCrashDraftIdRef.current === crashDraftDocumentIdRef.current;
  const fileTree = useMemo(() => buildWorkspaceFileTree(files, directories), [directories, files]);
  workspaceFilesRef.current = files;
  workspaceDirectoriesRef.current = directories;
  const paneState = useMemo<PaneReplicatedState>(() => ({
    activeFileKind,
    activeMimeType,
    activePath,
    bytesBase64,
    content,
    lastSavedContent,
    previewRevision,
    authorityStatus,
    workspaceRoot,
    ...documentIdentity,
  }), [activeFileKind, activeMimeType, activePath, authorityStatus, bytesBase64, content, documentIdentity, lastSavedContent, previewRevision, workspaceRoot]);
  const paneStateRef = useRef(paneState);
  paneStateRef.current = paneState;

  useEffect(() => sessionQueue.subscribeBusy(setBusy), [sessionQueue]);

  return { activeDocumentWatchTransport, dirty, fileTree, paneState, paneStateRef };
}

export type DocumentSessionDerived = ReturnType<typeof useDocumentDerivedState>;

export function useDocumentCoreHooks(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
) {
  const {
    activeFileVersionRef, activePathRef, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    externalFileActionRef, forcedDirtyCrashDraftIdRef, isPopout, localeRef, saveConflictRef,
    sessionQueue, setActiveFileKind, setActiveMimeType, setActivePath, setAuthorityStatus,
    setBytesBase64, setContent, setDirectories, setDocumentIdentity, setError, setFiles,
    setLastSavedContent, setPreviewRevision, setSaveConflict, setWorkspaceRoot,
    workspaceDirectoriesRef, workspaceFilesRef, workspaceIdentityRef, workspaceRollbackIdRef,
    workspaceSessionRestoreSettledRef,
  } = stores;
  const { paneStateRef } = derived;
  const coreStateDeps = {
    activeFileVersionRef, activePathRef, externalFileActionRef, isPopout, localeRef, paneStateRef,
    saveConflictRef, sessionQueue, setActiveFileKind, setActiveMimeType, setActivePath,
    setAuthorityStatus, setBytesBase64, setContent, setDirectories, setDocumentIdentity, setError,
    setFiles, setLastSavedContent, setPreviewRevision, setSaveConflict, setWorkspaceRoot,
    workspaceDirectoriesRef, workspaceFilesRef, workspaceIdentityRef, workspaceRollbackIdRef,
    workspaceSessionRestoreSettledRef,
  };
  const { consumeMutationOutcome, executeSessionOperation } = useSessionOperationQueue(coreStateDeps);
  const { applyWorkspaceSnapshot, rollbackWorkspaceState, workspaceRollback } = useWorkspaceSnapshotState(coreStateDeps);
  const stateApplication = useDocumentStateApplication(coreStateDeps);
  const { applyDocumentSessionState, currentDocumentSessionState, setActiveDocumentPath } = stateApplication;
  const { clearActiveDocument, lockDocumentAuthorityUnknown, openIntentResolutionBlocked, ordinaryDocumentActionsBlocked, setSaveConflictState } = useDocumentActionGuards(coreStateDeps, stateApplication);

  const advanceCrashDraftIdentity = useCallback((priorDocumentId: string) => {
    crashDraftSchedulerRef.current?.invalidate(priorDocumentId);
    crashDraftDocumentIdRef.current = createCrashDraftDocumentId();
    forcedDirtyCrashDraftIdRef.current = null;
  }, []);

  return {
    consumeMutationOutcome, executeSessionOperation, applyWorkspaceSnapshot, rollbackWorkspaceState,
    workspaceRollback, applyDocumentSessionState, currentDocumentSessionState, setActiveDocumentPath,
    clearActiveDocument, lockDocumentAuthorityUnknown, openIntentResolutionBlocked,
    ordinaryDocumentActionsBlocked, setSaveConflictState, advanceCrashDraftIdentity,
  };
}

export type DocumentSessionCore = ReturnType<typeof useDocumentCoreHooks>;
