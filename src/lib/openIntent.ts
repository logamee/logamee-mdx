import type { PreparedOpenFileResponse, WorkspaceSessionRestore, WorkspaceSnapshot } from '../types';
import type { CrashDraftRecoverResponse } from './crashDrafts';
import { decodePreparedOpenFileResponse } from './recentFiles';
import { decodeWorkspaceSessionRestore } from './workspaceSession';
import { decodeWorkspaceSnapshot } from './workspaceFileKind';

export const OPEN_INTENT_PENDING_EVENT = 'mmd:open-intent-pending';
export const OPEN_INTENT_FOCUS_EVENT = 'mmd:open-intent-focus';

export type OpenIntentSource =
  | 'startup_args'
  | 'secondary_instance'
  | 'opened_event'
  | 'session_restore'
  | 'drag_drop';
export type OpenIntentTargetKind = 'unknown' | 'file' | 'directory' | 'session_restore';

export interface OpenIntentPreview {
  id: string;
  source: OpenIntentSource;
  displayPath: string;
  targetKind: OpenIntentTargetKind;
}

export interface WorkspaceSearchOpenSelection {
  workspaceToken: string;
  workspaceRoot: string;
  indexGeneration: number;
  relativePath: string;
}

export type LocalOpenIntentSource = 'native_menu' | 'sidebar' | 'workspace_search' | 'crash_recovery';

export type LocalOpenIntentAction =
  | { kind: 'new_document' }
  | { kind: 'open_file' }
  | { kind: 'open_directory' }
  | { kind: 'open_recent'; entryId: string }
  | { kind: 'workspace_file'; path: string }
  | { kind: 'workspace_search_result'; selection: WorkspaceSearchOpenSelection }
  | { kind: 'crash_draft'; draft: CrashDraftRecoverResponse };

export type AppOpenIntent =
  | (OpenIntentPreview & { origin: 'backend' })
  | {
    origin: 'local';
    id: string;
    source: LocalOpenIntentSource;
    displayPath: string;
    targetKind: OpenIntentTargetKind;
    action: LocalOpenIntentAction;
  };

export function adaptBackendOpenIntent(preview: OpenIntentPreview): AppOpenIntent {
  return { origin: 'backend', ...preview };
}

export function createLocalOpenIntent(
  id: string,
  source: LocalOpenIntentSource,
  displayPath: string,
  action: LocalOpenIntentAction,
): AppOpenIntent {
  const targetKind: OpenIntentTargetKind = action.kind === 'open_directory'
    ? 'directory'
    : action.kind === 'new_document'
      ? 'unknown'
      : 'file';
  return { origin: 'local', id, source, displayPath, targetKind, action };
}

export type ResolvedOpenIntent =
  | { kind: 'file'; prepared: PreparedOpenFileResponse }
  | { kind: 'directory'; workspace: WorkspaceSnapshot; workspace_open_receipt: string }
  | {
    kind: 'session_restore';
    restore: WorkspaceSessionRestore | null;
    workspace_open_receipt: string | null;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
}

function invalidPreview(): never {
  throw new Error('Invalid open intent preview');
}

function invalidResolution(): never {
  throw new Error('Invalid resolved open intent');
}

function isOpenIntentId(value: unknown): value is string {
  return typeof value === 'string' && /^open-intent-[1-9][0-9]*$/.test(value);
}

function isWorkspaceOpenReceipt(value: unknown): value is string {
  return typeof value === 'string' && /^workspace-open-(0|[1-9][0-9]*)$/.test(value);
}

function isSource(value: unknown): value is OpenIntentSource {
  return value === 'startup_args'
    || value === 'secondary_instance'
    || value === 'opened_event'
    || value === 'session_restore'
    || value === 'drag_drop';
}

function isTargetKind(value: unknown): value is OpenIntentTargetKind {
  return value === 'unknown'
    || value === 'file'
    || value === 'directory'
    || value === 'session_restore';
}

export function decodeOpenIntentPreview(value: unknown): OpenIntentPreview {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['id', 'source', 'displayPath', 'targetKind'])
    || !isOpenIntentId(value.id)
    || !isSource(value.source)
    || typeof value.displayPath !== 'string'
    || value.displayPath.trim().length === 0
    || !isTargetKind(value.targetKind)
  ) return invalidPreview();
  return {
    id: value.id,
    source: value.source,
    displayPath: value.displayPath,
    targetKind: value.targetKind,
  };
}

export function decodeResolvedOpenIntent(value: unknown): ResolvedOpenIntent {
  if (!isRecord(value) || typeof value.kind !== 'string') return invalidResolution();
  if (value.kind === 'file') {
    if (!hasExactKeys(value, ['kind', 'prepared'])) return invalidResolution();
    try {
      return { kind: 'file', prepared: decodePreparedOpenFileResponse(value.prepared) };
    } catch {
      return invalidResolution();
    }
  }
  if (value.kind === 'directory') {
    if (
      !hasExactKeys(value, ['kind', 'workspace', 'workspace_open_receipt'])
      || !isWorkspaceOpenReceipt(value.workspace_open_receipt)
    ) return invalidResolution();
    try {
      return {
        kind: 'directory',
        workspace: decodeWorkspaceSnapshot(value.workspace),
        workspace_open_receipt: value.workspace_open_receipt,
      };
    } catch {
      return invalidResolution();
    }
  }
  if (value.kind === 'session_restore') {
    if (!hasExactKeys(value, ['kind', 'restore', 'workspace_open_receipt'])) {
      return invalidResolution();
    }
    try {
      const restore = decodeWorkspaceSessionRestore(value.restore);
      if (
        (restore === null && value.workspace_open_receipt !== null)
        || (restore !== null && !isWorkspaceOpenReceipt(value.workspace_open_receipt))
      ) return invalidResolution();
      return {
        kind: 'session_restore',
        restore,
        workspace_open_receipt: value.workspace_open_receipt as string | null,
      };
    } catch {
      return invalidResolution();
    }
  }
  return invalidResolution();
}
