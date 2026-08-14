export type CrashDraftFileKind = 'markdown' | 'html' | 'excalidraw';

export interface CrashDraftLimits {
  maxDraftBytes: number;
  maxDrafts: number;
  maxStoreBytes: number;
}

export interface RecoverableCrashDraftEntry {
  status: 'recoverable';
  documentId: string;
  draftRevision: number;
  updatedAtUnixMs: number;
  contentBytes: number;
  pathHint: string | null;
  baseVersionToken: string | null;
  fileKind: CrashDraftFileKind;
  entryToken: string;
}

export interface CorruptCrashDraftEntry {
  status: 'corrupt';
  documentId: string;
  rawBytes: number;
  reason: 'malformed' | 'invalidMetadata' | 'checksumMismatch' | 'oversized';
  entryToken: string;
}

export interface UnsupportedCrashDraftEntry {
  status: 'unsupportedVersion';
  documentId: string;
  rawBytes: number;
  schemaVersion: number;
  entryToken: string;
}

export type CrashDraftCatalogEntry =
  | RecoverableCrashDraftEntry
  | CorruptCrashDraftEntry
  | UnsupportedCrashDraftEntry;

export interface CrashDraftCatalog {
  schemaVersion: 1;
  catalogToken: string;
  totalBytes: number;
  entries: CrashDraftCatalogEntry[];
  limits: CrashDraftLimits;
}

export interface CrashDraftSnapshot {
  documentId: string;
  fileKind: CrashDraftFileKind;
  pathHint: string | null;
  baseVersionToken: string | null;
  content: string;
}

export interface CrashDraftWriteRequest extends CrashDraftSnapshot {
  draftRevision: number;
}

export interface CrashDraftWriteResponse {
  status: 'stored' | 'unchanged';
  documentId: string;
  draftRevision: number;
  entryToken: string;
  updatedAtUnixMs: number;
  evictedDocumentIds: string[];
}

export interface CrashDraftRecoverResponse extends CrashDraftSnapshot {
  draftRevision: number;
  updatedAtUnixMs: number;
  entryToken: string;
}

export type CrashDraftDiscardResponse = {
  status: 'confirmedDiscarded' | 'conflict' | 'indeterminate';
};

export type CrashDraftResetResponse = {
  status: 'confirmedReset' | 'conflict' | 'indeterminate';
};

export type CrashDraftErrorCode =
  | 'invalidRequest'
  | 'oversized'
  | 'storeFull'
  | 'revisionConflict'
  | 'corrupt'
  | 'unsupportedVersion'
  | 'notFound'
  | 'persistence'
  | 'indeterminate'
  | 'notInitialized';

export interface ProjectedCrashDraftError {
  code: CrashDraftErrorCode;
  message: string;
  canReset: boolean;
  repairReceipt?: string;
}

export type CrashDraftOverflowResetProgress =
  | { removedEntries: number; blockedEntries: number; moreWorkRemaining: false }
  | { removedEntries: number; blockedEntries: number; moreWorkRemaining: true; repairReceipt: string };

const DOCUMENT_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const FILE_KINDS: readonly CrashDraftFileKind[] = ['markdown', 'html', 'excalidraw'];
const CORRUPT_REASONS: readonly CorruptCrashDraftEntry['reason'][] = [
  'malformed', 'invalidMetadata', 'checksumMismatch', 'oversized',
];
const ERROR_CODES: readonly CrashDraftErrorCode[] = [
  'invalidRequest', 'oversized', 'storeFull', 'revisionConflict', 'corrupt',
  'unsupportedVersion', 'notFound', 'persistence', 'indeterminate', 'notInitialized',
];

export function createCrashDraftDocumentId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function isFileKind(value: unknown): value is CrashDraftFileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

function hasValidPathAndBase(pathHint: unknown, baseVersionToken: unknown): boolean {
  return (pathHint === null && baseVersionToken === null)
    || (typeof pathHint === 'string' && pathHint.length > 0 && isToken(baseVersionToken));
}

function invalidCatalog(): never {
  throw new Error('Invalid crash draft catalog response');
}

function invalidWriteResponse(): never {
  throw new Error('Invalid crash draft write response');
}

function invalidRecoverResponse(): never {
  throw new Error('Invalid crash draft recover response');
}

function decodeCatalogEntry(value: unknown): CrashDraftCatalogEntry {
  if (!isRecord(value) || typeof value.status !== 'string') return invalidCatalog();
  if (value.status === 'recoverable') {
    if (
      !hasExactKeys(value, [
        'status', 'documentId', 'draftRevision', 'updatedAtUnixMs', 'contentBytes',
        'pathHint', 'baseVersionToken', 'fileKind', 'entryToken',
      ])
      || !isDocumentId(value.documentId)
      || !isSafeInteger(value.draftRevision, 1)
      || !isSafeInteger(value.updatedAtUnixMs)
      || !isSafeInteger(value.contentBytes)
      || !hasValidPathAndBase(value.pathHint, value.baseVersionToken)
      || !isFileKind(value.fileKind)
      || !isToken(value.entryToken)
    ) return invalidCatalog();
    return value as unknown as RecoverableCrashDraftEntry;
  }
  if (value.status === 'corrupt') {
    if (
      !hasExactKeys(value, ['status', 'documentId', 'rawBytes', 'reason', 'entryToken'])
      || !isDocumentId(value.documentId)
      || !isSafeInteger(value.rawBytes)
      || typeof value.reason !== 'string'
      || !(CORRUPT_REASONS as readonly string[]).includes(value.reason)
      || !isToken(value.entryToken)
    ) return invalidCatalog();
    return value as unknown as CorruptCrashDraftEntry;
  }
  if (value.status === 'unsupportedVersion') {
    if (
      !hasExactKeys(value, ['status', 'documentId', 'rawBytes', 'schemaVersion', 'entryToken'])
      || !isDocumentId(value.documentId)
      || !isSafeInteger(value.rawBytes)
      || !isSafeInteger(value.schemaVersion, 1)
      || !isToken(value.entryToken)
    ) return invalidCatalog();
    return value as unknown as UnsupportedCrashDraftEntry;
  }
  return invalidCatalog();
}

export function decodeCrashDraftCatalog(value: unknown): CrashDraftCatalog {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'catalogToken', 'totalBytes', 'entries', 'limits'])
    || value.schemaVersion !== 1
    || !isToken(value.catalogToken)
    || !isSafeInteger(value.totalBytes)
    || !Array.isArray(value.entries)
    || !isRecord(value.limits)
    || !hasExactKeys(value.limits, ['maxDraftBytes', 'maxDrafts', 'maxStoreBytes'])
    || !isSafeInteger(value.limits.maxDraftBytes, 1)
    || !isSafeInteger(value.limits.maxDrafts, 1)
    || !isSafeInteger(value.limits.maxStoreBytes, 1)
    || value.limits.maxDraftBytes > value.limits.maxStoreBytes
    || value.totalBytes > value.limits.maxStoreBytes
    || value.entries.length > value.limits.maxDrafts
  ) return invalidCatalog();

  const limits = value.limits as unknown as CrashDraftLimits;
  const entries = value.entries.map(decodeCatalogEntry);
  if (new Set(entries.map((entry) => entry.documentId)).size !== entries.length) return invalidCatalog();
  if (entries.some((entry) => entry.status === 'recoverable' && entry.contentBytes > limits.maxDraftBytes)) {
    return invalidCatalog();
  }
  return {
    schemaVersion: 1,
    catalogToken: value.catalogToken,
    totalBytes: value.totalBytes,
    entries,
    limits,
  };
}

export function decodeCrashDraftWriteResponse(value: unknown): CrashDraftWriteResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'status', 'documentId', 'draftRevision', 'entryToken', 'updatedAtUnixMs', 'evictedDocumentIds',
    ])
    || (value.status !== 'stored' && value.status !== 'unchanged')
    || !isDocumentId(value.documentId)
    || !isSafeInteger(value.draftRevision, 1)
    || !isToken(value.entryToken)
    || !isSafeInteger(value.updatedAtUnixMs)
    || !Array.isArray(value.evictedDocumentIds)
    || !value.evictedDocumentIds.every(isDocumentId)
    || new Set(value.evictedDocumentIds).size !== value.evictedDocumentIds.length
  ) return invalidWriteResponse();
  return value as unknown as CrashDraftWriteResponse;
}

export function decodeCrashDraftRecoverResponse(value: unknown): CrashDraftRecoverResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'documentId', 'draftRevision', 'fileKind', 'pathHint', 'baseVersionToken',
      'content', 'updatedAtUnixMs', 'entryToken',
    ])
    || !isDocumentId(value.documentId)
    || !isSafeInteger(value.draftRevision, 1)
    || !isFileKind(value.fileKind)
    || !hasValidPathAndBase(value.pathHint, value.baseVersionToken)
    || typeof value.content !== 'string'
    || !isSafeInteger(value.updatedAtUnixMs)
    || !isToken(value.entryToken)
  ) return invalidRecoverResponse();
  return value as unknown as CrashDraftRecoverResponse;
}

function decodeStatusOnly<T extends string>(
  value: unknown,
  statuses: readonly T[],
  errorMessage: string,
): { status: T } {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['status'])
    || typeof value.status !== 'string'
    || !(statuses as readonly string[]).includes(value.status)
  ) throw new Error(errorMessage);
  return { status: value.status as T };
}

export function decodeCrashDraftDiscardResponse(value: unknown): CrashDraftDiscardResponse {
  return decodeStatusOnly(
    value,
    ['confirmedDiscarded', 'conflict', 'indeterminate'],
    'Invalid crash draft discard response',
  );
}

export function decodeCrashDraftResetResponse(value: unknown): CrashDraftResetResponse {
  return decodeStatusOnly(
    value,
    ['confirmedReset', 'conflict', 'indeterminate'],
    'Invalid crash draft reset response',
  );
}

export function decodeCrashDraftOverflowResetProgress(value: unknown): CrashDraftOverflowResetProgress {
  if (
    !isRecord(value)
    || typeof value.moreWorkRemaining !== 'boolean'
    || !isSafeInteger(value.removedEntries)
    || !isSafeInteger(value.blockedEntries)
  ) throw new Error('Invalid crash draft overflow reset response');
  if (value.moreWorkRemaining) {
    if (
      !hasExactKeys(value, ['removedEntries', 'blockedEntries', 'moreWorkRemaining', 'repairReceipt'])
      || !isToken(value.repairReceipt)
    ) throw new Error('Invalid crash draft overflow reset response');
    return {
      removedEntries: value.removedEntries,
      blockedEntries: value.blockedEntries,
      moreWorkRemaining: true,
      repairReceipt: value.repairReceipt,
    };
  }
  if (!hasExactKeys(value, ['removedEntries', 'blockedEntries', 'moreWorkRemaining'])) {
    throw new Error('Invalid crash draft overflow reset response');
  }
  return {
    removedEntries: value.removedEntries,
    blockedEntries: value.blockedEntries,
    moreWorkRemaining: false,
  };
}

const SAFE_ERROR_MESSAGES: Record<CrashDraftErrorCode, string> = {
  invalidRequest: 'The crash draft request was rejected. Your current edits remain in the editor.',
  oversized: 'This draft is too large for crash recovery. Save the document to keep these edits.',
  storeFull: 'Crash draft storage is full. Save important documents to keep their edits.',
  revisionConflict: 'The crash draft changed before this operation completed. Reload the recovery list and try again.',
  corrupt: 'A damaged crash draft cannot be recovered. You can discard it safely.',
  unsupportedVersion: 'Some drafts were created by a newer mdx version and were left unchanged.',
  notFound: 'This crash draft is no longer available. Reload the recovery list.',
  persistence: 'Crash drafts could not be saved. Your current edits remain in the editor.',
  indeterminate: 'The crash draft operation could not be confirmed. Reload the recovery list before trying again.',
  notInitialized: 'Crash recovery is not ready yet. Your current edits remain in the editor.',
};

export function projectCrashDraftError(value: unknown): ProjectedCrashDraftError {
  if (!isRecord(value) || typeof value.code !== 'string' || !(ERROR_CODES as readonly string[]).includes(value.code)) {
    return { code: 'persistence', message: SAFE_ERROR_MESSAGES.persistence, canReset: false };
  }
  const code = value.code as CrashDraftErrorCode;
  const resetAllowed = code === 'corrupt' || code === 'persistence' || code === 'indeterminate';
  const projected: ProjectedCrashDraftError = {
    code,
    message: SAFE_ERROR_MESSAGES[code],
    canReset: resetAllowed && value.canReset === true,
  };
  if (isToken(value.repairReceipt)) projected.repairReceipt = value.repairReceipt;
  return projected;
}

interface SchedulerState {
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

function sameSnapshot(left: CrashDraftSnapshot | null, right: CrashDraftSnapshot): boolean {
  return left !== null
    && left.documentId === right.documentId
    && left.fileKind === right.fileKind
    && left.pathHint === right.pathHint
    && left.baseVersionToken === right.baseVersionToken
    && left.content === right.content;
}

function validateSnapshot(snapshot: CrashDraftSnapshot): void {
  if (
    !isDocumentId(snapshot.documentId)
    || !isFileKind(snapshot.fileKind)
    || !hasValidPathAndBase(snapshot.pathHint, snapshot.baseVersionToken)
    || typeof snapshot.content !== 'string'
  ) throw new Error('Invalid crash draft snapshot');
}

export function createCrashDraftScheduler(options: CrashDraftSchedulerOptions): CrashDraftScheduler {
  const debounceMs = options.debounceMs ?? 500;
  const maxLatencyMs = options.maxLatencyMs ?? 2000;
  if (!isSafeInteger(debounceMs, 1) || !isSafeInteger(maxLatencyMs, debounceMs)) {
    throw new Error('Invalid crash draft scheduler timing');
  }
  const now = options.now ?? Date.now;
  const states = new Map<string, SchedulerState>();
  const readyQueue: Array<{ documentId: string; epoch: number }> = [];
  let activeWrite: Promise<void> | null = null;
  let disposed = false;

  const active = (documentId: string, state: SchedulerState, epoch: number) => (
    !disposed && states.get(documentId) === state && state.epoch === epoch
  );

  const clearScheduledTimer = (state: SchedulerState) => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  };

  const notifyStateChanged = (state: SchedulerState) => {
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  };

  const throwStoredFailure = (state: SchedulerState) => {
    if (state.failure.status === 'failed') throw state.failure.error;
  };

  function pump(): void {
    if (disposed || activeWrite) return;
    let queued: { documentId: string; epoch: number } | undefined;
    let state: SchedulerState | undefined;
    while ((queued = readyQueue.shift()) !== undefined) {
      const candidate = states.get(queued.documentId);
      if (candidate?.ready && candidate.pending && candidate.epoch === queued.epoch) {
        state = candidate;
        break;
      }
    }
    if (!queued || !state || !state.pending) return;

    const { documentId } = queued;
    const request = state.pending;
    const epoch = state.epoch;
    state.pending = null;
    state.firstPendingAt = null;
    state.ready = false;
    state.inflight = true;
    clearScheduledTimer(state);

    activeWrite = (async () => {
      try {
        const response = decodeCrashDraftWriteResponse(await options.write(request));
        if (response.documentId !== request.documentId || response.draftRevision !== request.draftRevision) {
          throw new Error('Crash draft write response did not match request');
        }
        state.entryToken = response.entryToken;
        for (const evictedDocumentId of response.evictedDocumentIds) {
          const evicted = states.get(evictedDocumentId);
          if (evicted) evicted.entryToken = null;
        }
      } catch (error) {
        if (active(documentId, state, epoch) && state.pending === null) {
          state.pending = request;
          state.firstPendingAt = now();
          state.failure = {
            status: 'failed',
            error: error ? error : new Error('Crash draft write failed'),
          };
        }
      } finally {
        state.inflight = false;
        activeWrite = null;
        notifyStateChanged(state);
        pump();
      }
    })();
  }

  const markReady = (documentId: string, state: SchedulerState) => {
    clearScheduledTimer(state);
    if (!state.pending || state.ready) return;
    state.ready = true;
    readyQueue.push({ documentId, epoch: state.epoch });
    pump();
  };

  const scheduleTimer = (documentId: string, state: SchedulerState) => {
    if (state.ready) return;
    clearScheduledTimer(state);
    const epoch = state.epoch;
    const elapsed = state.firstPendingAt === null ? 0 : Math.max(0, now() - state.firstPendingAt);
    const delay = Math.min(debounceMs, Math.max(0, maxLatencyMs - elapsed));
    state.timer = setTimeout(() => {
      if (!active(documentId, state, epoch)) return;
      state.timer = null;
      markReady(documentId, state);
    }, delay);
  };

  const getState = (documentId: string): SchedulerState => {
    const existing = states.get(documentId);
    if (existing) return existing;
    const created: SchedulerState = {
      epoch: 0,
      nextRevision: 0,
      latestIdentity: null,
      pending: null,
      firstPendingAt: null,
      inflight: false,
      ready: false,
      failure: { status: 'none' },
      entryToken: null,
      waiters: new Set(),
      timer: null,
    };
    states.set(documentId, created);
    return created;
  };

  const flush = async (documentId: string): Promise<void> => {
    if (!options.isMainWindow || disposed) return;
    if (!isDocumentId(documentId)) throw new Error('Invalid crash draft document ID');
    const state = states.get(documentId);
    if (!state) return;
    state.failure = { status: 'none' };
    if (state.pending) markReady(documentId, state);
    while (state.inflight || state.pending || state.ready) {
      throwStoredFailure(state);
      if (state.pending && !state.ready && !state.inflight) markReady(documentId, state);
      await new Promise<void>((resolve) => state.waiters.add(resolve));
      if (disposed) return;
    }
    throwStoredFailure(state);
  };

  return {
    seedRevision(documentId, draftRevision, entryToken) {
      if (!options.isMainWindow || disposed) return;
      if (
        !isDocumentId(documentId)
        || !isSafeInteger(draftRevision, 1)
        || (entryToken !== undefined && !isToken(entryToken))
      ) {
        throw new Error('Invalid crash draft revision seed');
      }
      const state = getState(documentId);
      if (state.pending || state.inflight || state.ready || draftRevision < state.nextRevision) {
        throw new Error('Invalid crash draft revision seed');
      }
      state.nextRevision = draftRevision;
      state.latestIdentity = null;
      state.failure = { status: 'none' };
      if (entryToken !== undefined) state.entryToken = entryToken;
    },
    schedule(snapshot) {
      if (!options.isMainWindow || disposed) return null;
      validateSnapshot(snapshot);
      const state = getState(snapshot.documentId);
      if (sameSnapshot(state.latestIdentity, snapshot)) {
        if (state.failure.status === 'failed' && state.pending) {
          state.failure = { status: 'none' };
          state.firstPendingAt ??= now();
          scheduleTimer(snapshot.documentId, state);
        }
        return state.nextRevision;
      }
      if (state.nextRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Crash draft revision exhausted');
      }
      state.nextRevision += 1;
      state.latestIdentity = {
        documentId: snapshot.documentId,
        fileKind: snapshot.fileKind,
        pathHint: snapshot.pathHint,
        baseVersionToken: snapshot.baseVersionToken,
        content: snapshot.content,
      };
      state.pending = {
        documentId: snapshot.documentId,
        draftRevision: state.nextRevision,
        fileKind: snapshot.fileKind,
        pathHint: snapshot.pathHint,
        baseVersionToken: snapshot.baseVersionToken,
        content: snapshot.content,
      };
      state.failure = { status: 'none' };
      state.firstPendingAt ??= now();
      scheduleTimer(snapshot.documentId, state);
      return state.nextRevision;
    },
    flush,
    async flushBefore(documentId, action) {
      await flush(documentId);
      return action();
    },
    invalidate(documentId) {
      const state = states.get(documentId);
      if (!state) return;
      state.epoch += 1;
      clearScheduledTimer(state);
      state.pending = null;
      state.firstPendingAt = null;
      state.latestIdentity = null;
      state.ready = false;
      state.failure = { status: 'none' };
      notifyStateChanged(state);
    },
    hasPending(documentId) {
      const state = states.get(documentId);
      return Boolean(state && (state.pending !== null || state.inflight || state.ready));
    },
    getStoredEntryToken(documentId) {
      return states.get(documentId)?.entryToken ?? null;
    },
    confirmDiscarded(documentId, expectedEntryToken) {
      const state = states.get(documentId);
      if (!state || state.entryToken !== expectedEntryToken) return;
      state.entryToken = null;
      state.latestIdentity = null;
    },
    dispose() {
      disposed = true;
      for (const state of states.values()) {
        clearScheduledTimer(state);
        notifyStateChanged(state);
      }
      states.clear();
    },
  };
}
