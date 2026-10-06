import type { MutationOutcome, OpenFileResponse, SnapshotReceipt, WorkspaceDirectoryListing, WorkspaceFileKind, WorkspaceSnapshot } from '../types';
import type { DocumentState } from './documentSessionTypes';

export interface WorkspaceIdentity {
  workspaceToken: string | null;
  workspaceRoot: string | null;
}

export interface ActiveWorkspaceIdentity {
  workspaceToken: string;
  workspaceRoot: string;
}

interface WorkspaceSelectionPorts {
  advanceGeneration: () => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
}

export function applyWorkspaceSelection(
  selection: WorkspaceSnapshot | null,
  ports: WorkspaceSelectionPorts,
): boolean {
  if (!selection) return false;
  ports.advanceGeneration();
  ports.applySnapshot(selection);
  return true;
}

export function getMutationOutcomeMessage<T>(outcome: MutationOutcome<T>): string | null {
  if (outcome.status === 'confirmed-not-committed') return outcome.message;
  if (outcome.status === 'indeterminate') return outcome.recovery_message;
  return null;
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

export function renamedActivePath(
  activePath: string | null,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  if (!activePath) return null;
  const normalizedPath = normalizePathSeparators(activePath);
  const normalizedOldPrefix = normalizePathSeparators(oldPrefix).replace(/\/$/, '');
  if (normalizedPath !== normalizedOldPrefix && !normalizedPath.startsWith(`${normalizedOldPrefix}/`)) {
    return null;
  }
  return `${newPrefix}${normalizedPath.slice(normalizedOldPrefix.length)}`;
}

export function isSameOrDescendantPath(path: string | null, parentPath: string): boolean {
  if (!path) return false;
  const normalizedPath = normalizePathSeparators(path);
  const normalizedParent = normalizePathSeparators(parentPath).replace(/\/$/, '');
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function isCurrentWorkspaceIdentity(
  current: WorkspaceIdentity,
  requested: WorkspaceIdentity,
): boolean {
  return current.workspaceToken === requested.workspaceToken
    && current.workspaceRoot === requested.workspaceRoot;
}

export function isEditableFileKind(
  kind: WorkspaceFileKind,
): kind is 'markdown' | 'html' | 'excalidraw' {
  return kind === 'markdown' || kind === 'html' || kind === 'excalidraw';
}

let documentSaveOperationSequence = 0;

export function createDocumentSaveOperationId(): string {
  documentSaveOperationSequence = (documentSaveOperationSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `document-save-${Date.now().toString(36)}-${documentSaveOperationSequence.toString(36)}`;
}

export function getEditableFileKindForPath(
  path: string,
): Extract<WorkspaceFileKind, 'markdown' | 'html' | 'excalidraw'> {
  if (/\.excalidraw$/i.test(path)) return 'excalidraw';
  return /\.(?:html?|xhtml)$/i.test(path) ? 'html' : 'markdown';
}

export function getOpenedDocumentState(response: OpenFileResponse): DocumentState {
  const content = response.kind === 'markdown' || response.kind === 'html' || response.kind === 'excalidraw'
    ? response.content
    : '';
  const bytesBase64 = response.kind === 'pdf' || response.kind === 'docx'
    ? response.bytes_base64
    : null;
  return {
    activeFileKind: response.kind,
    activeMimeType: response.mime_type ?? null,
    activePath: response.path,
    bytesBase64,
    content,
    lastSavedContent: content,
    previewRevision: 0,
  };
}

export function getWorkspaceDirectoryListingState(
  workspaceRoot: string | null,
  listing: WorkspaceDirectoryListing,
) {
  if (workspaceRoot !== listing.root) return null;
  return {
    files: listing.files,
    directories: listing.directories,
  };
}

interface WorkspaceReceiptPorts {
  workspaceRoot: string;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  refresh: () => Promise<void>;
}

export async function reconcileWorkspaceReceipt(
  workspaceToken: string,
  receipt: SnapshotReceipt,
  ports: WorkspaceReceiptPorts,
): Promise<string | null> {
  if (receipt.status === 'not-applicable') return null;

  const receiptToken = receipt.status === 'fresh'
    ? receipt.snapshot.workspace_token
    : receipt.workspace_token;
  if (receiptToken !== workspaceToken) {
    return 'Workspace mutation receipt does not match the active workspace';
  }

  if (receipt.status === 'fresh') {
    if (receipt.snapshot.root !== ports.workspaceRoot) {
      return 'Workspace mutation receipt does not match the active workspace';
    }
    ports.applySnapshot(receipt.snapshot);
  } else {
    await ports.refresh();
  }
  return null;
}
