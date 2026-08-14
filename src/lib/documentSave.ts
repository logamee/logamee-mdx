import type { DocumentSaveResponse, OverwriteTokenResponse } from '../types';
import { decodeFileVersion } from './workspaceFileKind';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasExactOptionalKey(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKey: string,
): boolean {
  return hasExactKeys(
    value,
    Object.prototype.hasOwnProperty.call(value, optionalKey) ? [...requiredKeys, optionalKey] : requiredKeys,
  );
}

function invalidDocumentSaveResponse(): never {
  throw new Error('Invalid document save response');
}

export function decodeDocumentSaveResponse(value: unknown): DocumentSaveResponse {
  if (!isRecord(value) || typeof value.path !== 'string') return invalidDocumentSaveResponse();

  if (value.status === 'confirmed_committed') {
    if (
      !hasExactOptionalKey(value, ['status', 'path', 'version'], 'cleanup_repair_receipt') ||
      (value.cleanup_repair_receipt !== undefined
        && (typeof value.cleanup_repair_receipt !== 'string'
          || !/^cleanup-[0-9a-f]{64}$/.test(value.cleanup_repair_receipt)))
    ) {
      return invalidDocumentSaveResponse();
    }
    try {
      return {
        status: 'confirmed_committed',
        path: value.path,
        version: decodeFileVersion(value.version),
        ...(value.cleanup_repair_receipt === undefined
          ? {}
          : { cleanup_repair_receipt: value.cleanup_repair_receipt }),
      };
    } catch {
      return invalidDocumentSaveResponse();
    }
  }

  if (value.status === 'confirmed_not_committed') {
    if (
      !hasExactOptionalKey(value, ['status', 'path', 'message'], 'current_version') ||
      typeof value.message !== 'string'
    ) {
      return invalidDocumentSaveResponse();
    }
    try {
      return {
        status: value.status,
        path: value.path,
        ...(value.current_version === undefined
          ? {}
          : { current_version: decodeFileVersion(value.current_version) }),
        message: value.message,
      };
    } catch {
      return invalidDocumentSaveResponse();
    }
  }

  if (value.status === 'conflict') {
    const requiredKeys = ['status', 'path', 'message'] as const;
    const allowedKeys = new Set([...requiredKeys, 'current_version', 'overwrite_token']);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))
      || !requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || typeof value.message !== 'string'
      || (value.overwrite_token !== undefined
        && (typeof value.overwrite_token !== 'string'
          || !/^[0-9a-f]{64}$/.test(value.overwrite_token)))
    ) return invalidDocumentSaveResponse();
    try {
      return {
        status: 'conflict',
        path: value.path,
        message: value.message,
        ...(value.current_version === undefined ? {} : { current_version: decodeFileVersion(value.current_version) }),
        ...(value.overwrite_token === undefined ? {} : { overwrite_token: value.overwrite_token }),
      };
    } catch {
      return invalidDocumentSaveResponse();
    }
  }

  if (
    value.status === 'indeterminate' &&
    hasExactKeys(value, ['status', 'path', 'message']) &&
    typeof value.message === 'string'
  ) {
    return { status: 'indeterminate', path: value.path, message: value.message };
  }

  return invalidDocumentSaveResponse();
}

export function decodeOverwriteTokenResponse(value: unknown): OverwriteTokenResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['overwriteToken']) ||
    typeof value.overwriteToken !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.overwriteToken)
  ) {
    throw new Error('Invalid overwrite token response');
  }
  return { overwriteToken: value.overwriteToken };
}
