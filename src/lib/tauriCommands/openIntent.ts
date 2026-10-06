import { invoke } from '@tauri-apps/api/core';
import type { OpenCommitResult, OpenCommitStatus, PreparedOpenFileResponse, RecentFilesSnapshot } from '../../types';
import { decodeOpenCommitResult, decodeOpenCommitStatus, decodePreparedOpenFileResponse, decodeRecentFilesSnapshot } from '../recentFiles';
import { decodeOpenIntentPreview, decodeResolvedOpenIntent, type OpenIntentPreview, type ResolvedOpenIntent } from '../openIntent';

// 打开意图、最近文件与窗口聚焦命令。

export async function openWorkspaceFile(path: string): Promise<PreparedOpenFileResponse> {
  const response = await invoke<unknown>('open_workspace_file', { path });
  return decodePreparedOpenFileResponse(response);
}

export async function peekOpenIntent(): Promise<OpenIntentPreview | null> {
  const response = await invoke<unknown>('peek_open_intent');
  return response === null ? null : decodeOpenIntentPreview(response);
}

export function requestSessionRestore(): Promise<boolean> {
  return invoke<boolean>('request_session_restore');
}

export async function resolveOpenIntent(intentId: string): Promise<ResolvedOpenIntent> {
  return decodeResolvedOpenIntent(await invoke<unknown>('resolve_open_intent', { intentId }));
}

export function discardOpenIntent(intentId: string): Promise<boolean> {
  return invoke<boolean>('discard_open_intent', { intentId });
}

export function focusMainWindow(intentId?: string, coalesced = false): Promise<void> {
  return invoke<void>('focus_main_window', { intentId, coalesced });
}

export async function settleOpenIntentWorkspace(
  workspaceOpenReceipt: string,
  applied: boolean,
): Promise<WorkspaceOpenSettlement> {
  const response = await invoke<unknown>('settle_open_intent_workspace', {
    workspaceOpenReceipt,
    applied,
  });
  if (
    response !== 'applied'
    && response !== 'discarded'
    && response !== 'expired'
    && response !== 'unknown'
  ) throw new Error('Invalid workspace open settlement response');
  return response;
}

export type WorkspaceOpenSettlement = 'applied' | 'discarded' | 'expired' | 'unknown';

export async function openFileDialog(): Promise<PreparedOpenFileResponse | null> {
  const response = await invoke<unknown>('open_file_dialog');
  return response === null ? null : decodePreparedOpenFileResponse(response);
}

export async function openRecentFile(entryId: string): Promise<PreparedOpenFileResponse> {
  const response = await invoke<unknown>('open_recent_file', { entryId });
  return decodePreparedOpenFileResponse(response);
}

export async function commitRecentOpen(openReceipt: string): Promise<OpenCommitResult> {
  const response = await invoke<unknown>('commit_recent_open', { openReceipt });
  return decodeOpenCommitResult(response);
}

export async function getOpenCommitStatus(commitOperationId: string): Promise<OpenCommitStatus> {
  const response = await invoke<unknown>('get_open_commit_status', { commitOperationId });
  return decodeOpenCommitStatus(response);
}

export function discardOpenReceipt(openReceipt: string): Promise<boolean> {
  return invoke<boolean>('discard_open_receipt', { openReceipt });
}

export async function clearRecentFiles(): Promise<RecentFilesSnapshot> {
  const response = await invoke<unknown>('clear_recent_files');
  return decodeRecentFilesSnapshot(response);
}
