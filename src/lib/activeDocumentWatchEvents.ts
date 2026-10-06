import { ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION, type ActiveDocumentWatchEvent } from './activeDocumentWatchTypes';
import { decodeActiveDocumentWatchSnapshotEnvelope } from './activeDocumentWatchDecode';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isProtocolId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  return /^[a-z0-9-]+(?::[a-z0-9-]+)?$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isActiveDocumentWatchEventEnvelope(value: unknown): value is {
  protocol_version: number;
  watch_id: string;
  document_id: string;
  document_generation: number;
  sequence: number;
  event: Record<string, unknown>;
} {
  return isRecord(value)
    && hasExactKeys(value, [
      'protocol_version',
      'watch_id',
      'document_id',
      'document_generation',
      'sequence',
      'event',
    ])
    && value.protocol_version === ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION
    && isProtocolId(value.watch_id)
    && isProtocolId(value.document_id)
    && isNonNegativeSafeInteger(value.document_generation)
    && isNonNegativeSafeInteger(value.sequence)
    && isRecord(value.event);
}

function decodeHealthWatchEvent(
  event: Record<string, unknown>,
):
  | { kind: 'health'; status: 'degraded' | 'failed'; message: string }
  | null {
  if (
    !hasExactKeys(event, ['kind', 'status', 'message'])
    || (event.status !== 'degraded' && event.status !== 'failed')
    || typeof event.message !== 'string'
    || !event.message.trim()
  ) {
    return null;
  }
  return {
    kind: 'health',
    status: event.status,
    message: event.message,
  };
}

function decodeWatchEventStateBody(
  value: {
    protocol_version: number;
    watch_id: string;
    document_id: string;
    document_generation: number;
    sequence: number;
    event: Record<string, unknown>;
  },
): ActiveDocumentWatchEvent {
  if (
    value.event.kind !== 'state'
    || !hasExactKeys(value.event, ['kind', 'reason', 'previous_path', 'snapshot'])
  ) {
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


export function decodeActiveDocumentWatchEvent(value: unknown): ActiveDocumentWatchEvent {
  if (!isActiveDocumentWatchEventEnvelope(value)) {
    throw new Error('Invalid active document watch event');
  }

  if (value.event.kind === 'health') {
    const health = decodeHealthWatchEvent(value.event);
    if (health === null) {
      throw new Error('Invalid active document watch event');
    }
    return {
      protocol_version: ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION,
      watch_id: value.watch_id,
      document_id: value.document_id,
      document_generation: value.document_generation,
      sequence: value.sequence,
      event: health,
    };
  }

  return decodeWatchEventStateBody(value);
}
