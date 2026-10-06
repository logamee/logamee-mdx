import type {
  DeleteWorkspaceEntryResponse,
  RenameWorkspaceEntryResponse,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from '../types';
import {
  hasExactKeys,
  invalidWorkspaceSnapshot,
  isRecord,
} from './workspaceDecodePrimitives';
import { decodeWorkspaceFileKind } from './workspaceKindPresentation';

function decodeWorkspaceFileEntry(value: unknown): WorkspaceFileEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'path', 'relative_path', 'name']) ||
    typeof value.path !== 'string' ||
    typeof value.relative_path !== 'string' ||
    typeof value.name !== 'string'
  ) {
    return invalidWorkspaceSnapshot();
  }

  try {
    return {
      kind: decodeWorkspaceFileKind(value.kind),
      path: value.path,
      relative_path: value.relative_path,
      name: value.name,
    };
  } catch {
    return invalidWorkspaceSnapshot();
  }
}

function decodeWorkspaceDirectoryEntry(value: unknown): WorkspaceDirectoryEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'relative_path', 'name']) ||
    typeof value.path !== 'string' ||
    typeof value.relative_path !== 'string' ||
    typeof value.name !== 'string'
  ) {
    return invalidWorkspaceSnapshot();
  }
  return { path: value.path, relative_path: value.relative_path, name: value.name };
}

export function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workspace_token', 'root', 'files', 'directories']) ||
    typeof value.workspace_token !== 'string' ||
    typeof value.root !== 'string' ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories)
  ) {
    return invalidWorkspaceSnapshot();
  }

  return {
    workspace_token: value.workspace_token,
    root: value.root,
    files: value.files.map(decodeWorkspaceFileEntry),
    directories: value.directories.map(decodeWorkspaceDirectoryEntry),
  };
}

export function decodeWorkspaceMutation(value: unknown): WorkspaceMutation {
  if (!isRecord(value) || !hasExactKeys(value, ['path']) || typeof value.path !== 'string') {
    throw new Error('Invalid workspace mutation');
  }
  return { path: value.path };
}

export function decodeRenameWorkspaceEntryResponse(value: unknown): RenameWorkspaceEntryResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['entry_kind', 'old_path', 'new_path']) ||
    (value.entry_kind !== 'file' && value.entry_kind !== 'directory') ||
    typeof value.old_path !== 'string' ||
    typeof value.new_path !== 'string'
  ) {
    throw new Error('Invalid rename workspace entry response');
  }
  return {
    entry_kind: value.entry_kind,
    old_path: value.old_path,
    new_path: value.new_path,
  };
}

export function decodeDeleteWorkspaceEntryResponse(value: unknown): DeleteWorkspaceEntryResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['deleted_path']) ||
    typeof value.deleted_path !== 'string'
  ) {
    throw new Error('Invalid delete workspace entry response');
  }
  return { deleted_path: value.deleted_path };
}
