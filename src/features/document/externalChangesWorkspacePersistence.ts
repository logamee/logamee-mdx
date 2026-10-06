
export type WorkspaceSessionPersistence = {
  enqueueWorkspaceSessionPersist: (workspace: import('./sessionTypes').ActiveWorkspaceIdentity, activePath: string | null) => Promise<void>;
  flushWorkspaceSession: () => Promise<void>;
  getActiveWorkspace: () => import('./sessionTypes').ActiveWorkspaceIdentity | null;
  isCurrentWorkspaceRequest: (workspace: import('./sessionTypes').ActiveWorkspaceIdentity, generation: number) => boolean;
  settleWorkspaceSessionRestore: () => void;
};

