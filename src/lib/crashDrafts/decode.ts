import type { CrashDraftSnapshot, CrashDraftWriteRequest } from './types';

export { createCrashDraftDocumentId, hasValidPathAndBase, isDocumentId, isFileKind, isSafeInteger, isToken } from './decodeHelpers';
export { decodeCrashDraftCatalog } from './decodeCatalog';
export {
  decodeCrashDraftDiscardResponse,
  decodeCrashDraftOverflowResetProgress,
  decodeCrashDraftRecoverResponse,
  decodeCrashDraftResetResponse,
  decodeCrashDraftWriteResponse,
  projectCrashDraftError,
} from './decodeResponses';

export interface SchedulerState {
  epoch: number;
  nextRevision: number;
  latestIdentity: CrashDraftSnapshot | null;
  pending: CrashDraftWriteRequest | null;
  firstPendingAt: number | null;
  inflight: boolean;
  ready: boolean;
  failure: { status: 'none' } | { status: 'failed'; error: unknown };
  entryToken: string | null;
  waiters: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CrashDraftSchedulerOptions {
  isMainWindow: boolean;
  write: (request: CrashDraftWriteRequest) => Promise<unknown>;
  debounceMs?: number;
  maxLatencyMs?: number;
  now?: () => number;
}

export interface CrashDraftScheduler {
  seedRevision(documentId: string, draftRevision: number, entryToken?: string): void;
  schedule(snapshot: CrashDraftSnapshot): number | null;
  flush(documentId: string): Promise<void>;
  flushBefore<T>(documentId: string, action: () => Promise<T> | T): Promise<T>;
  invalidate(documentId: string): void;
  hasPending(documentId: string): boolean;
  getStoredEntryToken(documentId: string): string | null;
  confirmDiscarded(documentId: string, expectedEntryToken: string): void;
  dispose(): void;
}
