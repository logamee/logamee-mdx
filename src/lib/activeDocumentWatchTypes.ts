import type { OpenFileResponse } from '../types';
import type { UnlistenFn } from '@tauri-apps/api/event';

export const ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION = 1;

export type ActiveDocumentDiskSnapshot =
  | { status: 'present'; file: OpenFileResponse; preview_revision: number }
  | { status: 'missing'; path: string };

export interface ActiveDocumentWatchRegistration {
  protocol_version: 1;
  watch_id: string;
  document_id: string;
  document_generation: number;
  sequence: number;
  snapshot: ActiveDocumentDiskSnapshot;
}

export type ActiveDocumentWatchReason = 'changed' | 'renamed' | 'resync' | 'missing';

export interface ActiveDocumentWatchSnapshotEnvelope {
  protocol_version: 1;
  watch_id: string;
  document_id: string;
  document_generation: number;
  sequence: number;
  reason: ActiveDocumentWatchReason;
  previous_path: string | null;
  snapshot: ActiveDocumentDiskSnapshot;
}

export type ActiveDocumentWatchEvent = {
  protocol_version: 1;
  watch_id: string;
  document_id: string;
  document_generation: number;
  sequence: number;
  event:
    | {
      kind: 'state';
      reason: ActiveDocumentWatchReason;
      previous_path: string | null;
      snapshot: ActiveDocumentDiskSnapshot;
    }
    | { kind: 'health'; status: 'degraded' | 'failed'; message: string };
};

export interface ActiveDocumentWatchTransport {
  activate: (
    watchId: string,
    documentId: string,
    documentGeneration: number,
    registrationSequence: number,
  ) => Promise<boolean>;
  listen: (callback: (event: ActiveDocumentWatchEvent) => void) => Promise<UnlistenFn>;
  reconcile: (
    watchId: string,
    documentId: string,
    documentGeneration: number,
  ) => Promise<ActiveDocumentWatchSnapshotEnvelope>;
  start: (
    path: string,
    documentId: string,
    documentGeneration: number,
  ) => Promise<ActiveDocumentWatchRegistration>;
  stop: (watchId: string) => Promise<boolean>;
}

// reason 与 previous_path 形状判定：renamed 须带且不等于当前路径，missing/present 均不带。
export function watchReasonShapeIsValid(
  reason: ActiveDocumentWatchReason,
  previousPath: string | null,
  snapshot: ActiveDocumentDiskSnapshot,
): boolean {
  if (reason === 'renamed') {
    return typeof previousPath === 'string'
      && snapshot.status === 'present'
      && previousPath !== snapshot.file.path;
  }
  if (reason === 'missing') {
    return previousPath === null && snapshot.status === 'missing';
  }
  return previousPath === null && snapshot.status === 'present';
}
