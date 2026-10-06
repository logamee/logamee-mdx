import type { ActiveDocumentWatchSnapshotEnvelope, ActiveDocumentWatchTransport } from '../../lib/activeDocumentWatch';
import type { AutosaveMode } from '../../types';

export interface UseDocumentSessionInput {
  activeDocumentWatchTransport?: ActiveDocumentWatchTransport | null;
  isPopout: boolean;
  popoutPane: 'main' | 'editor' | 'preview';
  autosaveEnabled?: boolean;
  autosaveDelayMs?: number;
  autosaveMode?: AutosaveMode;
  afterConfirmedSave?: (documentId: string) => boolean | void | Promise<boolean | void>;
}

export type PreparedOpenApplyResult = 'committed' | 'not_committed' | 'indeterminate' | 'stale';

export interface ActiveWorkspaceIdentity {
  workspaceToken: string;
  workspaceRoot: string;
}

export interface AcceptedActiveDocumentWatch {
  documentGeneration: number;
  documentId: string;
  highestAppliedSequence: number;
  path: string;
  resolvedThroughSequence: number;
  watchId: string;
}

export interface ExternalFileActionState {
  envelope: ActiveDocumentWatchSnapshotEnvelope;
  kind: 'conflict' | 'deleted-draft';
}

export interface PendingDocumentSaveConflict {
  busy: boolean;
  content: string;
  documentGeneration: number;
  documentId: string;
  operationId: string;
  overwriteToken?: string;
  path: string;
  sourcePath: string | null;
  saveKind: 'same-file' | 'save-as';
  resumeExternalAction?: ExternalFileActionState;
}
