import type { DocumentState } from './documentSessionTypes';
import { isEditableFileKind } from './documentSessionWorkspace';

export type {
  DocumentAuthorityStatus,
  DocumentSessionState,
  DocumentState,
} from './documentSessionTypes';
export {
  createProvisionalDocumentTransition,
  finalizeProvisionalDocument,
  nextPreparedOpenGeneration,
  resolveOpenCommitOutcome,
  restoreDocumentSnapshot,
} from './documentSessionState';
export type { WorkspaceIdentity } from './documentSessionWorkspace';
export {
  applyWorkspaceSelection,
  createDocumentSaveOperationId,
  getEditableFileKindForPath,
  getMutationOutcomeMessage,
  getOpenedDocumentState,
  getWorkspaceDirectoryListingState,
  isCurrentWorkspaceIdentity,
  isEditableFileKind,
  reconcileWorkspaceReceipt,
} from './documentSessionWorkspace';
export {
  createWorkspaceDirectoryAndReconcile,
  deleteWorkspaceEntryAndReconcile,
  moveWorkspaceEntryAndReconcile,
  renameWorkspaceEntryAndReconcile,
} from './documentSessionMutations';

export function isDocumentDirty(state: Pick<DocumentState, 'activeFileKind' | 'content' | 'lastSavedContent'>): boolean {
  return isEditableFileKind(state.activeFileKind) && state.content !== state.lastSavedContent;
}
