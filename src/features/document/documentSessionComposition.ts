/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useExternalChanges, type ExternalChangesDeps } from './externalChanges';
import { useCrashDraftSession } from './crashDraftSession';
import { useOpenIntent } from './openIntent';
import { useSaveFlow, type SaveFlowDeps } from './saveFlow';
import { useSaveConflictOverwrite } from './saveConflictOverwrite';
import { useWorkspaceCreateFile, useWorkspaceCreateFolder } from './workspaceMutations';
import {
  useWorkspaceCopyEntry, useWorkspaceDeleteEntry, useWorkspaceMoveEntry, useWorkspaceRenameEntry,
} from './workspaceEntryMutations';
import type { DocumentSessionStores } from './documentSessionStores';
import type { DocumentSessionCore, DocumentSessionDerived } from './documentSessionRuntime';

export type ExternalChangesSessionApi = ReturnType<typeof useExternalChanges>;
export type SaveFlowSessionApi = ReturnType<typeof useSaveFlowSession>;

export function useExternalChangesSession(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
  core: DocumentSessionCore,
) {
  const {
    activeDocumentWatchRef, activeFileVersionRef, activePath, activePathRef, authorityStatus,
    crashDraftDocumentIdRef, crashDraftSchedulerRef, documentGenerationRef, documentIdentity,
    documentOpenRequestRef, externalFileActionRef, files, isPopout, localeRef, paneReplicationRef,
    popoutPane, sessionQueue, setContent, setError, setExternalFileAction, setNotice, setWorkspaceRoot,
    setWorkspaceSessionRestoreSettled, workspaceFilesRef, workspaceGenerationRef, workspaceIdentityRef,
    workspaceRoot, workspaceSessionPersistRevisionRef, workspaceSessionPersistTailRef,
    workspaceSessionRestoreMountedRef, workspaceSessionRestoreSettled, workspaceSessionRestoreSettledRef,
  } = stores;
  const { activeDocumentWatchTransport, paneState, paneStateRef } = derived;
  const {
    advanceCrashDraftIdentity, applyDocumentSessionState, applyWorkspaceSnapshot,
    currentDocumentSessionState, executeSessionOperation, ordinaryDocumentActionsBlocked,
    setSaveConflictState,
  } = core;
  const __extDeps: ExternalChangesDeps = {
    paneState, sessionQueue, activeDocumentWatchRef, activeDocumentWatchTransport, activeFileVersionRef, activePath, activePathRef, advanceCrashDraftIdentity, applyDocumentSessionState, applyWorkspaceSnapshot, authorityStatus, crashDraftDocumentIdRef, crashDraftSchedulerRef, currentDocumentSessionState, documentGenerationRef, documentIdentity, documentOpenRequestRef, executeSessionOperation, externalFileActionRef, files, isPopout, localeRef, ordinaryDocumentActionsBlocked, paneReplicationRef, paneStateRef, popoutPane, saveConflictRef: stores.saveConflictRef, setContent, setError, setExternalFileAction, setNotice, setSaveConflictState, setWorkspaceRoot, setWorkspaceSessionRestoreSettled, workspaceFilesRef, workspaceGenerationRef, workspaceIdentityRef, workspaceRoot, workspaceSessionPersistRevisionRef, workspaceSessionPersistTailRef, workspaceSessionRestoreMountedRef, workspaceSessionRestoreSettled, workspaceSessionRestoreSettledRef,
  };
  return useExternalChanges(__extDeps);
}

export function useCrashDraftSessionRunner(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
  core: DocumentSessionCore,
  external: ExternalChangesSessionApi,
) {
  const {
    activeFileKind, activeFileVersionRef, activePath, afterConfirmedSave, authorityStatus, content,
    crashDraftDocumentIdRef, crashDraftSchedulerRef, documentGenerationRef, documentOpenRequestRef,
    forcedDirtyCrashDraftIdRef, isPopout,
  } = stores;
  const { dirty, paneStateRef } = derived;
  const {
    advanceCrashDraftIdentity, applyDocumentSessionState, clearActiveDocument,
    currentDocumentSessionState, ordinaryDocumentActionsBlocked, setSaveConflictState,
  } = core;
  const { setExternalFileActionState, stopAcceptedActiveDocumentWatch } = external;
  return useCrashDraftSession({
    activeFileKind, activeFileVersionRef, activePath, advanceCrashDraftIdentity, afterConfirmedSave,
    applyDocumentSessionState,
    authorityStatus, clearActiveDocument, content, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    currentDocumentSessionState, dirty, documentEpoch: stores.documentIdentity.documentEpoch,
    documentGenerationRef, documentOpenRequestRef, forcedDirtyCrashDraftIdRef, isPopout,
    ordinaryDocumentActionsBlocked, paneStateRef, setExternalFileActionState, setError: stores.setError,
    setSaveConflictState, stopAcceptedActiveDocumentWatch,
  });
}

export function useOpenIntentSession(
  stores: DocumentSessionStores,
  core: DocumentSessionCore,
  external: ExternalChangesSessionApi,
) {
  const {
    activeFileVersionRef, afterConfirmedSave, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    documentGenerationRef, documentOpenRequestRef, localeRef, setError, setNotice,
    workspaceDirectoriesRef, workspaceFilesRef, workspaceGenerationRef, workspaceIdentityRef,
    workspaceSessionRestoreMountedRef,
  } = stores;
  const {
    advanceCrashDraftIdentity, applyDocumentSessionState, applyWorkspaceSnapshot,
    currentDocumentSessionState, executeSessionOperation, openIntentResolutionBlocked,
    ordinaryDocumentActionsBlocked, rollbackWorkspaceState,
  } = core;
  const { getActiveWorkspace, isCurrentWorkspaceRequest, settleWorkspaceSessionRestore } = external;
  return useOpenIntent({
    getActiveWorkspace, isCurrentWorkspaceRequest, settleWorkspaceSessionRestore,
    activeFileVersionRef, advanceCrashDraftIdentity, afterConfirmedSave, applyDocumentSessionState, applyWorkspaceSnapshot, crashDraftDocumentIdRef, crashDraftSchedulerRef, currentDocumentSessionState, documentGenerationRef, documentOpenRequestRef, executeSessionOperation, localeRef, openIntentResolutionBlocked, ordinaryDocumentActionsBlocked, rollbackWorkspaceState, setError, setNotice, workspaceDirectoriesRef, workspaceFilesRef, workspaceGenerationRef, workspaceIdentityRef, workspaceSessionRestoreMountedRef,
  });
}

export function useSaveFlowSession(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
  core: DocumentSessionCore,
  external: ExternalChangesSessionApi,
  crash: ReturnType<typeof useCrashDraftSessionRunner>,
  open: ReturnType<typeof useOpenIntentSession>,
) {
  const {
    activeDocumentWatchRef, activeFileKind, activeFileVersionRef, activeMimeType, activePath,
    activePathRef, afterConfirmedSave, authorityStatus, busy, content, crashDraftDocumentIdRef,
    crashDraftSchedulerRef, directories, documentGenerationRef, documentIdentity,
    documentOpenRequestRef, error, externalFileActionRef, files, isPopout, lastSavedContent,
    localeRef, paneReplicationRef, popoutPane, previewRevision, saveConflictRef,
    setAuthorityStatus, setAutosaveBlockedContent, setContent, setError, setExternalFileAction,
    setLastSavedContent, setNotice, setSaveConflict, setWorkspaceRoot,
    setWorkspaceSessionRestoreSettled, workspaceDirectoriesRef, workspaceFilesRef,
    workspaceGenerationRef, workspaceIdentityRef, workspaceRoot, workspaceSessionPersistRevisionRef,
    workspaceSessionPersistTailRef, workspaceSessionRestoreMountedRef,
    workspaceSessionRestoreSettled, workspaceSessionRestoreSettledRef,
  } = stores;
  const { activeDocumentWatchTransport, paneStateRef } = derived;
  const {
    advanceCrashDraftIdentity, applyDocumentSessionState, applyWorkspaceSnapshot,
    currentDocumentSessionState, executeSessionOperation, lockDocumentAuthorityUnknown,
    ordinaryDocumentActionsBlocked, rollbackWorkspaceState, setSaveConflictState,
  } = core;
  const {
    applyExternalDocumentDecision, broadcastPaneState, enqueueActiveDocumentWatchEnvelope,
    enqueueActiveDocumentWatchHealth, envelopeMatchesAcceptedPath, flushWorkspaceSession,
    getActiveWorkspace, handleActiveDocumentWatchEvent, isAcceptedWatchCurrent,
    isCurrentWorkspaceRequest, reconcileRequestedWorkspaceReceipt, refreshWorkspace,
    refreshWorkspaceAfterExternalPathChange, refreshWorkspaceDirect, setExternalFileActionState,
    settleWorkspaceSessionRestore, stopAcceptedActiveDocumentWatch,
  } = external;
  const { cleanupConfirmedCrashDraft } = crash;
  const {
    applyOpenFileResponse, applyPreparedOpen, claimPreparedOpen, handleClearRecent,
    handleOpenDirectory, handleOpenFile, handleOpenRecent, openWorkspaceFilePath,
    openWorkspaceIndexResult, resolveOpenIntentRequest, synchronizeWorkspaceForStandaloneFile,
  } = open;
  const __saveDeps: SaveFlowDeps = {
    ordinaryDocumentActionsBlocked, setSaveConflictState, lockDocumentAuthorityUnknown, activeDocumentWatchRef, activeDocumentWatchTransport, activeFileKind, activeFileVersionRef, activeMimeType, activePath, activePathRef, advanceCrashDraftIdentity, afterConfirmedSave, applyDocumentSessionState, applyExternalDocumentDecision, applyOpenFileResponse, applyPreparedOpen, applyWorkspaceSnapshot, authorityStatus, broadcastPaneState, busy, claimPreparedOpen, cleanupConfirmedCrashDraft, content, crashDraftDocumentIdRef, crashDraftSchedulerRef, currentDocumentSessionState, directories, documentGenerationRef, documentIdentity, documentOpenRequestRef, enqueueActiveDocumentWatchEnvelope, enqueueActiveDocumentWatchHealth, envelopeMatchesAcceptedPath, error, executeSessionOperation, externalFileActionRef, files, flushWorkspaceSession, getActiveWorkspace, handleActiveDocumentWatchEvent, handleClearRecent, handleOpenDirectory, handleOpenFile, handleOpenRecent, isAcceptedWatchCurrent, isCurrentWorkspaceRequest, isPopout, lastSavedContent, localeRef, openWorkspaceFilePath, openWorkspaceIndexResult, paneReplicationRef, paneStateRef, popoutPane, previewRevision, reconcileRequestedWorkspaceReceipt, refreshWorkspace, refreshWorkspaceAfterExternalPathChange, refreshWorkspaceDirect, resolveOpenIntentRequest, rollbackWorkspaceState, saveConflictRef, setAuthorityStatus, setAutosaveBlockedContent, setContent, setError, setExternalFileAction, setExternalFileActionState, setLastSavedContent, setNotice, setSaveConflict, setWorkspaceRoot, setWorkspaceSessionRestoreSettled, settleWorkspaceSessionRestore, stopAcceptedActiveDocumentWatch, synchronizeWorkspaceForStandaloneFile, workspaceDirectoriesRef, workspaceFilesRef, workspaceGenerationRef, workspaceIdentityRef, workspaceRoot, workspaceSessionPersistRevisionRef, workspaceSessionPersistTailRef, workspaceSessionRestoreMountedRef, workspaceSessionRestoreSettled, workspaceSessionRestoreSettledRef,
  };
  return useSaveFlow(__saveDeps);
}

export function useSaveConflictOverwriteSession(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
  core: DocumentSessionCore,
  external: ExternalChangesSessionApi,
  crash: ReturnType<typeof useCrashDraftSessionRunner>,
  save: ReturnType<typeof useSaveFlowSession>,
) {
  const {
    activeDocumentWatchRef, activeFileVersionRef, activePathRef, crashDraftDocumentIdRef,
    crashDraftSchedulerRef, documentGenerationRef, documentOpenRequestRef, externalFileActionRef,
    isPopout, localeRef, saveConflictRef, sessionQueue, setError, setExternalFileActionBusy,
    setLastSavedContent, setNotice, workspaceGenerationRef, workspaceIdentityRef,
  } = stores;
  const { activeDocumentWatchTransport, paneStateRef } = derived;
  const {
    advanceCrashDraftIdentity, applyDocumentSessionState, clearActiveDocument,
    currentDocumentSessionState, executeSessionOperation, lockDocumentAuthorityUnknown,
    setSaveConflictState,
  } = core;
  const {
    applyExternalDocumentDecision, envelopeMatchesAcceptedPath, getActiveWorkspace,
    isCurrentWorkspaceRequest, refreshWorkspaceDirect, setExternalFileActionState,
    stopAcceptedActiveDocumentWatch,
  } = external;
  const { cleanupConfirmedCrashDraft } = crash;
  const { saveDocumentAs } = save;
  return useSaveConflictOverwrite({
    activeDocumentWatchRef, activeDocumentWatchTransport, activeFileVersionRef, activePathRef,
    advanceCrashDraftIdentity, applyDocumentSessionState, applyExternalDocumentDecision,
    cleanupConfirmedCrashDraft, clearActiveDocument, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    currentDocumentSessionState, documentGenerationRef, documentOpenRequestRef,
    envelopeMatchesAcceptedPath, executeSessionOperation, externalFileActionRef, getActiveWorkspace,
    isCurrentWorkspaceRequest, isPopout, localeRef, lockDocumentAuthorityUnknown, paneStateRef,
    refreshWorkspaceDirect, saveConflictRef, saveDocumentAs, sessionQueue, setError,
    setExternalFileActionBusy, setExternalFileActionState, setLastSavedContent, setNotice,
    setSaveConflictState, stopAcceptedActiveDocumentWatch, workspaceGenerationRef, workspaceIdentityRef,
  });
}

export function useWorkspaceMutationsSession(
  stores: DocumentSessionStores,
  core: DocumentSessionCore,
  external: ExternalChangesSessionApi,
  open: ReturnType<typeof useOpenIntentSession>,
) {
  const {
    activePathRef, crashDraftDocumentIdRef, crashDraftSchedulerRef, documentGenerationRef,
    setError, workspaceGenerationRef, workspaceIdentityRef,
  } = stores;
  const {
    advanceCrashDraftIdentity, applyWorkspaceSnapshot, clearActiveDocument, consumeMutationOutcome,
    executeSessionOperation, ordinaryDocumentActionsBlocked, setActiveDocumentPath,
  } = core;
  const { getActiveWorkspace, isCurrentWorkspaceRequest, reconcileRequestedWorkspaceReceipt, refreshWorkspaceDirect } = external;
  const { applyOpenFileResponse } = open;
  const workspaceMutationDeps = {
    activePathRef, advanceCrashDraftIdentity, applyOpenFileResponse, applyWorkspaceSnapshot,
    clearActiveDocument, consumeMutationOutcome, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    documentGenerationRef, executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked, reconcileRequestedWorkspaceReceipt, refreshWorkspaceDirect,
    setActiveDocumentPath, setError, workspaceGenerationRef, workspaceIdentityRef,
  };
  const { createFileInWorkspace } = useWorkspaceCreateFile(workspaceMutationDeps);
  const { createFolderInWorkspace } = useWorkspaceCreateFolder(workspaceMutationDeps);
  const { renameWorkspaceEntryPath } = useWorkspaceRenameEntry(workspaceMutationDeps);
  const { moveWorkspaceEntryPath } = useWorkspaceMoveEntry(workspaceMutationDeps);
  const { copyWorkspaceEntryPath } = useWorkspaceCopyEntry(workspaceMutationDeps);
  const { deleteWorkspaceEntryPath } = useWorkspaceDeleteEntry(workspaceMutationDeps);
  return {
    createFileInWorkspace, createFolderInWorkspace, renameWorkspaceEntryPath,
    moveWorkspaceEntryPath, copyWorkspaceEntryPath, deleteWorkspaceEntryPath,
  };
}
