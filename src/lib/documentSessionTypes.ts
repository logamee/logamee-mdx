import type { WorkspaceFileKind } from '../types';

export interface DocumentState {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  bytesBase64: string | null;
  content: string;
  lastSavedContent: string;
  previewRevision: number;
}

export type DocumentAuthorityStatus = 'committed' | 'provisional' | 'unknown' | 'failed';

export interface DocumentSessionState extends DocumentState {
  documentId: string;
  documentEpoch: number;
  authorityStatus: DocumentAuthorityStatus;
}

export interface ProvisionalDocumentTransition {
  prior: DocumentSessionState;
  provisional: DocumentSessionState & { authorityStatus: 'provisional' };
}
