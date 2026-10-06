import type { WorkspaceFileKind } from '../types';
import type { DocumentAuthorityStatus } from './documentSession';

export const PANE_STATE_EVENT = 'mmd-pane-state';
export const PANE_STATE_REQUEST_EVENT = 'mmd-pane-state-request';
export const PANE_CONTENT_CHANGE_EVENT = 'mmd-pane-content-change';
export const PANE_PROTOCOL_VERSION = 2;
export const PANE_BINARY_SOURCE_LIMITS = Object.freeze({
  pdf: 64 * 1024 * 1024,
  docx: 32 * 1024 * 1024,
});

interface PaneStatePayload {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  bytesBase64?: string | null;
  content: string;
  lastSavedContent: string;
  previewRevision: number;
  authorityStatus?: DocumentAuthorityStatus;
  workspaceRoot: string | null;
}

interface PaneDocumentIdentity {
  documentId: string;
  documentEpoch: number;
}

export type PaneReplicatedState = PaneStatePayload & PaneDocumentIdentity;

export interface PaneSnapshotEnvelope extends PaneDocumentIdentity {
  protocolVersion: 2;
  authorityId: string;
  revision: number;
  state: PaneReplicatedState;
}

export interface PaneContentEnvelope extends PaneDocumentIdentity {
  protocolVersion: 2;
  authorityId: string;
  sourceId: string;
  sequence: number;
  content: string;
}

export interface PaneSnapshotRequestEnvelope {
  protocolVersion: 2;
  requesterId: string;
}

export type ReplicaRole = 'main' | 'editor-popout' | 'preview-popout';
export type PaneUnlisten = () => void;

export interface PaneTransport {
  listen(listener: (input: unknown) => void): Promise<PaneUnlisten>;
  emit(input: unknown): void;
}

export interface PaneCache {
  read(): unknown;
  remove(): void;
  write(snapshot: PaneSnapshotEnvelope): void;
}

export interface PaneScheduler {
  schedule(task: () => void): void;
}

export const immediatePaneScheduler: PaneScheduler = {
  schedule: (task) => task(),
};

export type PaneReplicationOptions = {
  cache: PaneCache;
  transport: PaneTransport;
  observe: (snapshot: PaneSnapshotEnvelope) => void;
  onError?: (error: unknown) => void;
} & (
  | { role: 'main'; authorityId: string; requesterId?: never; scheduler?: PaneScheduler; sourceId?: never }
  | { role: 'editor-popout'; authorityId?: never; requesterId: string; scheduler?: never; sourceId: string }
  | { role: 'preview-popout'; authorityId?: never; requesterId: string; scheduler?: never; sourceId?: never }
);
