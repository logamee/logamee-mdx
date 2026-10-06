import {
  PANE_PROTOCOL_VERSION,
  type PaneContentEnvelope,
  type PaneSnapshotEnvelope,
  type PaneSnapshotRequestEnvelope,
} from './paneSyncTypes';
import {
  hasExactEnumerableKeys,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isProtocolId,
  isRecord,
} from './paneSyncGuards';
import { decodePaneReplicatedState } from './paneSyncStateDecode';

function paneSnapshotEnvelopeShapeIsValid(input: unknown): input is {
  protocolVersion: number;
  authorityId: string;
  revision: number;
  documentId: string;
  documentEpoch: number;
  state: unknown;
} {
  return isRecord(input)
    && hasExactEnumerableKeys(input, [
      'protocolVersion',
      'authorityId',
      'revision',
      'documentId',
      'documentEpoch',
      'state',
    ])
    && input.protocolVersion === PANE_PROTOCOL_VERSION
    && isProtocolId(input.authorityId)
    && isNonNegativeSafeInteger(input.revision)
    && isProtocolId(input.documentId)
    && isNonNegativeSafeInteger(input.documentEpoch);
}

export function decodePaneSnapshotEnvelope(input: unknown): PaneSnapshotEnvelope | null {
  if (!paneSnapshotEnvelopeShapeIsValid(input)) return null;

  const state = decodePaneReplicatedState(input.state);
  if (
    !state
    || state.documentId !== input.documentId
    || state.documentEpoch !== input.documentEpoch
  ) return null;

  return {
    protocolVersion: PANE_PROTOCOL_VERSION,
    authorityId: input.authorityId,
    revision: input.revision,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
    state,
  };
}

export function decodePaneContentEnvelope(input: unknown): PaneContentEnvelope | null {
  if (
    !isRecord(input)
    || !hasExactEnumerableKeys(input, [
      'protocolVersion',
      'authorityId',
      'sourceId',
      'sequence',
      'documentId',
      'documentEpoch',
      'content',
    ])
    || input.protocolVersion !== PANE_PROTOCOL_VERSION
    || !isProtocolId(input.authorityId)
    || !isProtocolId(input.sourceId)
    || !isPositiveSafeInteger(input.sequence)
    || !isProtocolId(input.documentId)
    || !isNonNegativeSafeInteger(input.documentEpoch)
    || typeof input.content !== 'string'
  ) return null;

  return {
    protocolVersion: PANE_PROTOCOL_VERSION,
    authorityId: input.authorityId,
    sourceId: input.sourceId,
    sequence: input.sequence,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
    content: input.content,
  };
}

export function decodePaneSnapshotRequestEnvelope(input: unknown): PaneSnapshotRequestEnvelope | null {
  if (
    !isRecord(input)
    || !hasExactEnumerableKeys(input, ['protocolVersion', 'requesterId'])
    || input.protocolVersion !== PANE_PROTOCOL_VERSION
    || !isProtocolId(input.requesterId)
  ) return null;
  return { protocolVersion: PANE_PROTOCOL_VERSION, requesterId: input.requesterId };
}
