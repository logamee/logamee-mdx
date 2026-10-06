import { watchReasonShapeIsValid } from './activeDocumentWatchTypes';
import { ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION, type ActiveDocumentDiskSnapshot, type ActiveDocumentWatchReason, type ActiveDocumentWatchRegistration, type ActiveDocumentWatchSnapshotEnvelope } from './activeDocumentWatchTypes';


export type { ActiveDocumentWatchRegistration, ActiveDocumentWatchSnapshotEnvelope } from './activeDocumentWatchTypes';

import { decodeOpenFileResponse } from './workspaceFileKind';

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

function decodeMissingDiskSnapshot(
  value: Record<string, unknown>,
): ActiveDocumentDiskSnapshot {
  if (!hasExactKeys(value, ['status', 'path']) || typeof value.path !== 'string' || !value.path) {
    throw new Error('Invalid active document disk snapshot');
  }
  return { status: 'missing', path: value.path };
}

function decodePresentDiskSnapshot(
  value: Record<string, unknown>,
): ActiveDocumentDiskSnapshot {
  if (
    !hasExactKeys(value, ['status', 'file', 'preview_revision'])
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

function decodeActiveDocumentDiskSnapshot(value: unknown): ActiveDocumentDiskSnapshot {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('Invalid active document disk snapshot');
  }
  if (value.status === 'missing') return decodeMissingDiskSnapshot(value);
  if (value.status !== 'present') {
    throw new Error('Invalid active document disk snapshot');
  }
  return decodePresentDiskSnapshot(value);
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

function isWatchSnapshotEnvelopeRecord(value: unknown): value is {
  protocol_version: number;
  watch_id: string;
  document_id: string;
  document_generation: number;
  sequence: number;
  reason: ActiveDocumentWatchReason;
  previous_path: string | null;
  snapshot: unknown;
} {
  return isRecord(value)
    && hasExactKeys(value, [
      'protocol_version',
      'watch_id',
      'document_id',
      'document_generation',
      'sequence',
      'reason',
      'previous_path',
      'snapshot',
    ])
    && value.protocol_version === ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION
    && isProtocolId(value.watch_id)
    && isProtocolId(value.document_id)
    && isNonNegativeSafeInteger(value.document_generation)
    && isNonNegativeSafeInteger(value.sequence)
    && isWatchReason(value.reason)
    && isNullableNonEmptyString(value.previous_path);
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '');
}

export function decodeActiveDocumentWatchSnapshotEnvelope(
  value: unknown,
): ActiveDocumentWatchSnapshotEnvelope {
  if (!isWatchSnapshotEnvelopeRecord(value)) {
    throw new Error('Invalid active document watch snapshot envelope');
  }

  let snapshot: ActiveDocumentDiskSnapshot;
  try {
    snapshot = decodeActiveDocumentDiskSnapshot(value.snapshot);
  } catch {
    throw new Error('Invalid active document watch snapshot envelope');
  }

  if (!watchReasonShapeIsValid(value.reason, value.previous_path, snapshot)) {
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
