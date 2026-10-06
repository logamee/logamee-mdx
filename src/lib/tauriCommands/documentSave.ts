import { invoke } from '@tauri-apps/api/core';
import type { DocumentSaveResponse, FileVersion, OverwriteTokenResponse, WorkspaceFileKind } from '../../types';
import { decodeDocumentSaveResponse, decodeOverwriteTokenResponse } from '../documentSave';

// 文档保存与覆盖令牌命令。

export async function saveAsDialog(
  content: string,
  defaultName: string,
  operationId: string,
  fileKind?: Extract<WorkspaceFileKind, 'excalidraw'>,
): Promise<DocumentSaveResponse | null> {
  const response = await invoke<unknown>('save_as_dialog', {
    content,
    defaultName,
    operationId,
    ...(fileKind ? { fileKind } : {}),
  });
  return response === null ? null : decodeDocumentSaveResponse(response);
}

export async function writeFile(
  path: string,
  content: string,
  expectedVersion: FileVersion,
  operationId: string,
): Promise<DocumentSaveResponse> {
  return decodeDocumentSaveResponse(
    await invoke<unknown>('write_file', { path, content, expectedVersion, operationId }),
  );
}

export async function issueDocumentOverwriteToken(
  path: string,
  content: string,
  operationId: string,
): Promise<OverwriteTokenResponse> {
  return decodeOverwriteTokenResponse(
    await invoke<unknown>('issue_document_overwrite_token', { path, content, operationId }),
  );
}

export async function retryDocumentSaveWithToken(
  path: string,
  content: string,
  operationId: string,
  overwriteToken: string,
): Promise<DocumentSaveResponse> {
  return decodeDocumentSaveResponse(
    await invoke<unknown>('retry_document_save_with_token', { path, content, operationId, overwriteToken }),
  );
}

export function cancelDocumentOverwriteToken(path: string, overwriteToken: string): Promise<void> {
  return invoke<void>('cancel_document_overwrite_token', { path, overwriteToken });
}
