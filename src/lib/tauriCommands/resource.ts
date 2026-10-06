import { invoke } from '@tauri-apps/api/core';

// 媒体资源写入与选择器命令。

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

function workspaceResourceFieldsInvalid(record: Record<string, unknown>): boolean {
  return Object.keys(record).length !== 5
    || typeof record.relativePath !== 'string'
    || typeof record.markdownPath !== 'string'
    || typeof record.fileName !== 'string'
    || typeof record.digestMd5 !== 'string'
    || typeof record.created !== 'boolean';
}

function workspaceResourceContentInvalid(record: Record<string, unknown>): boolean {
  return !/^[a-f0-9]{32}$/.test(record.digestMd5 as string)
    || (record.relativePath as string).length === 0
    || (record.markdownPath as string).length === 0
    || (record.fileName as string).length === 0
    || /[\\/]/u.test(record.fileName as string);
}

function decodeWriteWorkspaceResourceResponse(value: unknown): WriteWorkspaceResourceResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid workspace resource response');
  }
  const record = value as Record<string, unknown>;
  if (workspaceResourceFieldsInvalid(record) || workspaceResourceContentInvalid(record)) {
    throw new Error('Invalid workspace resource response');
  }
  return {
    relativePath: record.relativePath as string,
    markdownPath: record.markdownPath as string,
    fileName: record.fileName as string,
    digestMd5: record.digestMd5 as string,
    created: record.created as boolean,
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

function excalidrawAssetPairFieldsInvalid(record: Record<string, unknown>): boolean {
  return Object.keys(record).length !== 6
    || typeof record.svgMarkdownPath !== 'string'
    || typeof record.pngMarkdownPath !== 'string'
    || typeof record.svgFileName !== 'string'
    || typeof record.pngFileName !== 'string'
    || typeof record.sourceSha256 !== 'string'
    || typeof record.updated !== 'boolean';
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function plainFileNameValid(name: unknown): boolean {
  return nonEmptyString(name) && !/[\\/]/u.test(name as string);
}

function excalidrawAssetPairContentInvalid(record: Record<string, unknown>): boolean {
  return !/^[a-f0-9]{64}$/u.test(record.sourceSha256 as string)
    || !nonEmptyString(record.svgMarkdownPath)
    || !nonEmptyString(record.pngMarkdownPath)
    || !plainFileNameValid(record.svgFileName)
    || !plainFileNameValid(record.pngFileName);
}

function decodeWriteExcalidrawAssetPairResponse(value: unknown): WriteExcalidrawAssetPairResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Excalidraw asset pair response');
  }
  const record = value as Record<string, unknown>;
  if (excalidrawAssetPairFieldsInvalid(record) || excalidrawAssetPairContentInvalid(record)) {
    throw new Error('Invalid Excalidraw asset pair response');
  }
  return {
    svgMarkdownPath: record.svgMarkdownPath as string,
    pngMarkdownPath: record.pngMarkdownPath as string,
    svgFileName: record.svgFileName as string,
    pngFileName: record.pngFileName as string,
    sourceSha256: record.sourceSha256 as string,
    updated: record.updated as boolean,
  };
}

export async function authorizeResourceDirectory(): Promise<ResourceDirectoryAuthorization | null> {
  const response = await invoke<unknown>('authorize_resource_directory_dialog');
  return response === null ? null : decodeResourceDirectoryAuthorization(response);
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

export interface PickMediaResourcesInput {
  mediaKind: 'image' | 'video' | 'audio' | 'html';
  defaultDirectory: string;
  workspaceToken: string;
  workspaceRoot: string;
  documentPath: string;
  resourceDirectory: string;
  resourceDirectoryToken?: string;
}

export interface PickedMediaResource {
  name: string;
  markdownPath: string;
}

function isSafePickedMarkdownPath(value: string): boolean {
  return value.length > 0
    && value.length <= 4096
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.');
}

function decodePickedMediaResources(value: unknown): PickedMediaResource[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid picked media response');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.resources)) {
    throw new Error('Invalid picked media response');
  }
  return record.resources.map((resource): PickedMediaResource => {
    if (
      typeof resource !== 'object'
      || resource === null
      || Array.isArray(resource)
    ) {
      throw new Error('Invalid picked media response');
    }
    const entry = resource as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 2
      || typeof entry.name !== 'string'
      || typeof entry.markdownPath !== 'string'
      || entry.name.length === 0
      || entry.name.length > 255
      || !isSafePickedMarkdownPath(entry.markdownPath)
    ) {
      throw new Error('Invalid picked media response');
    }
    return { name: entry.name, markdownPath: entry.markdownPath };
  });
}

export async function pickMediaResources(input: PickMediaResourcesInput): Promise<PickedMediaResource[]> {
  return decodePickedMediaResources(await invoke<unknown>('pick_media_resources', { input }));
}
