import type { CorruptCrashDraftEntry, CrashDraftErrorCode, CrashDraftFileKind } from './types';

const DOCUMENT_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const FILE_KINDS: readonly CrashDraftFileKind[] = ['markdown', 'html', 'excalidraw'];
export const CORRUPT_REASONS: readonly CorruptCrashDraftEntry['reason'][] = [
  'malformed', 'invalidMetadata', 'checksumMismatch', 'oversized',
];
export const ERROR_CODES: readonly CrashDraftErrorCode[] = [
  'invalidRequest', 'oversized', 'storeFull', 'revisionConflict', 'corrupt',
  'unsupportedVersion', 'notFound', 'persistence', 'indeterminate', 'notInitialized',
];

export function createCrashDraftDocumentId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

export function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value);
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function isFileKind(value: unknown): value is CrashDraftFileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

export function hasValidPathAndBase(pathHint: unknown, baseVersionToken: unknown): boolean {
  return (pathHint === null && baseVersionToken === null)
    || (typeof pathHint === 'string' && pathHint.length > 0 && isToken(baseVersionToken));
}
