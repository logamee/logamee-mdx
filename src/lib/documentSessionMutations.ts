import type { DeleteWorkspaceEntryResponse, MutationOutcome, RenameWorkspaceEntryResponse, WorkspaceMutation, WorkspaceSnapshot } from '../types';
import {
  isCurrentWorkspaceIdentity,
  isSameOrDescendantPath,
  reconcileWorkspaceReceipt,
  renamedActivePath,
} from './documentSessionWorkspace';
import type { ActiveWorkspaceIdentity, WorkspaceIdentity } from './documentSessionWorkspace';

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
