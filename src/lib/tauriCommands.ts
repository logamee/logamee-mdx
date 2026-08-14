import { invoke } from '@tauri-apps/api/core';
import type {
  DeleteWorkspaceEntryResponse,
  DocumentSaveResponse,
  FileVersion,
  MutationOutcome,
  OverwriteTokenResponse,
  OpenCommitResult,
  OpenCommitStatus,
  OpenFileResponse,
  PreparedOpenFileResponse,
  RecentFilesSnapshot,
  RenameWorkspaceEntryResponse,
  WorkspaceFileKind,
  WorkspaceMutation,
  WorkspaceSnapshot,
  WorkspaceIndexDiscardResponse,
  WorkspaceIndexQueryKind,
  WorkspaceIndexQueryResponse,
  WorkspaceIndexRebuildResponse,
  AppSettings,
  SettingsEnvelope,
} from '../types';
import {
  decodeDeleteWorkspaceEntryResponse,
  decodeMutationOutcome,
  decodeOpenFileResponse,
  decodeRenameWorkspaceEntryResponse,
  decodeWorkspaceMutation,
  decodeWorkspaceSnapshot,
} from './workspaceFileKind';
import {
  decodeOpenCommitResult,
  decodeOpenCommitStatus,
  decodePreparedOpenFileResponse,
  decodeRecentFilesSnapshot,
} from './recentFiles';
import type { ThemePreference } from './theme';
import type { EffectiveLocale, LocalePreference } from './locale';
import { decodeSettingsEnvelope } from './settings';
import { decodeDocumentSaveResponse, decodeOverwriteTokenResponse } from './documentSave';
import {
  decodeWorkspaceIndexDiscardResponse,
  decodeWorkspaceIndexQueryResponse,
  decodeWorkspaceIndexRebuildResponse,
} from './workspaceSearch';
import {
  decodeOpenIntentPreview,
  decodeResolvedOpenIntent,
  type OpenIntentPreview,
  type ResolvedOpenIntent,
} from './openIntent';

export async function getSettings(): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('get_settings'));
}

export async function updateSettings(settings: AppSettings, expectedRevision: number): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('update_settings', { expectedRevision, settings }));
}

export async function resetSettings(expectedRevision: number | null): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('reset_settings', { expectedRevision }));
}

export async function refreshDirectory(workspaceToken: string, path: string): Promise<WorkspaceSnapshot> {
  const response = await invoke<unknown>('refresh_directory', { workspaceToken, path });
  return decodeWorkspaceSnapshot(response);
}

export async function openWorkspaceFile(path: string): Promise<PreparedOpenFileResponse> {
  const response = await invoke<unknown>('open_workspace_file', { path });
  return decodePreparedOpenFileResponse(response);
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

export async function peekOpenIntent(): Promise<OpenIntentPreview | null> {
  const response = await invoke<unknown>('peek_open_intent');
  return response === null ? null : decodeOpenIntentPreview(response);
}

export function requestSessionRestore(): Promise<void> {
  return invoke<void>('request_session_restore');
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

export interface WriteWorkspaceResourceInput {
  workspaceToken: string;
  workspaceRoot: string;
  documentPath: string;
  resourceDirectory: string;
  bytesBase64: string;
  mimeType: string;
  suggestedName?: string | null;
  trustedGenerated?: boolean;
  resourceDirectoryToken?: string;
}

export interface WriteWorkspaceResourceResponse {
  relativePath: string;
  markdownPath: string;
  fileName: string;
  digestMd5: string;
  created: boolean;
}

export interface ResourceDirectoryAuthorization {
  path: string;
  token: string;
}

export interface WriteExcalidrawAssetPairInput {
  workspaceToken: string;
  workspaceRoot: string;
  documentPath: string;
  sourceRelativePath: string;
  sourceContent: string;
  resourceDirectory: string;
  resourceDirectoryToken?: string | null;
  svgBase64: string;
  pngBase64: string;
}

export interface WriteExcalidrawAssetPairResponse {
  svgMarkdownPath: string;
  pngMarkdownPath: string;
  svgFileName: string;
  pngFileName: string;
  sourceSha256: string;
  updated: boolean;
}

export type ExportKind = 'html' | 'png';

export interface SaveExportInput {
  kind: ExportKind;
  defaultName: string;
  bytesBase64: string;
}

export interface SaveExportResponse {
  path: string;
  bytesWritten: number;
}

export interface SaveExcalidrawBundleInput {
  baseName: string;
  source: string;
  svgBase64: string;
  png1xBase64: string;
  png2xBase64: string;
  png3xBase64: string;
}

function decodeWriteWorkspaceResourceResponse(value: unknown): WriteWorkspaceResourceResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid workspace resource response');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5
    || typeof record.relativePath !== 'string'
    || typeof record.markdownPath !== 'string'
    || typeof record.fileName !== 'string'
    || typeof record.digestMd5 !== 'string'
    || typeof record.created !== 'boolean'
    || !/^[a-f0-9]{32}$/.test(record.digestMd5)
    || record.relativePath.length === 0
    || record.markdownPath.length === 0
    || record.fileName.length === 0
    || /[\\/]/u.test(record.fileName)
  ) {
    throw new Error('Invalid workspace resource response');
  }
  return {
    relativePath: record.relativePath,
    markdownPath: record.markdownPath,
    fileName: record.fileName,
    digestMd5: record.digestMd5,
    created: record.created,
  };
}

function decodeResourceDirectoryAuthorization(value: unknown): ResourceDirectoryAuthorization {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid resource directory authorization response');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.path !== 'string'
    || record.path.length === 0
    || typeof record.token !== 'string'
    || record.token.length === 0
  ) throw new Error('Invalid resource directory authorization response');
  return { path: record.path, token: record.token };
}

function decodeWriteExcalidrawAssetPairResponse(value: unknown): WriteExcalidrawAssetPairResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Excalidraw asset pair response');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 6
    || typeof record.svgMarkdownPath !== 'string'
    || typeof record.pngMarkdownPath !== 'string'
    || typeof record.svgFileName !== 'string'
    || typeof record.pngFileName !== 'string'
    || typeof record.sourceSha256 !== 'string'
    || typeof record.updated !== 'boolean'
    || !/^[a-f0-9]{64}$/u.test(record.sourceSha256)
    || record.svgMarkdownPath.length === 0
    || record.pngMarkdownPath.length === 0
    || record.svgFileName.length === 0
    || record.pngFileName.length === 0
    || /[\\/]/u.test(record.svgFileName)
    || /[\\/]/u.test(record.pngFileName)
  ) {
    throw new Error('Invalid Excalidraw asset pair response');
  }
  return {
    svgMarkdownPath: record.svgMarkdownPath,
    pngMarkdownPath: record.pngMarkdownPath,
    svgFileName: record.svgFileName,
    pngFileName: record.pngFileName,
    sourceSha256: record.sourceSha256,
    updated: record.updated,
  };
}

function decodeSaveExportResponse(value: unknown): SaveExportResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid export response');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.path !== 'string'
    || record.path.length === 0
    || typeof record.bytesWritten !== 'number'
    || !Number.isSafeInteger(record.bytesWritten)
    || record.bytesWritten <= 0
  ) throw new Error('Invalid export response');
  return { path: record.path, bytesWritten: record.bytesWritten };
}

export type WorkspaceOpenSettlement = 'applied' | 'discarded' | 'expired' | 'unknown';

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

export interface PackagedOpenE2eConfig {
  profile: 'apply-reobserve' | 'restore-cancel';
  unicodeRenameReady: boolean;
  paths: {
    primaryFile: string;
    unicodeFile: string;
    renamedUnicodeFile: string;
    associationFile: string;
    workspaceDirectory: string;
    staleFile: string;
  };
}

export type PackagedOpenAppEventType =
  | 'app_activated'
  | 'dirty_modal_opened'
  | 'dirty_decision'
  | 'app_applied'
  | 'app_settled';

export interface PackagedOpenAppEvent {
  type: PackagedOpenAppEventType;
  intentId: string;
  step: string;
  fields: Record<string, unknown>;
}

function decodePackagedOpenE2eConfig(value: unknown): PackagedOpenE2eConfig | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid packaged open E2E config');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3
    || (record.profile !== 'apply-reobserve' && record.profile !== 'restore-cancel')
    || typeof record.unicodeRenameReady !== 'boolean'
    || typeof record.paths !== 'object'
    || record.paths === null
    || Array.isArray(record.paths)) {
    throw new Error('Invalid packaged open E2E config');
  }
  const paths = record.paths as Record<string, unknown>;
  const pathKeys = [
    'primaryFile',
    'unicodeFile',
    'renamedUnicodeFile',
    'associationFile',
    'workspaceDirectory',
    'staleFile',
  ] as const;
  if (Object.keys(paths).length !== pathKeys.length
    || pathKeys.some((key) => typeof paths[key] !== 'string' || paths[key].trim().length === 0)) {
    throw new Error('Invalid packaged open E2E config');
  }
  return {
    profile: record.profile,
    unicodeRenameReady: record.unicodeRenameReady,
    paths: Object.fromEntries(pathKeys.map((key) => [key, paths[key]])) as PackagedOpenE2eConfig['paths'],
  };
}

export async function getPackagedOpenE2eConfig(): Promise<PackagedOpenE2eConfig | null> {
  return decodePackagedOpenE2eConfig(await invoke<unknown>('get_packaged_open_e2e_config'));
}

export function recordPackagedOpenAppEvent(event: PackagedOpenAppEvent): Promise<void> {
  return invoke<void>('record_packaged_open_app_event', { event });
}

export async function openFileDialog(): Promise<PreparedOpenFileResponse | null> {
  const response = await invoke<unknown>('open_file_dialog');
  return response === null ? null : decodePreparedOpenFileResponse(response);
}

export async function listRecentFiles(): Promise<RecentFilesSnapshot> {
  return decodeRecentFilesSnapshot(await invoke<unknown>('list_recent_files'));
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

export async function removeRecentFile(entryId: string): Promise<RecentFilesSnapshot> {
  const response = await invoke<unknown>('remove_recent_file', { entryId });
  return decodeRecentFilesSnapshot(response);
}

export async function clearRecentFiles(): Promise<RecentFilesSnapshot> {
  const response = await invoke<unknown>('clear_recent_files');
  return decodeRecentFilesSnapshot(response);
}

export function setNativeSaveMenuEnabled(enabled: boolean): Promise<void> {
  return invoke<void>('set_native_save_menu_enabled', { enabled });
}

export function setNativeThemePreference(preference: ThemePreference): Promise<void> {
  return invoke<void>('set_native_theme_preference', {
    selectedSkin: preference.selectedSkin,
    followSystem: preference.followSystem,
  });
}

export function setNativeLocalePreference(
  preference: LocalePreference,
  effectiveLocale: EffectiveLocale,
): Promise<void> {
  return invoke<void>('set_native_locale_preference', {
    mode: preference.mode,
    effectiveLocale,
  });
}

export async function openDirectoryDialog(): Promise<WorkspaceSnapshot | null> {
  const response = await invoke<unknown>('open_directory_dialog');
  return response === null ? null : decodeWorkspaceSnapshot(response);
}

export async function authorizeResourceDirectory(): Promise<ResourceDirectoryAuthorization | null> {
  const response = await invoke<unknown>('authorize_resource_directory_dialog');
  return response === null ? null : decodeResourceDirectoryAuthorization(response);
}

export async function saveExport(input: SaveExportInput): Promise<SaveExportResponse | null> {
  const response = await invoke<unknown>('save_export_dialog', { input });
  return response === null ? null : decodeSaveExportResponse(response);
}

export async function saveExcalidrawBundle(input: SaveExcalidrawBundleInput): Promise<string[] | null> {
  const response = await invoke<unknown>('save_excalidraw_bundle_dialog', { input });
  if (response === null) return null;
  if (!Array.isArray(response) || response.length !== 5 || response.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new Error('Invalid Excalidraw bundle response');
  }
  return response as string[];
}

export function persistWorkspaceSession(
  workspaceToken: string,
  workspaceRoot: string,
  activePath: string | null,
): Promise<void> {
  return invoke<void>('persist_workspace_session', { workspaceToken, workspaceRoot, activePath });
}

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

export async function deleteWorkspaceEntry(
  workspaceToken: string,
  path: string,
): Promise<MutationOutcome<DeleteWorkspaceEntryResponse>> {
  const response = await invoke<unknown>('delete_workspace_entry', { workspaceToken, path });
  return decodeMutationOutcome(response, decodeDeleteWorkspaceEntryResponse);
}

export function readWorkspaceImage(path: string): Promise<string> {
  return invoke<string>('read_workspace_image', { path });
}

export async function writeWorkspaceResource(
  input: WriteWorkspaceResourceInput,
): Promise<WriteWorkspaceResourceResponse> {
  return decodeWriteWorkspaceResourceResponse(await invoke<unknown>('write_workspace_resource', { input }));
}

export async function writeExcalidrawAssetPair(
  input: WriteExcalidrawAssetPairInput,
): Promise<WriteExcalidrawAssetPairResponse> {
  return decodeWriteExcalidrawAssetPairResponse(await invoke<unknown>('write_excalidraw_asset_pair', { input }));
}

export function readMarkdownExcalidraw(
  currentFilePath: string,
  excalidrawSrc: string,
  workspaceRoot: string | null,
): Promise<string> {
  return invoke<string>('read_markdown_excalidraw', {
    currentFilePath,
    excalidrawSrc,
    workspaceRoot,
  });
}

export function resolveWorkspaceMedia(path: string): Promise<string> {
  return invoke<string>('resolve_workspace_media', { path });
}

export function prepareHtmlPreview(path: string, content: string): Promise<string> {
  return invoke<string>('prepare_html_preview', { path, content });
}

export interface MarkdownHtmlEmbedLease {
  url: string;
  ownerId: number;
}

export function prepareMarkdownHtmlEmbed(
  markdownPath: string,
  htmlSrc: string,
  workspaceRoot: string | null,
): Promise<MarkdownHtmlEmbedLease> {
  return invoke<MarkdownHtmlEmbedLease>('prepare_markdown_html_embed', {
    markdownPath,
    htmlSrc,
    workspaceRoot,
  });
}

export function releaseMarkdownHtmlEmbed(ownerId: number): Promise<void> {
  return invoke<void>('release_markdown_html_embed', { ownerId });
}
