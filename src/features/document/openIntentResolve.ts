import { discardOpenReceipt, settleOpenIntentWorkspace } from '../../lib/tauriCommands';
import type { PreparedOpenFileResponse, WorkspaceSnapshot } from '../../types';
import type { ResolvedOpenIntent } from '../../lib/openIntent';
import type { OpenIntentDeps } from './openIntentTypes';

export interface ResolvedApplyHandles {
  deps: OpenIntentDeps;
  claimPreparedOpen: (
    prepared: PreparedOpenFileResponse | null,
    requestedGeneration: number,
  ) => number | null;
  applyPreparedOpen: (
    prepared: PreparedOpenFileResponse,
    generation: number,
    reportFailure?: boolean,
    discardCurrentCrashDraft?: boolean,
  ) => Promise<'committed' | 'not_committed' | 'stale' | 'indeterminate'>;
  synchronizeWorkspaceForStandaloneFile: (
    path: string,
    generation: number,
    intentId: string,
  ) => Promise<void>;
  requestedDocumentGeneration: number;
  intentId: string;
  discardCurrentCrashDraft: boolean;
}

// 打开意图解决结果已过期时丢弃其回执（文件收据/工作区收据）。
export async function discardResolvedOpenReceipts(resolved: ResolvedOpenIntent): Promise<void> {
  const prepared = resolved.kind === 'file'
    ? resolved.prepared
    : resolved.kind === 'session_restore'
      ? resolved.restore?.active_file ?? null
      : null;
  if (prepared) {
    await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
  }
  const workspaceOpenReceipt = resolved.kind === 'directory'
    ? resolved.workspace_open_receipt
    : resolved.kind === 'session_restore'
      ? resolved.workspace_open_receipt
      : null;
  if (workspaceOpenReceipt) {
    await settleOpenIntentWorkspace(workspaceOpenReceipt, false).catch(() => undefined);
  }
}

export function openIntentRequestStale(
  deps: OpenIntentDeps,
  requestedOpen: number,
  requestedGeneration: number,
): boolean {
  return deps.documentOpenRequestRef.current !== requestedOpen
    || deps.documentGenerationRef.current !== requestedGeneration
    || !deps.workspaceSessionRestoreMountedRef.current;
}

// 按解决类型派发：文件 → 已备打开；会话恢复 → 工作区快照+活跃文件；目录 → 工作区快照。
export async function applyResolvedOpenIntent(
  resolved: ResolvedOpenIntent,
  handles: ResolvedApplyHandles,
): Promise<boolean> {
  if (resolved.kind === 'file') return applyResolvedFile(resolved, handles);
  if (resolved.kind === 'session_restore') return applyResolvedSessionRestore(resolved, handles);
  return applyResolvedDirectory(resolved, handles);
}

async function applyResolvedFile(
  resolved: Extract<ResolvedOpenIntent, { kind: 'file' }>,
  handles: ResolvedApplyHandles,
): Promise<boolean> {
  const { claimPreparedOpen, applyPreparedOpen } = handles;
  const appliedGeneration = claimPreparedOpen(
    resolved.prepared,
    handles.requestedDocumentGeneration,
  );
  if (appliedGeneration !== null) {
    const fileApplied = await applyPreparedOpen(
      resolved.prepared,
      appliedGeneration,
      true,
      handles.discardCurrentCrashDraft,
    ) === 'committed';
    if (fileApplied) {
      await handles.synchronizeWorkspaceForStandaloneFile(
        resolved.prepared.file.path,
        appliedGeneration,
        handles.intentId,
      );
    }
    return fileApplied;
  }
  return false;
}

type PriorWorkspaceSnapshot = WorkspaceSnapshot | null;

function priorWorkspaceFrom(deps: OpenIntentDeps): PriorWorkspaceSnapshot {
  const current = deps.workspaceIdentityRef.current;
  if (!current.workspaceRoot || !current.workspaceToken) return null;
  return {
    workspace_token: current.workspaceToken,
    root: current.workspaceRoot,
    files: [...deps.workspaceFilesRef.current],
    directories: [...deps.workspaceDirectoriesRef.current],
  };
}

async function rollbackWithActiveFile(
  deps: OpenIntentDeps,
  prior: PriorWorkspaceSnapshot,
  activeFile: PreparedOpenFileResponse | null,
): Promise<void> {
  deps.rollbackWorkspaceState(prior);
  if (activeFile) {
    await discardOpenReceipt(activeFile.open_receipt).catch(() => undefined);
  }
}

async function applyResolvedSessionRestore(
  resolved: Extract<ResolvedOpenIntent, { kind: 'session_restore' }>,
  handles: ResolvedApplyHandles,
): Promise<boolean> {
  const { deps } = handles;
  const restored = resolved.restore;
  if (!restored) return true;
  const prior = priorWorkspaceFrom(deps);
  deps.workspaceGenerationRef.current += 1;
  deps.applyWorkspaceSnapshot(restored.workspace);
  const workspaceOpenReceipt = resolved.workspace_open_receipt;
  if (!workspaceOpenReceipt) {
    await rollbackWithActiveFile(deps, prior, restored.active_file);
    return false;
  }
  let workspaceSettlement;
  try {
    workspaceSettlement = await settleOpenIntentWorkspace(workspaceOpenReceipt, true);
  } catch (error) {
    await rollbackWithActiveFile(deps, prior, restored.active_file);
    throw error;
  }
  if (workspaceSettlement !== 'applied') {
    await rollbackWithActiveFile(deps, prior, restored.active_file);
    return false;
  }
  const prepared = restored.active_file;
  if (!prepared) return true;
  const appliedGeneration = handles.claimPreparedOpen(
    prepared,
    handles.requestedDocumentGeneration,
  );
  if (appliedGeneration === null) {
    await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
    return false;
  }
  return await handles.applyPreparedOpen(
    prepared,
    appliedGeneration,
    false,
    handles.discardCurrentCrashDraft,
  ) === 'committed';
}

async function applyResolvedDirectory(
  resolved: Extract<ResolvedOpenIntent, { kind: 'directory' }>,
  handles: ResolvedApplyHandles,
): Promise<boolean> {
  const { deps } = handles;
  const prior = priorWorkspaceFrom(deps);
  deps.workspaceGenerationRef.current += 1;
  deps.applyWorkspaceSnapshot(resolved.workspace);
  try {
    const workspaceSettlement = await settleOpenIntentWorkspace(
      resolved.workspace_open_receipt,
      true,
    );
    if (workspaceSettlement === 'applied') return true;
    deps.rollbackWorkspaceState(prior);
    return false;
  } catch (error) {
    deps.rollbackWorkspaceState(prior);
    throw error;
  }
}
