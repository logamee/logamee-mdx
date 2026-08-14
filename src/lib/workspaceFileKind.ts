import type {
  DeleteWorkspaceEntryResponse,
  FileVersion,
  MutationOutcome,
  OpenFileResponse,
  RenameWorkspaceEntryResponse,
  SnapshotReceipt,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const U64_MAX = '18446744073709551615';
const U128_MAX = '340282366920938463463374607431768211455';

function isCanonicalDecimalWithin(value: unknown, maximum: string): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return value.length < maximum.length || (value.length === maximum.length && value <= maximum);
}

export function decodeFileVersion(value: unknown): FileVersion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['canonicalPath', 'platformIdentity', 'length', 'modifiedNanos', 'sha256']) ||
    typeof value.canonicalPath !== 'string' ||
    value.canonicalPath.length === 0 ||
    typeof value.platformIdentity !== 'string' ||
    value.platformIdentity.length === 0 ||
    !isCanonicalDecimalWithin(value.length, U64_MAX) ||
    !isCanonicalDecimalWithin(value.modifiedNanos, U128_MAX) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error('Invalid file version');
  }
  return {
    canonicalPath: value.canonicalPath,
    platformIdentity: value.platformIdentity,
    length: value.length,
    modifiedNanos: value.modifiedNanos,
    sha256: value.sha256,
  };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function invalidOpenFileResponse(): never {
  throw new Error('Invalid open file response');
}

function invalidWorkspaceSnapshot(): never {
  throw new Error('Invalid workspace snapshot');
}

function invalidSnapshotReceipt(): never {
  throw new Error('Invalid snapshot receipt');
}

function invalidMutationOutcome(): never {
  throw new Error('Invalid mutation outcome');
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workspace file kind: ${String(value)}`);
}

export type WorkspacePresentation =
  | { editor: 'markdown'; preview: 'jinxiu-markdown' }
  | { editor: 'html'; preview: 'html' }
  | { preview: 'excalidraw' }
  | { preview: 'image' }
  | { media_kind: 'video' | 'audio'; preview: 'media' }
  | { preview: 'pdf' }
  | { preview: 'docx' };

export const BINARY_DOCUMENT_SOURCE_LIMITS = {
  pdf: 64 * 1024 * 1024,
  docx: 32 * 1024 * 1024,
} as const;

const BINARY_DOCUMENT_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isCanonicalBase64WithinLimit(value: unknown, byteLimit: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;

  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(value[index]!) < 0) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== '=') return false;
  }
  if (padding === 2 && (BASE64_ALPHABET.indexOf(value[dataLength - 1]!) & 0x0f) !== 0) {
    return false;
  }
  if (padding === 1 && (BASE64_ALPHABET.indexOf(value[dataLength - 1]!) & 0x03) !== 0) {
    return false;
  }

  const decodedLength = (value.length / 4) * 3 - padding;
  return decodedLength > 0 && decodedLength <= byteLimit;
}

export function decodeWorkspaceFileKind(value: unknown): WorkspaceFileKind {
  switch (value) {
    case 'markdown':
    case 'html':
    case 'excalidraw':
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'docx':
      return value;
    default:
      throw new Error('Invalid workspace file kind');
  }
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

  if (kind === 'html') {
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
        kind,
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

  if (kind === 'pdf' || kind === 'docx') {
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

  if (
    value.content_mode !== 'binary' ||
    !isNonBlankString(value.mime_type) ||
    !hasExactKeys(value, ['kind', 'path', 'content_mode', 'mime_type'])
  ) {
    return invalidOpenFileResponse();
  }
  return { kind, path: value.path, content_mode: 'binary', mime_type: value.mime_type };
}

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

export function decodeSnapshotReceipt(value: unknown): SnapshotReceipt {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return invalidSnapshotReceipt();
  }

  if (value.status === 'fresh') {
    if (!hasExactKeys(value, ['status', 'snapshot'])) return invalidSnapshotReceipt();
    try {
      return { status: 'fresh', snapshot: decodeWorkspaceSnapshot(value.snapshot) };
    } catch {
      return invalidSnapshotReceipt();
    }
  }

  if (value.status === 'stale') {
    if (
      !hasExactKeys(value, ['status', 'workspace_token', 'repair_reason']) ||
      typeof value.workspace_token !== 'string' ||
      typeof value.repair_reason !== 'string'
    ) {
      return invalidSnapshotReceipt();
    }
    return {
      status: 'stale',
      workspace_token: value.workspace_token,
      repair_reason: value.repair_reason,
    };
  }

  if (value.status === 'not-applicable') {
    if (!hasExactKeys(value, ['status'])) return invalidSnapshotReceipt();
    return { status: 'not-applicable' };
  }

  return invalidSnapshotReceipt();
}

export function decodeMutationOutcome<T>(
  value: unknown,
  decodeCommitted: (value: unknown) => T,
): MutationOutcome<T> {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return invalidMutationOutcome();
  }

  if (value.status === 'confirmed-not-committed') {
    if (!hasExactKeys(value, ['status', 'message']) || typeof value.message !== 'string') {
      return invalidMutationOutcome();
    }
    return { status: 'confirmed-not-committed', message: value.message };
  }

  if (value.status === 'confirmed-committed') {
    if (!hasExactKeys(value, ['status', 'receipt']) || !isRecord(value.receipt)) {
      return invalidMutationOutcome();
    }
    if (!hasExactKeys(value.receipt, ['committed', 'workspace'])) return invalidMutationOutcome();
    try {
      return {
        status: 'confirmed-committed',
        receipt: {
          committed: decodeCommitted(value.receipt.committed),
          workspace: decodeSnapshotReceipt(value.receipt.workspace),
        },
      };
    } catch {
      return invalidMutationOutcome();
    }
  }

  if (value.status === 'indeterminate') {
    if (
      !hasExactKeys(value, ['status', 'operation', 'paths', 'recovery_message']) ||
      (value.operation !== 'create' &&
        value.operation !== 'delete' &&
        value.operation !== 'rename' &&
        value.operation !== 'write') ||
      !Array.isArray(value.paths) ||
      !value.paths.every((path) => typeof path === 'string') ||
      typeof value.recovery_message !== 'string'
    ) {
      return invalidMutationOutcome();
    }
    return {
      status: 'indeterminate',
      operation: value.operation,
      paths: [...value.paths],
      recovery_message: value.recovery_message,
    };
  }

  return invalidMutationOutcome();
}

export function getWorkspacePresentation(kind: WorkspaceFileKind): WorkspacePresentation {
  switch (kind) {
    case 'markdown':
      return { editor: 'markdown', preview: 'jinxiu-markdown' };
    case 'html':
      return { editor: 'html', preview: 'html' };
    case 'excalidraw':
      return { preview: 'excalidraw' };
    case 'image':
      return { preview: 'image' };
    case 'video':
      return { media_kind: 'video', preview: 'media' };
    case 'audio':
      return { media_kind: 'audio', preview: 'media' };
    case 'pdf':
      return { preview: 'pdf' };
    case 'docx':
      return { preview: 'docx' };
    default:
      return assertNever(kind);
  }
}
