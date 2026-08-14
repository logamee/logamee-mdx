import type {
  OpenCommitResult,
  OpenCommitStatus,
  PreparedOpenFileResponse,
  RecentFileSummary,
  RecentFilesSnapshot,
} from '../types';
import { decodeOpenFileResponse } from './workspaceFileKind';

const OPAQUE_ID_PATTERN = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function invalidPreparedOpenFileResponse(): never {
  throw new Error('Invalid prepared open file response');
}

function invalidRecentFilesSnapshot(): never {
  throw new Error('Invalid recent files snapshot');
}

function invalidOpenCommitResult(): never {
  throw new Error('Invalid open commit result');
}

function invalidOpenCommitStatus(): never {
  throw new Error('Invalid open commit status');
}

function decodeRecentFileSummary(value: unknown): RecentFileSummary {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['id', 'display_name'])
    || !isOpaqueId(value.id)
    || typeof value.display_name !== 'string'
    || value.display_name.trim().length === 0
  ) {
    return invalidRecentFilesSnapshot();
  }
  return { id: value.id, display_name: value.display_name };
}

export function decodePreparedOpenFileResponse(value: unknown): PreparedOpenFileResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['file', 'open_receipt', 'commit_operation_id'])
    || !isOpaqueId(value.open_receipt)
    || !isOpaqueId(value.commit_operation_id)
    || value.open_receipt === value.commit_operation_id
  ) {
    return invalidPreparedOpenFileResponse();
  }

  try {
    return {
      file: decodeOpenFileResponse(value.file),
      open_receipt: value.open_receipt,
      commit_operation_id: value.commit_operation_id,
    };
  } catch {
    return invalidPreparedOpenFileResponse();
  }
}

export function decodeRecentFilesSnapshot(value: unknown): RecentFilesSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['entries']) || !Array.isArray(value.entries)) {
    return invalidRecentFilesSnapshot();
  }
  if (value.entries.length > 5) return invalidRecentFilesSnapshot();

  const entries = value.entries.map(decodeRecentFileSummary);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return invalidRecentFilesSnapshot();
  }
  return { entries };
}

export function decodeOpenCommitResult(value: unknown): OpenCommitResult {
  if (!isRecord(value) || typeof value.status !== 'string') return invalidOpenCommitResult();
  if (value.status === 'committed') {
    if (!hasExactKeys(value, ['status', 'recent_files'])) return invalidOpenCommitResult();
    try {
      return { status: 'committed', recent_files: decodeRecentFilesSnapshot(value.recent_files) };
    } catch {
      return invalidOpenCommitResult();
    }
  }
  if (value.status === 'not_committed') {
    if (!hasExactKeys(value, ['status', 'message']) || typeof value.message !== 'string') {
      return invalidOpenCommitResult();
    }
    return { status: 'not_committed', message: value.message };
  }
  return invalidOpenCommitResult();
}

export function decodeOpenCommitStatus(value: unknown): OpenCommitStatus {
  if (!isRecord(value) || typeof value.status !== 'string') return invalidOpenCommitStatus();
  if (value.status === 'pending' || value.status === 'unknown') {
    if (!hasExactKeys(value, ['status'])) return invalidOpenCommitStatus();
    return { status: value.status };
  }
  if (value.status === 'committed') {
    if (!hasExactKeys(value, ['status', 'recent_files'])) return invalidOpenCommitStatus();
    try {
      return { status: 'committed', recent_files: decodeRecentFilesSnapshot(value.recent_files) };
    } catch {
      return invalidOpenCommitStatus();
    }
  }
  if (value.status === 'not_committed') {
    if (!hasExactKeys(value, ['status', 'message']) || typeof value.message !== 'string') {
      return invalidOpenCommitStatus();
    }
    return { status: 'not_committed', message: value.message };
  }
  return invalidOpenCommitStatus();
}
