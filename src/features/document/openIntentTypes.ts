import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { EffectiveLocale } from '../../lib/locale';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import type { DocumentSessionState, WorkspaceIdentity } from '../../lib/documentSession';
import type { FileVersion, WorkspaceDirectoryEntry, WorkspaceFileEntry, WorkspaceSnapshot } from '../../types';
import type { DocumentSessionQueueOperation, DocumentSessionQueueResult } from '../../lib/documentSessionQueue';
import type { ActiveWorkspaceIdentity } from './sessionTypes';

export interface OpenIntentDeps {
  activeFileVersionRef: RefObject<FileVersion | null>;
  advanceCrashDraftIdentity: (priorDocumentId: string) => void;
  afterConfirmedSave: ((documentId: string) => boolean | void | Promise<boolean | void>) | undefined;
  applyDocumentSessionState: (next: DocumentSessionState) => void;
  applyWorkspaceSnapshot: (response: WorkspaceSnapshot) => void;
  crashDraftDocumentIdRef: RefObject<string>;
  crashDraftSchedulerRef: RefObject<CrashDraftScheduler | null>;
  currentDocumentSessionState: () => DocumentSessionState;
  documentGenerationRef: RefObject<number>;
  documentOpenRequestRef: RefObject<number>;
  executeSessionOperation: <T>(operation: DocumentSessionQueueOperation<T>) => Promise<DocumentSessionQueueResult<T> | null>;
  getActiveWorkspace: () => ActiveWorkspaceIdentity | null;
  isCurrentWorkspaceRequest: (requestedWorkspace: ActiveWorkspaceIdentity, requestedGeneration: number) => boolean;
  localeRef: RefObject<EffectiveLocale>;
  openIntentResolutionBlocked: () => boolean;
  ordinaryDocumentActionsBlocked: () => boolean;
  rollbackWorkspaceState: (prior: WorkspaceSnapshot | null) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  settleWorkspaceSessionRestore: () => void;
  workspaceDirectoriesRef: RefObject<WorkspaceDirectoryEntry[]>;
  workspaceFilesRef: RefObject<WorkspaceFileEntry[]>;
  workspaceGenerationRef: RefObject<number>;
  workspaceIdentityRef: RefObject<WorkspaceIdentity>;
  workspaceSessionRestoreMountedRef: RefObject<boolean>;
}
