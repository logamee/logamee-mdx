import type { WorkspaceFileKind } from '../types';
import type { DocumentAuthorityStatus } from './documentSession';
import {
  PANE_BINARY_SOURCE_LIMITS,
  type PaneSnapshotEnvelope,
} from './paneSyncTypes';

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function hasExactEnumerableKeys(input: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const enumerableKeys = Reflect.ownKeys(input).filter((key) => (
    Object.prototype.propertyIsEnumerable.call(input, key)
  ));
  return enumerableKeys.length === expectedKeys.length
    && enumerableKeys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

export function isNullableString(input: unknown): input is string | null {
  return typeof input === 'string' || input === null;
}

export function isWorkspaceFileKind(input: unknown): input is WorkspaceFileKind {
  return input === 'markdown'
    || input === 'html'
    || input === 'excalidraw'
    || input === 'image'
    || input === 'video'
    || input === 'audio'
    || input === 'pdf'
    || input === 'docx';
}

function isBinaryDocumentKind(input: WorkspaceFileKind): input is 'pdf' | 'docx' {
  return input === 'pdf' || input === 'docx';
}

const BINARY_DOCUMENT_MIME_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64PaddingIsCanonical(input: string, padding: number): boolean {
  if (padding === 0) return true;
  const finalSextet = BASE64_ALPHABET.indexOf(input[input.length - padding - 1]!);
  if (finalSextet < 0) return false;
  return padding === 2 ? (finalSextet & 0x0f) === 0 : (finalSextet & 0x03) === 0;
}

function base64BodyIsCanonical(input: string, dataLength: number, padding: number): boolean {
  for (let index = 0; index < dataLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(input[index]!) < 0) return false;
  }
  if (padding === 0) return true;
  return input.slice(dataLength) === '='.repeat(padding);
}

function isCanonicalBase64WithinLimit(input: unknown, byteLimit: number): input is string {
  if (typeof input !== 'string' || input.length === 0 || input.length % 4 !== 0) return false;

  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const decodedLength = (input.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > byteLimit) return false;

  const dataLength = input.length - padding;
  if (!base64BodyIsCanonical(input, dataLength, padding)) return false;
  return base64PaddingIsCanonical(input, padding);
}

export function hasValidBinaryDocumentState(input: Record<string, unknown>): boolean {
  const kind = input.activeFileKind as WorkspaceFileKind;
  if (!isBinaryDocumentKind(kind)) {
    return input.bytesBase64 === undefined || input.bytesBase64 === null;
  }
  return input.activeMimeType === BINARY_DOCUMENT_MIME_TYPES[kind]
    && input.content === ''
    && input.lastSavedContent === ''
    && isCanonicalBase64WithinLimit(input.bytesBase64, PANE_BINARY_SOURCE_LIMITS[kind]);
}

export function isBinaryDocumentSnapshot(snapshot: PaneSnapshotEnvelope): boolean {
  return isBinaryDocumentKind(snapshot.state.activeFileKind);
}

export function isDocumentAuthorityStatus(input: unknown): input is DocumentAuthorityStatus {
  return input === 'committed'
    || input === 'provisional'
    || input === 'unknown'
    || input === 'failed';
}

export function snapshotAcceptsEditorContent(snapshot: PaneSnapshotEnvelope): boolean {
  return snapshot.state.authorityStatus === 'committed'
    && (
      snapshot.state.activeFileKind === 'markdown'
      || snapshot.state.activeFileKind === 'html'
      || snapshot.state.activeFileKind === 'excalidraw'
    );
}

export function isProtocolId(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input);
}

export function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

export function isPositiveSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) > 0;
}

export function snapshotSupersedesAccepted(
  snapshot: PaneSnapshotEnvelope,
  accepted: PaneSnapshotEnvelope,
  ctx: { source: 'cache' | 'live'; acceptedSource: 'cache' | 'live' },
): boolean {
  const sameAuthorityRevision = snapshot.revision <= accepted.revision
    && !(ctx.source === 'live'
      && ctx.acceptedSource === 'cache'
      && snapshot.revision === accepted.revision);
  if (sameAuthorityRevision) return false;
  if (snapshot.documentEpoch < accepted.documentEpoch) return false;
  if (
    snapshot.documentEpoch === accepted.documentEpoch
    && (snapshot.documentId !== accepted.documentId
      || snapshot.state.previewRevision < accepted.state.previewRevision)
  ) return false;
  return true;
}
