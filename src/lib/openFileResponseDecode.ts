import type { OpenFileResponse, WorkspaceFileKind } from '../types';
import {
  decodeFileVersion,
  hasExactKeys,
  invalidOpenFileResponse,
  isNonBlankString,
  isRecord,
} from './workspaceDecodePrimitives';
import { decodeWorkspaceFileKind } from './workspaceKindPresentation';

const BINARY_DOCUMENT_SOURCE_LIMITS = {
  pdf: 64 * 1024 * 1024,
  docx: 32 * 1024 * 1024,
} as const;

const BINARY_DOCUMENT_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64BodyAndPaddingAreCanonical(value: string, dataLength: number, padding: number): boolean {
  for (let index = 0; index < dataLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(value[index]!) < 0) return false;
  }
  if (padding === 2 && (BASE64_ALPHABET.indexOf(value[dataLength - 1]!) & 0x0f) !== 0) {
    return false;
  }
  if (padding === 1 && (BASE64_ALPHABET.indexOf(value[dataLength - 1]!) & 0x03) !== 0) {
    return false;
  }
  return true;
}

function isCanonicalBase64WithinLimit(value: unknown, byteLimit: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;

  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const dataLength = value.length - padding;
  if (!base64BodyAndPaddingAreCanonical(value, dataLength, padding)) return false;

  const decodedLength = (value.length / 4) * 3 - padding;
  return decodedLength > 0 && decodedLength <= byteLimit;
}

function decodeTextOpenFileResponse(
  kind: 'markdown' | 'excalidraw',
  value: Record<string, unknown> & { path: string; content_mode: unknown },
): OpenFileResponse {
  if (
    value.content_mode !== 'text' ||
    typeof value.content !== 'string' ||
    !hasExactKeys(value, ['kind', 'path', 'content_mode', 'file_version', 'content'])
  ) {
    return invalidOpenFileResponse();
  }
  try {
    return {
      kind,
      path: value.path,
      content_mode: 'text',
      file_version: decodeFileVersion(value.file_version),
      content: value.content,
    };
  } catch {
    return invalidOpenFileResponse();
  }
}

function decodeHtmlOpenFileResponse(
  value: Record<string, unknown> & { path: string; content_mode: unknown },
): OpenFileResponse {
  if (
    value.content_mode !== 'text' ||
    typeof value.content !== 'string' ||
    !isNonBlankString(value.mime_type) ||
    !hasExactKeys(value, ['kind', 'path', 'content_mode', 'file_version', 'content', 'mime_type'])
  ) {
    return invalidOpenFileResponse();
  }
  try {
    return {
      kind: 'html',
      path: value.path,
      content_mode: 'text',
      file_version: decodeFileVersion(value.file_version),
      content: value.content,
      mime_type: value.mime_type,
    };
  } catch {
    return invalidOpenFileResponse();
  }
}

function decodePdfDocxOpenFileResponse(
  kind: 'pdf' | 'docx',
  value: Record<string, unknown> & { path: string; content_mode: unknown },
): OpenFileResponse {
  const mimeType = BINARY_DOCUMENT_MIME_TYPES[kind];
  if (
    value.content_mode !== 'binary' ||
    value.mime_type !== mimeType ||
    !isCanonicalBase64WithinLimit(value.bytes_base64, BINARY_DOCUMENT_SOURCE_LIMITS[kind]) ||
    !hasExactKeys(value, ['kind', 'path', 'content_mode', 'mime_type', 'bytes_base64'])
  ) {
    return invalidOpenFileResponse();
  }
  return {
    kind,
    path: value.path,
    content_mode: 'binary',
    mime_type: mimeType,
    bytes_base64: value.bytes_base64,
  };
}

function decodeLooseBinaryOpenFileResponse(
  kind: 'image' | 'video' | 'audio',
  value: Record<string, unknown> & { path: string; content_mode: unknown },
): OpenFileResponse {
  if (
    value.content_mode !== 'binary' ||
    !isNonBlankString(value.mime_type) ||
    !hasExactKeys(value, ['kind', 'path', 'content_mode', 'mime_type'])
  ) {
    return invalidOpenFileResponse();
  }
  return { kind, path: value.path, content_mode: 'binary', mime_type: value.mime_type };
}

export function decodeOpenFileResponse(value: unknown): OpenFileResponse {
  if (!isRecord(value) || typeof value.path !== 'string') {
    return invalidOpenFileResponse();
  }
  let kind: WorkspaceFileKind;
  try {
    kind = decodeWorkspaceFileKind(value.kind);
  } catch {
    return invalidOpenFileResponse();
  }
  if (kind === 'markdown' || kind === 'excalidraw') {
    return decodeTextOpenFileResponse(kind, value as Record<string, unknown> & { path: string; content_mode: unknown });
  }
  if (kind === 'html') {
    return decodeHtmlOpenFileResponse(value as Record<string, unknown> & { path: string; content_mode: unknown });
  }
  if (kind === 'pdf' || kind === 'docx') {
    return decodePdfDocxOpenFileResponse(kind, value as Record<string, unknown> & { path: string; content_mode: unknown });
  }
  return decodeLooseBinaryOpenFileResponse(kind, value as Record<string, unknown> & { path: string; content_mode: unknown });
}
