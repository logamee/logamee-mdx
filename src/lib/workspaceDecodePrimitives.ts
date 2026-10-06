import type { FileVersion } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const U64_MAX = '18446744073709551615';
const U128_MAX = '340282366920938463463374607431768211455';

function isCanonicalDecimalWithin(value: unknown, maximum: string): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return value.length < maximum.length || (value.length === maximum.length && value <= maximum);
}

function isFileVersionRecord(value: unknown): value is {
  canonicalPath: string;
  platformIdentity: string;
  length: string;
  modifiedNanos: string;
  sha256: string;
} {
  return isRecord(value)
    && hasExactKeys(value, ['canonicalPath', 'platformIdentity', 'length', 'modifiedNanos', 'sha256'])
    && typeof value.canonicalPath === 'string'
    && value.canonicalPath.length > 0
    && typeof value.platformIdentity === 'string'
    && value.platformIdentity.length > 0
    && isCanonicalDecimalWithin(value.length, U64_MAX)
    && isCanonicalDecimalWithin(value.modifiedNanos, U128_MAX)
    && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256);
}

export function decodeFileVersion(value: unknown): FileVersion {
  if (!isFileVersionRecord(value)) {
    throw new Error('Invalid file version');
  }
  return {
    canonicalPath: value.canonicalPath,
    platformIdentity: value.platformIdentity,
    length: value.length,
    modifiedNanos: value.modifiedNanos,
    sha256: value.sha256,
  };
}

export function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function invalidOpenFileResponse(): never {
  throw new Error('Invalid open file response');
}

export function invalidWorkspaceSnapshot(): never {
  throw new Error('Invalid workspace snapshot');
}

export function invalidSnapshotReceipt(): never {
  throw new Error('Invalid snapshot receipt');
}

export function invalidMutationOutcome(): never {
  throw new Error('Invalid mutation outcome');
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled workspace file kind: ${String(value)}`);
}
