import { invoke } from '@tauri-apps/api/core';
import type { DeleteWorkspaceEntryResponse, MutationOutcome, OpenFileResponse, PreparedOpenFileResponse, RenameWorkspaceEntryResponse, WorkspaceFileKind, WorkspaceMutation, WorkspaceSnapshot, WorkspaceIndexDiscardResponse, WorkspaceIndexQueryKind, WorkspaceIndexQueryResponse, WorkspaceIndexRebuildResponse } from '../../types';
import { decodeDeleteWorkspaceEntryResponse, decodeMutationOutcome, decodeOpenFileResponse, decodeRenameWorkspaceEntryResponse, decodeWorkspaceMutation, decodeWorkspaceSnapshot } from '../workspaceFileKind';
import { decodePreparedOpenFileResponse } from '../recentFiles';
import { decodeWorkspaceIndexDiscardResponse, decodeWorkspaceIndexQueryResponse, decodeWorkspaceIndexRebuildResponse } from '../workspaceSearch';

// 工作区索引、目录与条目增删改命令。

export async function refreshDirectory(workspaceToken: string, path: string): Promise<WorkspaceSnapshot> {
  const response = await invoke<unknown>('refresh_directory', { workspaceToken, path });
  return decodeWorkspaceSnapshot(response);
}

export async function rebuildWorkspaceIndex(
  workspaceToken: string,
  workspaceRoot: string,
  operationId: string,
): Promise<WorkspaceIndexRebuildResponse> {
  return decodeWorkspaceIndexRebuildResponse(await invoke<unknown>('rebuild_workspace_index', {
    workspaceToken,
    workspaceRoot,
    operationId,
  }));
}

export async function queryWorkspaceIndex(
  workspaceToken: string,
  workspaceRoot: string,
  operationId: string,
  query: { kind: WorkspaceIndexQueryKind; text: string },
): Promise<WorkspaceIndexQueryResponse> {
  return decodeWorkspaceIndexQueryResponse(await invoke<unknown>('query_workspace_index', {
    workspaceToken,
    workspaceRoot,
    operationId,
    query,
  }));
}

export async function discardWorkspaceIndex(
  workspaceToken: string,
  workspaceRoot: string,
): Promise<WorkspaceIndexDiscardResponse> {
  return decodeWorkspaceIndexDiscardResponse(await invoke<unknown>('discard_workspace_index', {
    workspaceToken,
    workspaceRoot,
  }));
}

export async function cancelWorkspaceIndexOperation(operationId: string): Promise<boolean> {
  const response = await invoke<unknown>('cancel_workspace_index_operation', { operationId });
  if (
    typeof response !== 'object'
    || response === null
    || Array.isArray(response)
    || Object.keys(response).length !== 1
    || typeof (response as { cancelled?: unknown }).cancelled !== 'boolean'
  ) throw new Error('Invalid workspace index cancellation response');
  return (response as { cancelled: boolean }).cancelled;
}

export async function openWorkspaceIndexResult(
  workspaceToken: string,
  workspaceRoot: string,
  indexGeneration: number,
  relativePath: string,
): Promise<PreparedOpenFileResponse> {
  return decodePreparedOpenFileResponse(await invoke<unknown>('open_workspace_index_result', {
    workspaceToken,
    workspaceRoot,
    indexGeneration,
    relativePath,
  }));
}

export async function openDirectoryDialog(): Promise<WorkspaceSnapshot | null> {
  const response = await invoke<unknown>('open_directory_dialog');
  return response === null ? null : decodeWorkspaceSnapshot(response);
}

export async function openFileParentDirectory(
  path: string,
  intentId: string,
): Promise<WorkspaceSnapshot> {
  return decodeWorkspaceSnapshot(await invoke<unknown>('open_file_parent_directory', { path, intentId }));
}

export function persistWorkspaceSession(
  workspaceToken: string,
  workspaceRoot: string,
  activePath: string | null,
): Promise<void> {
  return invoke<void>('persist_workspace_session', { workspaceToken, workspaceRoot, activePath });
}

export async function createWorkspaceFile(
  workspaceToken: string,
  parentPath: string,
  name: string,
  fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'> = 'markdown',
): Promise<MutationOutcome<OpenFileResponse>> {
  const response = await invoke<unknown>('create_workspace_file', {
    workspaceToken,
    parentPath,
    name,
    ...(fileKind === 'excalidraw' ? { fileKind } : {}),
  });
  return decodeMutationOutcome(response, decodeOpenFileResponse);
}

export async function createWorkspaceDirectory(
  workspaceToken: string,
  parentPath: string,
  name: string,
): Promise<MutationOutcome<WorkspaceMutation>> {
  const response = await invoke<unknown>('create_workspace_directory', { workspaceToken, parentPath, name });
  return decodeMutationOutcome(response, decodeWorkspaceMutation);
}

export async function renameWorkspaceEntry(
  workspaceToken: string,
  path: string,
  newName: string,
): Promise<MutationOutcome<RenameWorkspaceEntryResponse>> {
  const response = await invoke<unknown>('rename_workspace_entry', { workspaceToken, path, newName });
  return decodeMutationOutcome(response, decodeRenameWorkspaceEntryResponse);
}

export async function moveWorkspaceEntry(
  workspaceToken: string,
  path: string,
  destinationParentPath: string,
): Promise<MutationOutcome<RenameWorkspaceEntryResponse>> {
  const response = await invoke<unknown>('move_workspace_entry', {
    workspaceToken,
    path,
    destinationParentPath,
  });
  return decodeMutationOutcome(response, decodeRenameWorkspaceEntryResponse);
}

export async function copyWorkspaceEntry(
  workspaceToken: string,
  sourcePath: string,
  destinationParentPath: string,
): Promise<MutationOutcome<RenameWorkspaceEntryResponse>> {
  const response = await invoke<unknown>('copy_workspace_entry', {
    workspaceToken,
    sourcePath,
    destinationParentPath,
  });
  return decodeMutationOutcome(response, decodeRenameWorkspaceEntryResponse);
}

export async function revealWorkspaceEntry(path: string): Promise<void> {
  await invoke<unknown>('reveal_workspace_entry', { path });
}

export async function deleteWorkspaceEntry(
  workspaceToken: string,
  path: string,
): Promise<MutationOutcome<DeleteWorkspaceEntryResponse>> {
  const response = await invoke<unknown>('delete_workspace_entry', { workspaceToken, path });
  return decodeMutationOutcome(response, decodeDeleteWorkspaceEntryResponse);
}
