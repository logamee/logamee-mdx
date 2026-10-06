import { CORRUPT_REASONS, hasExactKeys, hasValidPathAndBase, isDocumentId, isFileKind, isRecord, isSafeInteger, isToken } from './decodeHelpers';
import type { CorruptCrashDraftEntry, CrashDraftCatalog, CrashDraftCatalogEntry, CrashDraftLimits, RecoverableCrashDraftEntry, UnsupportedCrashDraftEntry } from './types';

function invalidCatalog(): never {
  throw new Error('Invalid crash draft catalog response');
}

function isRecoverableCatalogEntry(value: Record<string, unknown>): value is Record<string, unknown> & RecoverableCrashDraftEntry {
  return hasExactKeys(value, [
    'status', 'documentId', 'draftRevision', 'updatedAtUnixMs', 'contentBytes',
    'pathHint', 'baseVersionToken', 'fileKind', 'entryToken',
  ])
    && isDocumentId(value.documentId)
    && isSafeInteger(value.draftRevision, 1)
    && isSafeInteger(value.updatedAtUnixMs)
    && isSafeInteger(value.contentBytes)
    && hasValidPathAndBase(value.pathHint, value.baseVersionToken)
    && isFileKind(value.fileKind)
    && isToken(value.entryToken);
}

function isCorruptCatalogEntry(value: Record<string, unknown>): value is Record<string, unknown> & CorruptCrashDraftEntry {
  return hasExactKeys(value, ['status', 'documentId', 'rawBytes', 'reason', 'entryToken'])
    && isDocumentId(value.documentId)
    && isSafeInteger(value.rawBytes)
    && typeof value.reason === 'string'
    && (CORRUPT_REASONS as readonly string[]).includes(value.reason)
    && isToken(value.entryToken);
}

function isUnsupportedVersionCatalogEntry(value: Record<string, unknown>): value is Record<string, unknown> & UnsupportedCrashDraftEntry {
  return hasExactKeys(value, ['status', 'documentId', 'rawBytes', 'schemaVersion', 'entryToken'])
    && isDocumentId(value.documentId)
    && isSafeInteger(value.rawBytes)
    && isSafeInteger(value.schemaVersion, 1)
    && isToken(value.entryToken);
}


function decodeCatalogEntry(value: unknown): CrashDraftCatalogEntry {
  if (!isRecord(value) || typeof value.status !== 'string') return invalidCatalog();
  if (value.status === 'recoverable') {
    return isRecoverableCatalogEntry(value) ? value : invalidCatalog();
  }
  if (value.status === 'corrupt') {
    return isCorruptCatalogEntry(value) ? value : invalidCatalog();
  }
  if (value.status === 'unsupportedVersion') {
    return isUnsupportedVersionCatalogEntry(value) ? value : invalidCatalog();
  }
  return invalidCatalog();
}

type CrashDraftCatalogRecord = {
  schemaVersion: number;
  catalogToken: string;
  totalBytes: number;
  entries: unknown[];
  limits: Record<string, unknown> & {
    maxDraftBytes: number;
    maxDrafts: number;
    maxStoreBytes: number;
  };
};

type CrashDraftLimitsRecord = {
  maxDraftBytes: number;
  maxDrafts: number;
  maxStoreBytes: number;
};

function catalogLimitsAreValid(limits: unknown): limits is CrashDraftLimitsRecord {
  if (!isRecord(limits)) return false;
  if (!hasExactKeys(limits, ['maxDraftBytes', 'maxDrafts', 'maxStoreBytes'])) return false;
  return isSafeInteger(limits.maxDraftBytes, 1)
    && isSafeInteger(limits.maxDrafts, 1)
    && isSafeInteger(limits.maxStoreBytes, 1)
    && limits.maxDraftBytes <= limits.maxStoreBytes;
}

function catalogEnvelopeIsValid(value: unknown): value is CrashDraftCatalogRecord {
  return isRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'catalogToken', 'totalBytes', 'entries', 'limits'])
    && value.schemaVersion === 1
    && isToken(value.catalogToken)
    && isSafeInteger(value.totalBytes)
    && Array.isArray(value.entries)
    && catalogLimitsAreValid(value.limits)
    && value.totalBytes <= value.limits.maxStoreBytes
    && value.entries.length <= value.limits.maxDrafts;
}

function catalogEntriesAreConsistent(
  entries: CrashDraftCatalogEntry[],
  limits: CrashDraftLimits,
): boolean {
  if (new Set(entries.map((entry) => entry.documentId)).size !== entries.length) return false;
  return !entries.some((entry) => entry.status === 'recoverable' && entry.contentBytes > limits.maxDraftBytes);
}

export function decodeCrashDraftCatalog(value: unknown): CrashDraftCatalog {
  if (!catalogEnvelopeIsValid(value)) return invalidCatalog();

  const limits = value.limits as unknown as CrashDraftLimits;
  const entries = value.entries.map(decodeCatalogEntry);
  if (!catalogEntriesAreConsistent(entries, limits)) return invalidCatalog();
  return {
    schemaVersion: 1,
    catalogToken: value.catalogToken,
    totalBytes: value.totalBytes,
    entries,
    limits,
  };
}
