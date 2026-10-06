import { ERROR_CODES, hasExactKeys, hasValidPathAndBase, isDocumentId, isFileKind, isRecord, isSafeInteger, isToken } from './decodeHelpers';

import type { CrashDraftDiscardResponse, CrashDraftErrorCode, CrashDraftOverflowResetProgress, CrashDraftRecoverResponse, CrashDraftResetResponse, CrashDraftWriteResponse, ProjectedCrashDraftError } from './types';

function invalidWriteResponse(): never {
  throw new Error('Invalid crash draft write response');
}

export function decodeCrashDraftWriteResponse(value: unknown): CrashDraftWriteResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'status', 'documentId', 'draftRevision', 'entryToken', 'updatedAtUnixMs', 'evictedDocumentIds',
    ])
    || (value.status !== 'stored' && value.status !== 'unchanged')
    || !isDocumentId(value.documentId)
    || !isSafeInteger(value.draftRevision, 1)
    || !isToken(value.entryToken)
    || !isSafeInteger(value.updatedAtUnixMs)
    || !evictedDocumentIdsAreValid(value.evictedDocumentIds)
  ) return invalidWriteResponse();
  return value as unknown as CrashDraftWriteResponse;
}

function invalidRecoverResponse(): never {
  throw new Error('Invalid crash draft recover response');
}

export function decodeCrashDraftRecoverResponse(value: unknown): CrashDraftRecoverResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'documentId', 'draftRevision', 'fileKind', 'pathHint', 'baseVersionToken',
      'content', 'updatedAtUnixMs', 'entryToken',
    ])
    || !isDocumentId(value.documentId)
    || !isSafeInteger(value.draftRevision, 1)
    || !isFileKind(value.fileKind)
    || !hasValidPathAndBase(value.pathHint, value.baseVersionToken)
    || typeof value.content !== 'string'
    || !isSafeInteger(value.updatedAtUnixMs)
    || !isToken(value.entryToken)
  ) return invalidRecoverResponse();
  return value as unknown as CrashDraftRecoverResponse;
}

function decodeStatusOnly<T extends string>(
  value: unknown,
  statuses: readonly T[],
  errorMessage: string,
): { status: T } {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['status'])
    || typeof value.status !== 'string'
    || !(statuses as readonly string[]).includes(value.status)
  ) throw new Error(errorMessage);
  return { status: value.status as T };
}

export function decodeCrashDraftDiscardResponse(value: unknown): CrashDraftDiscardResponse {
  return decodeStatusOnly(
    value,
    ['confirmedDiscarded', 'conflict', 'indeterminate'],
    'Invalid crash draft discard response',
  );
}

export function decodeCrashDraftResetResponse(value: unknown): CrashDraftResetResponse {
  return decodeStatusOnly(
    value,
    ['confirmedReset', 'conflict', 'indeterminate'],
    'Invalid crash draft reset response',
  );
}

function evictedDocumentIdsAreValid(evicted: unknown): boolean {
  return Array.isArray(evicted)
    && evicted.every(isDocumentId)
    && new Set(evicted).size === evicted.length;
}

export function decodeCrashDraftOverflowResetProgress(value: unknown): CrashDraftOverflowResetProgress {
  if (
    !isRecord(value)
    || typeof value.moreWorkRemaining !== 'boolean'
    || !isSafeInteger(value.removedEntries)
    || !isSafeInteger(value.blockedEntries)
  ) throw new Error('Invalid crash draft overflow reset response');
  if (value.moreWorkRemaining) {
    if (
      !hasExactKeys(value, ['removedEntries', 'blockedEntries', 'moreWorkRemaining', 'repairReceipt'])
      || !isToken(value.repairReceipt)
    ) throw new Error('Invalid crash draft overflow reset response');
    return {
      removedEntries: value.removedEntries,
      blockedEntries: value.blockedEntries,
      moreWorkRemaining: true,
      repairReceipt: value.repairReceipt,
    };
  }
  if (!hasExactKeys(value, ['removedEntries', 'blockedEntries', 'moreWorkRemaining'])) {
    throw new Error('Invalid crash draft overflow reset response');
  }
  return {
    removedEntries: value.removedEntries,
    blockedEntries: value.blockedEntries,
    moreWorkRemaining: false,
  };
}

const SAFE_ERROR_MESSAGES: Record<CrashDraftErrorCode, string> = {
  invalidRequest: 'The crash draft request was rejected. Your current edits remain in the editor.',
  oversized: 'This draft is too large for crash recovery. Save the document to keep these edits.',
  storeFull: 'Crash draft storage is full. Save important documents to keep their edits.',
  revisionConflict: 'The crash draft changed before this operation completed. Reload the recovery list and try again.',
  corrupt: 'A damaged crash draft cannot be recovered. You can discard it safely.',
  unsupportedVersion: 'Some drafts were created by a newer mdx version and were left unchanged.',
  notFound: 'This crash draft is no longer available. Reload the recovery list.',
  persistence: 'Crash drafts could not be saved. Your current edits remain in the editor.',
  indeterminate: 'The crash draft operation could not be confirmed. Reload the recovery list before trying again.',
  notInitialized: 'Crash recovery is not ready yet. Your current edits remain in the editor.',
};

export function projectCrashDraftError(value: unknown): ProjectedCrashDraftError {
  if (!isRecord(value) || typeof value.code !== 'string' || !(ERROR_CODES as readonly string[]).includes(value.code)) {
    return { code: 'persistence', message: SAFE_ERROR_MESSAGES.persistence, canReset: false };
  }
  const code = value.code as CrashDraftErrorCode;
  const resetAllowed = code === 'corrupt' || code === 'persistence' || code === 'indeterminate';
  const projected: ProjectedCrashDraftError = {
    code,
    message: SAFE_ERROR_MESSAGES[code],
    canReset: resetAllowed && value.canReset === true,
  };
  if (isToken(value.repairReceipt)) projected.repairReceipt = value.repairReceipt;
  return projected;
}
