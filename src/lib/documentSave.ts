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

// 已确认提交：版本必须可解码，可选 cleanup 回执须匹配专用格式。
function decodeCommittedSaveResponse(value: Record<string, unknown>): DocumentSaveResponse {
  const receipt = value.cleanup_repair_receipt;
  const receiptInvalid = receipt !== undefined
    && (typeof receipt !== 'string' || !/^cleanup-[0-9a-f]{64}$/.test(receipt));
  if (receiptInvalid
    || !hasExactOptionalKey(value, ['status', 'path', 'version'], 'cleanup_repair_receipt')) {
    return invalidDocumentSaveResponse();
  }
  try {
    return {
      status: 'confirmed_committed',
      path: value.path as string,
      version: decodeFileVersion(value.version),
      ...(receipt === undefined ? {} : { cleanup_repair_receipt: receipt }),
    };
  } catch {
    return invalidDocumentSaveResponse();
  }
}

// 已确认未提交：message 必填，可选 current_version 须可解码。
function decodeNotCommittedSaveResponse(value: Record<string, unknown>): DocumentSaveResponse {
  if (!hasExactOptionalKey(value, ['status', 'path', 'message'], 'current_version')
    || typeof value.message !== 'string') {
    return invalidDocumentSaveResponse();
  }
  try {
    return {
      status: 'confirmed_not_committed',
      path: value.path as string,
      ...(value.current_version === undefined
        ? {}
        : { current_version: decodeFileVersion(value.current_version) }),
      message: value.message,
    };
  } catch {
    return invalidDocumentSaveResponse();
  }
}

// 冲突：键集合受控，可选 current_version 与 overwrite_token（64 位十六进制）。
function decodeConflictSaveResponse(value: Record<string, unknown>): DocumentSaveResponse {
  const requiredKeys = ['status', 'path', 'message'] as const;
  const allowedKeys = new Set([...requiredKeys, 'current_version', 'overwrite_token']);
  const token = value.overwrite_token;
  const tokenInvalid = token !== undefined
    && (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token));
  if (tokenInvalid
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    || typeof value.message !== 'string') return invalidDocumentSaveResponse();
  try {
    return {
      status: 'conflict',
      path: value.path as string,
      message: value.message as string,
      ...(value.current_version === undefined ? {} : { current_version: decodeFileVersion(value.current_version) }),
      ...(token === undefined ? {} : { overwrite_token: token }),
    };
  } catch {
    return invalidDocumentSaveResponse();
  }
}

// 结果不确定：恰好三键且 message 为字符串。
function decodeIndeterminateSaveResponse(value: Record<string, unknown>): DocumentSaveResponse {
  if (hasExactKeys(value, ['status', 'path', 'message']) && typeof value.message === 'string') {
    return { status: 'indeterminate', path: value.path as string, message: value.message as string };
  }
  return invalidDocumentSaveResponse();
}

export function decodeDocumentSaveResponse(value: unknown): DocumentSaveResponse {
  if (!isRecord(value) || typeof value.path !== 'string') return invalidDocumentSaveResponse();
  switch (value.status) {
    case 'confirmed_committed':
      return decodeCommittedSaveResponse(value);
    case 'confirmed_not_committed':
      return decodeNotCommittedSaveResponse(value);
    case 'conflict':
      return decodeConflictSaveResponse(value);
    case 'indeterminate':
      return decodeIndeterminateSaveResponse(value);
    default:
      return invalidDocumentSaveResponse();
  }
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
