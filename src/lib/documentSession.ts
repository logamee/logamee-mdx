import type {
  DeleteWorkspaceEntryResponse,
  MutationOutcome,
  OpenCommitResult,
  OpenCommitStatus,
  OpenFileResponse,
  PreparedOpenFileResponse,
  RenameWorkspaceEntryResponse,
  SnapshotReceipt,
  WorkspaceDirectoryListing,
  WorkspaceFileKind,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from '../types';

export interface DocumentState {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  bytesBase64: string | null;
  content: string;
  lastSavedContent: string;
  previewRevision: number;
}

export type DocumentAuthorityStatus = 'committed' | 'provisional' | 'unknown' | 'failed';

export interface DocumentSessionState extends DocumentState {
  documentId: string;
  documentEpoch: number;
  authorityStatus: DocumentAuthorityStatus;
}

export interface ProvisionalDocumentTransition {
  prior: DocumentSessionState;
  provisional: DocumentSessionState & { authorityStatus: 'provisional' };
}

export function createProvisionalDocumentTransition(
  current: DocumentSessionState,
  response: OpenFileResponse,
  identity: Pick<DocumentSessionState, 'documentId' | 'documentEpoch'>,
): ProvisionalDocumentTransition {
  return {
    prior: { ...current },
    provisional: {
      ...getOpenedDocumentState(response),
      ...identity,
      authorityStatus: 'provisional',
    },
  };
}

export function finalizeProvisionalDocument(
  provisional: DocumentSessionState,
): DocumentSessionState {
  return { ...provisional, authorityStatus: 'committed' };
}

export function restoreDocumentSnapshot(snapshot: DocumentSessionState): DocumentSessionState {
  return { ...snapshot };
}

export function nextPreparedOpenGeneration(
  currentGeneration: number,
  requestedGeneration: number,
  prepared: PreparedOpenFileResponse | null,
): number | null {
  if (!prepared || currentGeneration !== requestedGeneration) return null;
  return currentGeneration + 1;
}

interface OpenCommitPorts {
  commit: (openReceipt: string) => Promise<OpenCommitResult>;
  getStatus: (commitOperationId: string) => Promise<OpenCommitStatus>;
  waitBeforeRetry?: () => Promise<void>;
}

const OPEN_COMMIT_STATUS_CHECK_LIMIT = 3;
const OPEN_COMMIT_STATUS_RETRY_DELAY_MS = 50;

function waitBeforeOpenCommitStatusRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, OPEN_COMMIT_STATUS_RETRY_DELAY_MS);
  });
}

export async function resolveOpenCommitOutcome(
  prepared: PreparedOpenFileResponse,
  ports: OpenCommitPorts,
): Promise<OpenCommitStatus> {
  try {
    return await ports.commit(prepared.open_receipt);
  } catch {
    // The backend may have committed before the IPC response was lost.
  }

  for (let attempt = 0; attempt < OPEN_COMMIT_STATUS_CHECK_LIMIT; attempt += 1) {
    let status: OpenCommitStatus;
    try {
      status = await ports.getStatus(prepared.commit_operation_id);
    } catch {
      return { status: 'unknown' };
    }
    if (status.status !== 'pending') return status;
    if (attempt + 1 < OPEN_COMMIT_STATUS_CHECK_LIMIT) {
      try {
        await (ports.waitBeforeRetry ?? waitBeforeOpenCommitStatusRetry)();
      } catch {
        return { status: 'unknown' };
      }
    }
  }

  return { status: 'unknown' };
}

export interface WorkspaceIdentity {
  workspaceToken: string | null;
  workspaceRoot: string | null;
}

interface ActiveWorkspaceIdentity {
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

function renamedActivePath(
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

function isSameOrDescendantPath(path: string | null, parentPath: string): boolean {
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

interface CreateWorkspaceDirectoryPorts {
  createDirectory: (
    workspaceToken: string,
    parentPath: string,
    name: string,
  ) => Promise<MutationOutcome<WorkspaceMutation> | null>;
  getCurrentWorkspace: () => WorkspaceIdentity;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  refresh: () => Promise<void>;
}

export async function createWorkspaceDirectoryAndReconcile(
  requestedWorkspace: ActiveWorkspaceIdentity,
  parentPath: string,
  name: string,
  ports: CreateWorkspaceDirectoryPorts,
): Promise<string | null> {
  const outcome = await ports.createDirectory(requestedWorkspace.workspaceToken, parentPath, name);
  if (!outcome || !isCurrentWorkspaceIdentity(ports.getCurrentWorkspace(), requestedWorkspace)) {
    return null;
  }
  if (outcome.status !== 'confirmed-committed') {
    return outcome.status === 'confirmed-not-committed' ? outcome.message : outcome.recovery_message;
  }
  return reconcileWorkspaceReceipt(
    requestedWorkspace.workspaceToken,
    outcome.receipt.workspace,
    {
      workspaceRoot: requestedWorkspace.workspaceRoot,
      applySnapshot: ports.applySnapshot,
      refresh: ports.refresh,
    },
  );
}

interface RenameWorkspaceEntryPorts {
  renameEntry: (
    workspaceToken: string,
    path: string,
    newName: string,
  ) => Promise<MutationOutcome<RenameWorkspaceEntryResponse> | null>;
  getCurrentWorkspace: () => WorkspaceIdentity;
  getActivePath: () => string | null;
  setActivePath: (path: string) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  refresh: () => Promise<void>;
}

interface MoveWorkspaceEntryPorts {
  moveEntry: (
    workspaceToken: string,
    path: string,
    destinationParentPath: string,
  ) => Promise<MutationOutcome<RenameWorkspaceEntryResponse> | null>;
  getCurrentWorkspace: () => WorkspaceIdentity;
  getActivePath: () => string | null;
  setActivePath: (path: string) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  refresh: () => Promise<void>;
}

async function reconcileWorkspaceEntryRelocation(
  requestedWorkspace: ActiveWorkspaceIdentity,
  outcome: MutationOutcome<RenameWorkspaceEntryResponse> | null,
  ports: Pick<
    RenameWorkspaceEntryPorts,
    'getCurrentWorkspace' | 'getActivePath' | 'setActivePath' | 'applySnapshot' | 'refresh'
  >,
): Promise<string | null> {
  if (!outcome || !isCurrentWorkspaceIdentity(ports.getCurrentWorkspace(), requestedWorkspace)) {
    return null;
  }
  if (outcome.status !== 'confirmed-committed') {
    return outcome.status === 'confirmed-not-committed' ? outcome.message : outcome.recovery_message;
  }

  const { committed, workspace } = outcome.receipt;
  const nextActivePath = renamedActivePath(
    ports.getActivePath(),
    committed.old_path,
    committed.new_path,
  );
  if (nextActivePath) ports.setActivePath(nextActivePath);

  return reconcileWorkspaceReceipt(
    requestedWorkspace.workspaceToken,
    workspace,
    {
      workspaceRoot: requestedWorkspace.workspaceRoot,
      applySnapshot: ports.applySnapshot,
      refresh: ports.refresh,
    },
  );
}

export async function renameWorkspaceEntryAndReconcile(
  requestedWorkspace: ActiveWorkspaceIdentity,
  path: string,
  newName: string,
  ports: RenameWorkspaceEntryPorts,
): Promise<string | null> {
  const outcome = await ports.renameEntry(requestedWorkspace.workspaceToken, path, newName);
  return reconcileWorkspaceEntryRelocation(requestedWorkspace, outcome, ports);
}

export async function moveWorkspaceEntryAndReconcile(
  requestedWorkspace: ActiveWorkspaceIdentity,
  path: string,
  destinationParentPath: string,
  ports: MoveWorkspaceEntryPorts,
): Promise<string | null> {
  const outcome = await ports.moveEntry(
    requestedWorkspace.workspaceToken,
    path,
    destinationParentPath,
  );
  return reconcileWorkspaceEntryRelocation(requestedWorkspace, outcome, ports);
}

interface DeleteWorkspaceEntryPorts {
  deleteEntry: (
    workspaceToken: string,
    path: string,
  ) => Promise<MutationOutcome<DeleteWorkspaceEntryResponse> | null>;
  getCurrentWorkspace: () => WorkspaceIdentity;
  getActivePath: () => string | null;
  clearActiveDocument: () => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  refresh: () => Promise<void>;
}

export async function deleteWorkspaceEntryAndReconcile(
  requestedWorkspace: ActiveWorkspaceIdentity,
  path: string,
  ports: DeleteWorkspaceEntryPorts,
): Promise<string | null> {
  const outcome = await ports.deleteEntry(requestedWorkspace.workspaceToken, path);
  if (!outcome || !isCurrentWorkspaceIdentity(ports.getCurrentWorkspace(), requestedWorkspace)) {
    return null;
  }
  if (outcome.status !== 'confirmed-committed') {
    if (outcome.status === 'confirmed-not-committed') return outcome.message;
    try {
      await ports.refresh();
    } catch {
      // The recovery message remains the authoritative user-facing guidance.
    }
    return outcome.recovery_message;
  }

  const { committed, workspace } = outcome.receipt;
  if (isSameOrDescendantPath(ports.getActivePath(), committed.deleted_path)) {
    ports.clearActiveDocument();
  }

  return reconcileWorkspaceReceipt(
    requestedWorkspace.workspaceToken,
    workspace,
    {
      workspaceRoot: requestedWorkspace.workspaceRoot,
      applySnapshot: ports.applySnapshot,
      refresh: ports.refresh,
    },
  );
}

export function isDocumentDirty(state: Pick<DocumentState, 'activeFileKind' | 'content' | 'lastSavedContent'>): boolean {
  return isEditableFileKind(state.activeFileKind) && state.content !== state.lastSavedContent;
}
