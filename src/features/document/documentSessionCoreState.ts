/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：回调依赖数组保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import { EMPTY_MARKDOWN } from '../../lib/documentNames';
import { getMutationOutcomeMessage, type DocumentAuthorityStatus, type DocumentSessionState, type WorkspaceIdentity } from '../../lib/documentSession';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import type { DocumentSessionQueue, DocumentSessionQueueOperation, DocumentSessionQueueResult } from '../../lib/documentSessionQueue';
import type { PaneReplicatedState } from '../../lib/paneSync';
import type { MutationOutcome, WorkspaceDirectoryEntry, WorkspaceFileEntry, WorkspaceSnapshot } from '../../types';
import { useSaveFlowState } from './saveFlow';
import type { FileVersion } from '../../types';
import type { PendingDocumentSaveConflict } from './sessionTypes';

export interface DocumentSessionCoreStateDeps {
  activeFileVersionRef: RefObject<FileVersion | null>;
  activePathRef: RefObject<string | null>;
  externalFileActionRef: RefObject<import('./sessionTypes').ExternalFileActionState | null>;
  isPopout: boolean;
  localeRef: RefObject<EffectiveLocale>;
  paneStateRef: RefObject<PaneReplicatedState>;
  saveConflictRef: RefObject<PendingDocumentSaveConflict | null>;
  sessionQueue: DocumentSessionQueue;
  setActiveFileKind: Dispatch<SetStateAction<import('../../types').WorkspaceFileKind>>;
  setActiveMimeType: Dispatch<SetStateAction<string | null>>;
  setActivePath: Dispatch<SetStateAction<string | null>>;
  setAuthorityStatus: Dispatch<SetStateAction<DocumentAuthorityStatus>>;
  setBytesBase64: Dispatch<SetStateAction<string | null>>;
  setContent: Dispatch<SetStateAction<string>>;
  setDirectories: Dispatch<SetStateAction<WorkspaceDirectoryEntry[]>>;
  setDocumentIdentity: Dispatch<SetStateAction<{ documentId: string; documentEpoch: number }>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFiles: Dispatch<SetStateAction<WorkspaceFileEntry[]>>;
  setLastSavedContent: Dispatch<SetStateAction<string>>;
  setPreviewRevision: Dispatch<SetStateAction<number>>;
  setSaveConflict: Dispatch<SetStateAction<PendingDocumentSaveConflict | null>>;
  setWorkspaceRoot: Dispatch<SetStateAction<string | null>>;
  workspaceDirectoriesRef: RefObject<WorkspaceDirectoryEntry[]>;
  workspaceFilesRef: RefObject<WorkspaceFileEntry[]>;
  workspaceIdentityRef: RefObject<WorkspaceIdentity>;
  workspaceRollbackIdRef: RefObject<number>;
  workspaceSessionRestoreSettledRef: RefObject<boolean>;
}

// 队列执行入口：入队前清空错误，异常统一转友好文案并返回 null。
export function useSessionOperationQueue(deps: DocumentSessionCoreStateDeps) {
  const { localeRef, sessionQueue, setError } = deps;
  const executeSessionOperation = useCallback(async <T,>(
    operation: DocumentSessionQueueOperation<T>,
  ): Promise<DocumentSessionQueueResult<T> | null> => {
    try {
      return await sessionQueue.enqueue({
        ...operation,
        run: async () => {
          setError(null);
          return operation.run();
        },
      });
    } catch (err) {
      setError(normalizeAppError(err, localeRef.current));
      return null;
    }
  }, [sessionQueue]);

  const consumeMutationOutcome = useCallback(<T,>(outcome: MutationOutcome<T> | null) => {
    if (!outcome) return;
    const message = getMutationOutcomeMessage(outcome);
    if (message) setError(message);
  }, []);

  return { consumeMutationOutcome, executeSessionOperation };
}

// 工作区快照应用与回滚标记：失败回滚与重新打开在界面层可区分。
export function useWorkspaceSnapshotState(deps: DocumentSessionCoreStateDeps) {
  const { setDirectories, setFiles, setWorkspaceRoot } = deps;
  const { workspaceDirectoriesRef, workspaceFilesRef, workspaceIdentityRef, workspaceRollbackIdRef } = deps;
  const { paneStateRef } = deps;
  const [workspaceRollback, setWorkspaceRollback] = useState<{ id: number; root: string | null } | null>(null);

  const applyWorkspaceSnapshot = useCallback((response: WorkspaceSnapshot) => {
    workspaceIdentityRef.current = {
      workspaceToken: response.workspace_token,
      workspaceRoot: response.root,
    };
    paneStateRef.current = {
      ...paneStateRef.current,
      workspaceRoot: response.root,
    };
    workspaceFilesRef.current = response.files;
    workspaceDirectoriesRef.current = response.directories ?? [];
    setWorkspaceRoot(response.root);
    setFiles(response.files);
    setDirectories(response.directories ?? []);
  }, []);

  const restoreWorkspaceState = useCallback((snapshot: WorkspaceSnapshot | null) => {
    if (snapshot) {
      applyWorkspaceSnapshot(snapshot);
      return;
    }
    workspaceIdentityRef.current = { workspaceRoot: null, workspaceToken: null };
    workspaceFilesRef.current = [];
    workspaceDirectoriesRef.current = [];
    paneStateRef.current = { ...paneStateRef.current, workspaceRoot: null };
    setWorkspaceRoot(null);
    setFiles([]);
    setDirectories([]);
  }, [applyWorkspaceSnapshot]);

  // 回滚到上一个工作区快照时打标记，界面层据此区分“失败回滚”与“重新打开”，保留手动展开状态。
  const rollbackWorkspaceState = useCallback((prior: WorkspaceSnapshot | null) => {
    restoreWorkspaceState(prior);
    workspaceRollbackIdRef.current += 1;
    setWorkspaceRollback({ id: workspaceRollbackIdRef.current, root: prior?.root ?? null });
  }, [restoreWorkspaceState]);

  return { applyWorkspaceSnapshot, restoreWorkspaceState, rollbackWorkspaceState, workspaceRollback };
}

// 从面板镜像读取当前文档会话状态。
function paneStateDocumentSession(state: PaneReplicatedState): DocumentSessionState {
  return {
    documentId: state.documentId, documentEpoch: state.documentEpoch,
    authorityStatus: state.authorityStatus ?? 'unknown',
    activeFileKind: state.activeFileKind, activeMimeType: state.activeMimeType,
    activePath: state.activePath, bytesBase64: state.bytesBase64 ?? null,
    content: state.content, lastSavedContent: state.lastSavedContent,
    previewRevision: state.previewRevision,
  };
}

// 文档状态应用：路径换版本、整份会话状态下发与镜像读取。
export function useDocumentStateApplication(deps: DocumentSessionCoreStateDeps) {
  const { activeFileVersionRef, activePathRef, paneStateRef } = deps;
  const { setActiveFileKind, setActiveMimeType, setActivePath, setAuthorityStatus } = deps;
  const { setBytesBase64, setContent, setDocumentIdentity, setLastSavedContent, setPreviewRevision } = deps;

  const setActiveDocumentPath = useCallback((path: string | null) => {
    const previousPath = activePathRef.current;
    const currentVersion = activeFileVersionRef.current;
    if (path && previousPath && currentVersion?.canonicalPath === previousPath) {
      activeFileVersionRef.current = { ...currentVersion, canonicalPath: path };
    }
    activePathRef.current = path;
    paneStateRef.current = {
      ...paneStateRef.current,
      activePath: path,
    };
    setActivePath(path);
  }, []);

  const applyDocumentSessionState = useCallback((next: DocumentSessionState) => {
    const nextPaneState: PaneReplicatedState = {
      ...paneStateRef.current,
      ...next,
    };
    paneStateRef.current = nextPaneState;
    setDocumentIdentity({
      documentId: next.documentId,
      documentEpoch: next.documentEpoch,
    });
    setActiveFileKind(next.activeFileKind);
    setActiveMimeType(next.activeMimeType);
    setActiveDocumentPath(next.activePath);
    setBytesBase64(next.bytesBase64);
    setContent(next.content);
    setLastSavedContent(next.lastSavedContent);
    setPreviewRevision(next.previewRevision);
    setAuthorityStatus(next.authorityStatus);
  }, [setActiveDocumentPath]);

  const currentDocumentSessionState = useCallback(
    (): DocumentSessionState => paneStateDocumentSession(paneStateRef.current), []);

  return { applyDocumentSessionState, currentDocumentSessionState, setActiveDocumentPath };
}

// 动作受阻判定与清空文档：冲突/外部动作/会话未就绪期间阻止常规动作。
export function useDocumentActionGuards(
  deps: DocumentSessionCoreStateDeps,
  stateApplication: ReturnType<typeof useDocumentStateApplication>,
) {
  const { activeFileVersionRef, externalFileActionRef, isPopout, saveConflictRef } = deps;
  const { paneStateRef, setAuthorityStatus, setSaveConflict } = deps;
  const { setSaveConflictState, lockDocumentAuthorityUnknown } = useSaveFlowState({
    saveConflictRef, setSaveConflict, paneStateRef, setAuthorityStatus,
  });

  const clearActiveDocument = useCallback(() => {
    const current = stateApplication.currentDocumentSessionState();
    stateApplication.applyDocumentSessionState({
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: current.documentEpoch + 1,
      authorityStatus: 'committed',
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: null,
      bytesBase64: null,
      content: EMPTY_MARKDOWN,
      lastSavedContent: EMPTY_MARKDOWN,
      previewRevision: 0,
    });
    activeFileVersionRef.current = null;
    setSaveConflictState(null);
  }, [setSaveConflictState]);

  const ordinaryDocumentActionsBlocked = useCallback(
    () => externalFileActionRef.current !== null
      || saveConflictRef.current !== null
      || (!isPopout && !deps.workspaceSessionRestoreSettledRef.current),
    [isPopout],
  );

  const openIntentResolutionBlocked = useCallback(
    () => isPopout || externalFileActionRef.current !== null || saveConflictRef.current !== null,
    [isPopout],
  );

  return {
    clearActiveDocument,
    lockDocumentAuthorityUnknown,
    openIntentResolutionBlocked,
    ordinaryDocumentActionsBlocked,
    setSaveConflictState,
  };
}
