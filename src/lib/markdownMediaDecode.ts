import type { WorkspaceFileEntry, WorkspaceFileKind } from '../types';

export type MarkdownMediaAsset = Pick<WorkspaceFileEntry, 'kind' | 'name' | 'relative_path'>;
export type MarkdownMediaDocument = Pick<WorkspaceFileEntry, 'relative_path'>;

export interface MarkdownExcalidrawAssetReferenceInput {
  document: MarkdownMediaDocument;
  name: string;
  pngMarkdownPath: string;
  scale: 1 | 2 | 3;
  sourceRelativePath: string;
  sourceSha256: string;
  svgMarkdownPath: string;
}

export type MarkdownMediaInsertionTarget =
  | { kind: 'cursor' }
  | { kind: 'coordinates'; clientX: number; clientY: number };

export interface MarkdownMediaInsertion {
  documentEpoch: number;
  documentId: string;
  markdown: string;
  requestId: number;
  target: MarkdownMediaInsertionTarget;
}

export interface MarkdownMediaCursorInsertion {
  asset: MarkdownMediaAsset;
  documentEpoch: number;
  documentId: string;
  documentRelativePath: string;
  popoutInstanceId: string;
  requestId: number;
}

export interface MarkdownMediaInsertionReady {
  documentEpoch: number;
  documentId: string;
  popoutInstanceId: string;
  readyRequestId?: string;
}

export interface MarkdownMediaInsertionReadyRequest {
  documentEpoch: number;
  documentId: string;
  readyRequestId: string;
}

export interface MarkdownMediaInsertionHandshake extends MarkdownMediaInsertionReady {
  handshakeId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isProtocolId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function isMarkdownWorkspaceReferenceKind(kind: WorkspaceFileKind): boolean {
  return kind === 'image'
    || kind === 'video'
    || kind === 'audio'
    || kind === 'html'
    || kind === 'excalidraw';
}

export function decodeMarkdownMediaCursorInsertion(value: unknown): MarkdownMediaCursorInsertion | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['asset', 'documentEpoch', 'documentId', 'documentRelativePath', 'popoutInstanceId', 'requestId'])
    || !isNonNegativeSafeInteger(value.documentEpoch)
    || !isProtocolId(value.documentId)
    || typeof value.documentRelativePath !== 'string'
    || !splitWorkspaceRelativePath(value.documentRelativePath)
    || !isProtocolId(value.popoutInstanceId)
    || !isPositiveSafeInteger(value.requestId)
  ) return null;

  const asset = decodeMarkdownMediaAsset(value.asset);
  if (!asset) return null;

  return {
    asset,
    documentEpoch: value.documentEpoch,
    documentId: value.documentId,
    documentRelativePath: value.documentRelativePath,
    popoutInstanceId: value.popoutInstanceId,
    requestId: value.requestId,
  };
}

export function decodeMarkdownMediaInsertionReady(value: unknown): MarkdownMediaInsertionReady | null {
  if (
    !isRecord(value)
    || (!hasExactKeys(value, ['documentEpoch', 'documentId', 'popoutInstanceId'])
      && !hasExactKeys(value, ['documentEpoch', 'documentId', 'popoutInstanceId', 'readyRequestId']))
    || !isNonNegativeSafeInteger(value.documentEpoch)
    || !isProtocolId(value.documentId)
    || !isProtocolId(value.popoutInstanceId)
    || ('readyRequestId' in value && !isProtocolId(value.readyRequestId))
  ) return null;

  return {
    documentEpoch: value.documentEpoch,
    documentId: value.documentId,
    popoutInstanceId: value.popoutInstanceId,
    ...('readyRequestId' in value ? { readyRequestId: value.readyRequestId as string } : {}),
  };
}

export function decodeMarkdownMediaInsertionReadyRequest(value: unknown): MarkdownMediaInsertionReadyRequest | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['documentEpoch', 'documentId', 'readyRequestId'])
    || !isNonNegativeSafeInteger(value.documentEpoch)
    || !isProtocolId(value.documentId)
    || !isProtocolId(value.readyRequestId)
  ) return null;

  return {
    documentEpoch: value.documentEpoch,
    documentId: value.documentId,
    readyRequestId: value.readyRequestId,
  };
}

export function decodeMarkdownMediaInsertionHandshake(value: unknown): MarkdownMediaInsertionHandshake | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['documentEpoch', 'documentId', 'handshakeId', 'popoutInstanceId'])
    || !isNonNegativeSafeInteger(value.documentEpoch)
    || !isProtocolId(value.documentId)
    || !isProtocolId(value.handshakeId)
    || !isProtocolId(value.popoutInstanceId)
  ) return null;

  return {
    documentEpoch: value.documentEpoch,
    documentId: value.documentId,
    handshakeId: value.handshakeId,
    popoutInstanceId: value.popoutInstanceId,
  };
}

export function splitWorkspaceRelativePath(path: string): string[] | null {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments;
}


// 资产字段校验：恰好三键且 kind 属于可引用类型。
function markdownMediaAssetFieldsInvalid(value: Record<string, unknown>): boolean {
  return !hasExactKeys(value, ['kind', 'name', 'relative_path'])
    || typeof value.kind !== 'string'
    || !isMarkdownWorkspaceReferenceKind(value.kind as WorkspaceFileKind);
}

// 资产内容校验：名称 1~255 字符，相对路径合法且 ≤4096。
function markdownMediaAssetContentInvalid(value: Record<string, unknown>): boolean {
  return typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > 255
    || typeof value.relative_path !== 'string'
    || value.relative_path.length > 4096
    || !splitWorkspaceRelativePath(value.relative_path);
}

function decodeMarkdownMediaAsset(value: unknown): MarkdownMediaAsset | null {
  if (!isRecord(value)) return null;
  if (markdownMediaAssetFieldsInvalid(value) || markdownMediaAssetContentInvalid(value)) return null;
  return {
    kind: value.kind as WorkspaceFileKind,
    name: value.name as string,
    relative_path: value.relative_path as string,
  };
}
