import type { WorkspaceSessionRestore } from '../types';
import { decodePreparedOpenFileResponse } from './recentFiles';
import { decodeWorkspaceSnapshot } from './workspaceFileKind';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function invalidWorkspaceSessionRestore(): never {
  throw new Error('Invalid workspace session restore');
}

export function decodeWorkspaceSessionRestore(value: unknown): WorkspaceSessionRestore | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ['workspace', 'active_file'])) {
    return invalidWorkspaceSessionRestore();
  }

  try {
    return {
      workspace: decodeWorkspaceSnapshot(value.workspace),
      active_file: value.active_file === null
        ? null
        : decodePreparedOpenFileResponse(value.active_file),
    };
  } catch {
    return invalidWorkspaceSessionRestore();
  }
}
