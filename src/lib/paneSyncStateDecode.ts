import type { WorkspaceFileKind } from '../types';
import type { PaneReplicatedState } from './paneSyncTypes';
import {
  hasExactEnumerableKeys,
  hasValidBinaryDocumentState,
  isDocumentAuthorityStatus,
  isNullableString,
  isNonNegativeSafeInteger,
  isProtocolId,
  isRecord,
  isWorkspaceFileKind,
} from './paneSyncGuards';

const PANE_REPLICATED_STATE_BASE_KEYS = [
  'activeFileKind',
  'activeMimeType',
  'activePath',
  'content',
  'lastSavedContent',
  'previewRevision',
  'workspaceRoot',
  'documentId',
  'documentEpoch',
];

function paneReplicatedStateKeysAreValid(input: Record<string, unknown>): boolean {
  const currentKeys = [...PANE_REPLICATED_STATE_BASE_KEYS, 'authorityStatus'];
  const binaryKeys = [...currentKeys, 'bytesBase64'];
  return hasExactEnumerableKeys(input, PANE_REPLICATED_STATE_BASE_KEYS)
    || hasExactEnumerableKeys(input, currentKeys)
    || hasExactEnumerableKeys(input, binaryKeys);
}

type PaneReplicatedStateRecord = {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  content: string;
  lastSavedContent: string;
  previewRevision: number;
  workspaceRoot: string | null;
  bytesBase64?: unknown;
  documentId: string;
  documentEpoch: number;
  authorityStatus?: unknown;
};

function paneStateCoreFieldsAreValid(input: Record<string, unknown>): boolean {
  return isWorkspaceFileKind(input.activeFileKind)
    && isNullableString(input.activeMimeType)
    && isNullableString(input.activePath)
    && typeof input.content === 'string'
    && typeof input.lastSavedContent === 'string'
    && isNonNegativeSafeInteger(input.previewRevision)
    && isNullableString(input.workspaceRoot)
    && isProtocolId(input.documentId)
    && isNonNegativeSafeInteger(input.documentEpoch);
}

function paneStateOptionalFieldsAreValid(input: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(input, 'bytesBase64')
    && !isNullableString(input.bytesBase64)) return false;
  if (Object.prototype.hasOwnProperty.call(input, 'authorityStatus')
    && !isDocumentAuthorityStatus(input.authorityStatus)) return false;
  return hasValidBinaryDocumentState(input);
}

function paneReplicatedStateFieldsAreValid(input: Record<string, unknown>): input is PaneReplicatedStateRecord {
  return paneStateCoreFieldsAreValid(input)
    && paneStateOptionalFieldsAreValid(input);
}

export function decodePaneReplicatedState(input: unknown): PaneReplicatedState | null {
  if (
    !isRecord(input)
    || !paneReplicatedStateKeysAreValid(input)
    || !paneReplicatedStateFieldsAreValid(input)
  ) return null;

  return {
    activeFileKind: input.activeFileKind,
    activeMimeType: input.activeMimeType,
    activePath: input.activePath,
    ...(Object.prototype.hasOwnProperty.call(input, 'bytesBase64')
      ? { bytesBase64: input.bytesBase64 as string | null }
      : {}),
    content: input.content,
    lastSavedContent: input.lastSavedContent,
    previewRevision: input.previewRevision,
    ...(isDocumentAuthorityStatus(input.authorityStatus)
      ? { authorityStatus: input.authorityStatus }
      : {}),
    workspaceRoot: input.workspaceRoot,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
  };
}
