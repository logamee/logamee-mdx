import type { UseDocumentSessionInput } from './sessionTypes';
import {
  useDocumentSessionRefs,
  useDocumentSessionState,
  type DocumentSessionStores,
} from './documentSessionStores';
import {
  useDocumentCoreHooks,
  useDocumentDerivedState,
} from './documentSessionRuntime';
import {
  useCrashDraftSessionRunner,
  useExternalChangesSession,
  useOpenIntentSession,
  useSaveConflictOverwriteSession,
  useSaveFlowSession,
  useWorkspaceMutationsSession,
} from './documentSessionComposition';
import { useDocumentEditingSurface } from './documentSessionEditingSurface';

export type { DocumentSaveConflictDialogState, ExternalFileActionDialogState } from './dialogState';

export function useDocumentSession(input: UseDocumentSessionInput) {
  const {
    autosaveEnabled = false,
    autosaveDelayMs = 1500,
    autosaveMode = 'afterDelay',
    ...rest
  } = input;
  const state = useDocumentSessionState(rest);
  const refs = useDocumentSessionRefs(state.restoreWorkspaceSessionOnMount);
  const stores: DocumentSessionStores = { ...rest, autosaveEnabled, autosaveDelayMs, autosaveMode, ...state, ...refs };
  const derived = useDocumentDerivedState(stores);
  const core = useDocumentCoreHooks(stores, derived);
  const external = useExternalChangesSession(stores, derived, core);
  const crash = useCrashDraftSessionRunner(stores, derived, core, external);
  const open = useOpenIntentSession(stores, core, external);
  const save = useSaveFlowSession(stores, derived, core, external, crash, open);
  const conflict = useSaveConflictOverwriteSession(stores, derived, core, external, crash, save);
  const mutations = useWorkspaceMutationsSession(stores, core, external, open);
  const editing = useDocumentEditingSurface(stores, derived, core, save);
  return {
    activeFileKind: stores.activeFileKind,
    activeMimeType: stores.activeMimeType, activePath: stores.activePath, authorityStatus: stores.authorityStatus,
    broadcastPaneState: external.broadcastPaneState, busy: stores.busy, bytesBase64: stores.bytesBase64,
    content: stores.content, dirty: derived.dirty, createFileInWorkspace: mutations.createFileInWorkspace,
    createFolderInWorkspace: mutations.createFolderInWorkspace, deleteWorkspaceEntryPath: mutations.deleteWorkspaceEntryPath,
    documentEpoch: stores.documentIdentity.documentEpoch,
    documentId: stores.documentIdentity.documentId, error: stores.error, externalFileAction: editing.externalFileActionDialog,
    files: stores.files, fileTree: derived.fileTree, flushWorkspaceSession: external.flushWorkspaceSession,
    flushCrashDraft: crash.flushCrashDraft, handleNew: crash.handleNew, handleOpenDirectory: open.handleOpenDirectory,
    handleOpenFile: open.handleOpenFile, handleOpenRecent: open.handleOpenRecent, handleClearRecent: open.handleClearRecent,
    handleCloseDeletedDraft: conflict.handleCloseDeletedDraft, handleKeepCurrentExternal: conflict.handleKeepCurrentExternal,
    handleCancelSaveConflict: conflict.handleCancelSaveConflict, handleOverwriteSaveConflict: conflict.handleOverwriteSaveConflict,
    handleSave: save.handleSave, handleSaveAs: save.handleSaveAs,
    handleSaveDeletedDraftAs: conflict.handleSaveDeletedDraftAs, handleUseExternal: conflict.handleUseExternal,
    lastSavedContent: stores.lastSavedContent, moveWorkspaceEntryPath: mutations.moveWorkspaceEntryPath,
    copyWorkspaceEntryPath: mutations.copyWorkspaceEntryPath, notice: stores.notice,
    openWorkspaceIndexResult: open.openWorkspaceIndexResult, openWorkspaceFilePath: open.openWorkspaceFilePath,
    resolveOpenIntentRequest: open.resolveOpenIntentRequest, previewRevision: stores.previewRevision,
    renameWorkspaceEntryPath: mutations.renameWorkspaceEntryPath, refreshWorkspace: external.refreshWorkspace,
    recoverCrashDraft: crash.recoverCrashDraft, saveCurrentDocument: save.saveCurrentDocument,
    saveConflict: editing.saveConflictDialog, seedCrashDraftRevision: crash.seedCrashDraftRevision,
    getCrashDraftStoredEntryToken: crash.getCrashDraftStoredEntryToken, confirmCrashDraftDiscarded: crash.confirmCrashDraftDiscarded,
    setError: stores.setError, settleWorkspaceSessionRestore: external.settleWorkspaceSessionRestore, setNotice: stores.setNotice,
    updateContent: editing.updateContent, workspaceRoot: stores.workspaceRoot, workspaceRollback: core.workspaceRollback,
    workspaceSessionRestoreSettled: stores.workspaceSessionRestoreSettled,
    workspaceToken: stores.workspaceIdentityRef.current.workspaceToken,
  };
}
