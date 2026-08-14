import type { OpenFileResponse } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { decodeOpenFileResponse } from './workspaceFileKind';

export const ACTIVE_DOCUMENT_WATCH_EVENT = 'mmd-active-document-watch';
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

interface ActiveDocumentWatchTransportOptions {
  onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const enumerableKeys = Reflect.ownKeys(value).filter((key) => (
    Object.prototype.propertyIsEnumerable.call(value, key)
  ));
  return enumerableKeys.length === expectedKeys.length
    && enumerableKeys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

function isProtocolId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWatchReason(value: unknown): value is ActiveDocumentWatchReason {
  return value === 'changed' || value === 'renamed' || value === 'resync' || value === 'missing';
}

function decodeActiveDocumentDiskSnapshot(value: unknown): ActiveDocumentDiskSnapshot {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('Invalid active document disk snapshot');
  }

  if (value.status === 'missing') {
    if (!hasExactKeys(value, ['status', 'path']) || typeof value.path !== 'string' || !value.path) {
      throw new Error('Invalid active document disk snapshot');
    }
    return { status: 'missing', path: value.path };
  }

  if (
    value.status !== 'present'
    || !hasExactKeys(value, ['status', 'file', 'preview_revision'])
    || !isNonNegativeSafeInteger(value.preview_revision)
  ) {
    throw new Error('Invalid active document disk snapshot');
  }

  try {
    const file = decodeOpenFileResponse(value.file);
    if (!file.path) throw new Error('empty path');
    return { status: 'present', file, preview_revision: value.preview_revision };
  } catch {
    throw new Error('Invalid active document disk snapshot');
  }
}

export function decodeActiveDocumentWatchRegistration(
  value: unknown,
): ActiveDocumentWatchRegistration {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'protocol_version',
      'watch_id',
      'document_id',
      'document_generation',
      'sequence',
      'snapshot',
    ])
    || value.protocol_version !== ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION
    || !isProtocolId(value.watch_id)
    || !isProtocolId(value.document_id)
    || !isNonNegativeSafeInteger(value.document_generation)
    || !isNonNegativeSafeInteger(value.sequence)
  ) {
    throw new Error('Invalid active document watch registration');
  }

  try {
    return {
      protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
      watch_id: value.watch_id,
      document_id: value.document_id,
      document_generation: value.document_generation,
      sequence: value.sequence,
      snapshot: decodeActiveDocumentDiskSnapshot(value.snapshot),
    };
  } catch {
    throw new Error('Invalid active document watch registration');
  }
}

export function decodeActiveDocumentWatchSnapshotEnvelope(
  value: unknown,
): ActiveDocumentWatchSnapshotEnvelope {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'protocol_version',
      'watch_id',
      'document_id',
      'document_generation',
      'sequence',
      'reason',
      'previous_path',
      'snapshot',
    ])
    || value.protocol_version !== ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION
    || !isProtocolId(value.watch_id)
    || !isProtocolId(value.document_id)
    || !isNonNegativeSafeInteger(value.document_generation)
    || !isNonNegativeSafeInteger(value.sequence)
    || !isWatchReason(value.reason)
    || (value.previous_path !== null && (typeof value.previous_path !== 'string' || !value.previous_path))
  ) {
    throw new Error('Invalid active document watch snapshot envelope');
  }

  let snapshot: ActiveDocumentDiskSnapshot;
  try {
    snapshot = decodeActiveDocumentDiskSnapshot(value.snapshot);
  } catch {
    throw new Error('Invalid active document watch snapshot envelope');
  }

  const validReasonShape = value.reason === 'renamed'
    ? typeof value.previous_path === 'string'
      && snapshot.status === 'present'
      && value.previous_path !== snapshot.file.path
    : value.reason === 'missing'
      ? value.previous_path === null && snapshot.status === 'missing'
      : value.previous_path === null && snapshot.status === 'present';
  if (!validReasonShape) {
    throw new Error('Invalid active document watch snapshot envelope');
  }

  return {
    protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
    watch_id: value.watch_id,
    document_id: value.document_id,
    document_generation: value.document_generation,
    sequence: value.sequence,
    reason: value.reason,
    previous_path: value.previous_path,
    snapshot,
  };
}

export function decodeActiveDocumentWatchEvent(value: unknown): ActiveDocumentWatchEvent {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'protocol_version',
      'watch_id',
      'document_id',
      'document_generation',
      'sequence',
      'event',
    ])
    || value.protocol_version !== ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION
    || !isProtocolId(value.watch_id)
    || !isProtocolId(value.document_id)
    || !isNonNegativeSafeInteger(value.document_generation)
    || !isNonNegativeSafeInteger(value.sequence)
    || !isRecord(value.event)
  ) {
    throw new Error('Invalid active document watch event');
  }

  if (value.event.kind === 'health') {
    if (
      !hasExactKeys(value.event, ['kind', 'status', 'message'])
      || (value.event.status !== 'degraded' && value.event.status !== 'failed')
      || typeof value.event.message !== 'string'
      || !value.event.message.trim()
    ) {
      throw new Error('Invalid active document watch event');
    }
    return {
      protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
      watch_id: value.watch_id,
      document_id: value.document_id,
      document_generation: value.document_generation,
      sequence: value.sequence,
      event: {
        kind: 'health',
        status: value.event.status,
        message: value.event.message,
      },
    };
  }

  if (value.event.kind !== 'state'
    || !hasExactKeys(value.event, ['kind', 'reason', 'previous_path', 'snapshot'])) {
    throw new Error('Invalid active document watch event');
  }

  try {
    const decoded = decodeActiveDocumentWatchSnapshotEnvelope({
      protocol_version: value.protocol_version,
      watch_id: value.watch_id,
      document_id: value.document_id,
      document_generation: value.document_generation,
      sequence: value.sequence,
      reason: value.event.reason,
      previous_path: value.event.previous_path,
      snapshot: value.event.snapshot,
    });
    return {
      protocol_version: decoded.protocol_version,
      watch_id: decoded.watch_id,
      document_id: decoded.document_id,
      document_generation: decoded.document_generation,
      sequence: decoded.sequence,
      event: {
        kind: 'state',
        reason: decoded.reason,
        previous_path: decoded.previous_path,
        snapshot: decoded.snapshot,
      },
    };
  } catch {
    throw new Error('Invalid active document watch event');
  }
}

function decodeBoolean(value: unknown, command: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${command} response`);
  }
  return value;
}

export function createTauriActiveDocumentWatchTransport(
  options: ActiveDocumentWatchTransportOptions = {},
): ActiveDocumentWatchTransport {
  return {
    async start(path, documentId, documentGeneration) {
      return decodeActiveDocumentWatchRegistration(await invoke<unknown>(
        'start_active_document_watch',
        { path, documentId, documentGeneration },
      ));
    },
    async activate(watchId, documentId, documentGeneration, registrationSequence) {
      return decodeBoolean(await invoke<unknown>('activate_active_document_watch', {
        watchId,
        documentId,
        documentGeneration,
        registrationSequence,
      }), 'active document watch activation');
    },
    async reconcile(watchId, documentId, documentGeneration) {
      return decodeActiveDocumentWatchSnapshotEnvelope(await invoke<unknown>(
        'reconcile_active_document_watch',
        { watchId, documentId, documentGeneration },
      ));
    },
    async stop(watchId) {
      return decodeBoolean(
        await invoke<unknown>('stop_active_document_watch', { watchId }),
        'active document watch stop',
      );
    },
    listen(callback) {
      return listen<unknown>(ACTIVE_DOCUMENT_WATCH_EVENT, (event) => {
        try {
          callback(decodeActiveDocumentWatchEvent(event.payload));
        } catch (error) {
          options.onError?.(error);
        }
      });
    },
  };
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
