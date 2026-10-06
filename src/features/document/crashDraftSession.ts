/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  createCrashDraftScheduler,
  type CrashDraftRecoverResponse,
  type CrashDraftScheduler,
} from '../../lib/crashDrafts';
import { crashDraftCommands } from '../../lib/crashDraftCommands';
import { isEditableFileKind, type DocumentSessionState } from '../../lib/documentSession';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import type { PaneReplicatedState } from '../../lib/paneSync';
import type { FileVersion, WorkspaceFileKind } from '../../types';
import type { ExternalFileActionState, PendingDocumentSaveConflict } from './sessionTypes';

export interface CrashDraftSessionDeps {
  activeFileKind: WorkspaceFileKind;
  activeFileVersionRef: RefObject<FileVersion | null>;
  activePath: string | null;
  advanceCrashDraftIdentity: (priorDocumentId: string) => void;
  afterConfirmedSave?: (documentId: string) => boolean | void | Promise<boolean | void>;
  applyDocumentSessionState: (next: DocumentSessionState) => void;
  authorityStatus: DocumentSessionState['authorityStatus'];
  clearActiveDocument: () => void;
  content: string;
  crashDraftDocumentIdRef: RefObject<string>;
  crashDraftSchedulerRef: RefObject<CrashDraftScheduler | null>;
  currentDocumentSessionState: () => DocumentSessionState;
  dirty: boolean;
  documentEpoch: number;
  documentGenerationRef: RefObject<number>;
  documentOpenRequestRef: RefObject<number>;
  forcedDirtyCrashDraftIdRef: RefObject<string | null>;
  isPopout: boolean;
  ordinaryDocumentActionsBlocked: () => boolean;
  paneStateRef: RefObject<PaneReplicatedState>;
  setExternalFileActionState: (next: ExternalFileActionState | null) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void;
  stopAcceptedActiveDocumentWatch: () => Promise<void>;
}

// 崩溃草稿调度器生命周期：主窗口挂载时创建，卸载时释放。
function useCrashDraftSchedulerLifecycle(deps: CrashDraftSessionDeps): void {
  const { crashDraftSchedulerRef, isPopout } = deps;
  useEffect(() => {
    if (isPopout) return undefined;
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: crashDraftCommands.write,
    });
    crashDraftSchedulerRef.current = scheduler;
    return () => {
      if (crashDraftSchedulerRef.current === scheduler) crashDraftSchedulerRef.current = null;
      scheduler.dispose();
    };
  }, [isPopout]);
}

// 写入会话：按需落盘当前草稿、确认保存后收尾，以及脏状态下的自动排程。
function useCrashDraftWriteSession(deps: CrashDraftSessionDeps) {
  const { crashDraftDocumentIdRef, crashDraftSchedulerRef, forcedDirtyCrashDraftIdRef } = deps;
  const { activeFileVersionRef, isPopout, paneStateRef } = deps;

  const flushCrashDraft = useCallback(async () => {
    await crashDraftSchedulerRef.current?.flush(crashDraftDocumentIdRef.current);
  }, []);

  const scheduleCurrentCrashDraft = useCallback(() => {
    if (isPopout) return;
    const current = paneStateRef.current;
    if ((current.authorityStatus ?? 'unknown') !== 'committed'
      || !isEditableFileKind(current.activeFileKind)) return;
    const version = activeFileVersionRef.current;
    if (current.activePath && !version) return;
    crashDraftSchedulerRef.current?.schedule({
      documentId: crashDraftDocumentIdRef.current,
      fileKind: current.activeFileKind,
      pathHint: current.activePath,
      baseVersionToken: current.activePath ? version!.sha256 : null,
      content: current.content,
    });
  }, [isPopout]);

  const cleanupConfirmedCrashDraft = useCallback(async (committedContent: string) => {
    const crashDocumentId = crashDraftDocumentIdRef.current;
    if (paneStateRef.current.content !== committedContent) {
      try {
        scheduleCurrentCrashDraft();
      } catch {
        deps.setError('The document was saved, but newer edits could not be added to crash recovery.');
      }
      return;
    }
    try {
      await crashDraftSchedulerRef.current?.flush(crashDocumentId);
    } catch {
      deps.setError('The document was saved, but its recovery draft could not be finalized.');
      return;
    }
    const cleaned = await deps.afterConfirmedSave?.(crashDocumentId);
    if (cleaned === false) return;
    crashDraftSchedulerRef.current?.invalidate(crashDocumentId);
    forcedDirtyCrashDraftIdRef.current = null;
  }, [deps.afterConfirmedSave, scheduleCurrentCrashDraft]);

  return { cleanupConfirmedCrashDraft, flushCrashDraft, scheduleCurrentCrashDraft };
}

// 存储令牌桥：草稿恢复对话框用的 revision 种子与丢弃确认。
function useCrashDraftTokens(deps: CrashDraftSessionDeps) {
  const { crashDraftSchedulerRef } = deps;
  const seedCrashDraftRevision = useCallback((documentId: string, revision: number, entryToken: string) => {
    crashDraftSchedulerRef.current?.seedRevision(documentId, revision, entryToken);
  }, []);

  const getCrashDraftStoredEntryToken = useCallback((documentId: string) => (
    crashDraftSchedulerRef.current?.getStoredEntryToken(documentId) ?? null
  ), []);

  const confirmCrashDraftDiscarded = useCallback((documentId: string, entryToken: string) => {
    crashDraftSchedulerRef.current?.confirmDiscarded(documentId, entryToken);
  }, []);

  return { confirmCrashDraftDiscarded, getCrashDraftStoredEntryToken, seedCrashDraftRevision };
}

// 恢复后的草稿文档状态：新文档身份、无路径、内容以草稿为准。
function crashDraftRecoveredDocumentState(
  draft: CrashDraftRecoverResponse,
  current: DocumentSessionState,
): DocumentSessionState {
  return {
    documentId: createPaneProtocolId('pane-document'),
    documentEpoch: current.documentEpoch + 1,
    authorityStatus: 'committed',
    activeFileKind: draft.fileKind,
    activeMimeType: draft.fileKind === 'html' ? 'text/html' : null,
    activePath: null,
    bytesBase64: null,
    content: draft.content,
    lastSavedContent: draft.content,
    previewRevision: 0,
  };
}

// 恢复与新建：草稿恢复换文档身份，新建先冲刷旧草稿再清空文档。
function useCrashDraftRecovery(deps: CrashDraftSessionDeps) {
  const { activeFileVersionRef, crashDraftDocumentIdRef, crashDraftSchedulerRef } = deps;
  const { forcedDirtyCrashDraftIdRef, isPopout } = deps;

  const recoverCrashDraft = useCallback(async (draft: CrashDraftRecoverResponse) => {
    if (isPopout) return;
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    await deps.stopAcceptedActiveDocumentWatch();
    deps.documentOpenRequestRef.current += 1;
    deps.documentGenerationRef.current += 1;
    crashDraftSchedulerRef.current?.invalidate(priorCrashDocumentId);
    crashDraftDocumentIdRef.current = draft.documentId;
    forcedDirtyCrashDraftIdRef.current = draft.documentId;
    activeFileVersionRef.current = null;
    deps.applyDocumentSessionState(crashDraftRecoveredDocumentState(
      draft,
      deps.currentDocumentSessionState(),
    ));
    deps.setExternalFileActionState(null);
    deps.setSaveConflictState(null);
  }, [
    deps.applyDocumentSessionState,
    deps.currentDocumentSessionState,
    isPopout,
    deps.setExternalFileActionState,
    deps.setSaveConflictState,
    deps.stopAcceptedActiveDocumentWatch,
  ]);

  const handleNew = useCallback(async () => {
    if (deps.ordinaryDocumentActionsBlocked()) return;
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    try {
      await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    } catch {
      deps.setError('The recovery draft could not be saved. The current document remains open.');
      return;
    }
    deps.documentOpenRequestRef.current += 1;
    deps.documentGenerationRef.current += 1;
    deps.clearActiveDocument();
    deps.advanceCrashDraftIdentity(priorCrashDocumentId);
    deps.setError(null);
  }, [deps.advanceCrashDraftIdentity, deps.clearActiveDocument, deps.ordinaryDocumentActionsBlocked]);

  return { handleNew, recoverCrashDraft };
}

// 脏状态自动排程：可编辑且已提交的脏文档持续登记崩溃草稿。
function useCrashDraftDirtyScheduler(
  deps: CrashDraftSessionDeps,
  scheduleCurrentCrashDraft: () => void,
): void {
  const { activeFileVersionRef, isPopout } = deps;
  useEffect(() => {
    if (isPopout
      || !deps.dirty
      || deps.authorityStatus !== 'committed'
      || !isEditableFileKind(deps.activeFileKind)) return;
    const version = activeFileVersionRef.current;
    if (deps.activePath && !version) return;
    try {
      scheduleCurrentCrashDraft();
    } catch {
      deps.setError('Crash recovery could not save the current edits. Your work remains in the editor.');
    }
  }, [deps.activeFileKind, deps.activePath, deps.authorityStatus, deps.content, deps.dirty, deps.documentEpoch, isPopout, scheduleCurrentCrashDraft]);
}

// 崩溃草稿会话：调度器生命周期、写入/令牌/恢复三个子域统一组合。
export function useCrashDraftSession(deps: CrashDraftSessionDeps) {
  useCrashDraftSchedulerLifecycle(deps);
  const write = useCrashDraftWriteSession(deps);
  useCrashDraftDirtyScheduler(deps, write.scheduleCurrentCrashDraft);
  const tokens = useCrashDraftTokens(deps);
  const recovery = useCrashDraftRecovery(deps);
  return {
    cleanupConfirmedCrashDraft: write.cleanupConfirmedCrashDraft,
    confirmCrashDraftDiscarded: tokens.confirmCrashDraftDiscarded,
    flushCrashDraft: write.flushCrashDraft,
    getCrashDraftStoredEntryToken: tokens.getCrashDraftStoredEntryToken,
    handleNew: recovery.handleNew,
    recoverCrashDraft: recovery.recoverCrashDraft,
    scheduleCurrentCrashDraft: write.scheduleCurrentCrashDraft,
    seedCrashDraftRevision: tokens.seedCrashDraftRevision,
  };
}
