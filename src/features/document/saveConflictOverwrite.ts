/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import { getEditableFileKindForPath } from '../../lib/documentSession';
import { displayName } from '../../lib/documentNames';
import { normalizeAppError } from '../../lib/appFeedback';
import { cancelDocumentOverwriteToken, issueDocumentOverwriteToken, retryDocumentSaveWithToken } from '../../lib/tauriCommands';
import type { DocumentSaveResponse } from '../../types';
import { useExternalConflictResolution, type SaveConflictResolutionDeps } from './saveConflictResolution';

// 覆盖保存是否仍指向同一待处理冲突且外部动作已清空。
function overwritePendingCurrent(
  pending: import('./sessionTypes').PendingDocumentSaveConflict,
  deps: SaveConflictResolutionDeps,
): boolean {
  const current = deps.saveConflictRef.current;
  return current?.operationId === pending.operationId
    && current.documentId === pending.documentId
    && deps.documentGenerationRef.current === pending.documentGeneration
    && deps.activePathRef.current === pending.sourcePath
    && deps.externalFileActionRef.current === null;
}

// 覆盖保存失败分支：提示错误并按状态恢复外部动作或锁定权威未知。
function applyOverwriteFailure(
  outcome: Exclude<DocumentSaveResponse, { status: 'confirmed_committed' }>,
  pending: import('./sessionTypes').PendingDocumentSaveConflict,
  deps: SaveConflictResolutionDeps,
): void {
  deps.setError(normalizeAppError(new Error(outcome.message), deps.localeRef.current));
  deps.setSaveConflictState(null);
  if (outcome.status !== 'indeterminate' && pending.resumeExternalAction) {
    deps.setExternalFileActionState(pending.resumeExternalAction);
  }
  if (outcome.status === 'indeterminate') {
    deps.lockDocumentAuthorityUnknown();
  }
}

// 覆盖保存成功分支：落版本与内容，收尾崩溃草稿并刷新工作区。
async function applyOverwriteCommitted(
  outcome: Extract<DocumentSaveResponse, { status: 'confirmed_committed' }>,
  pending: import('./sessionTypes').PendingDocumentSaveConflict,
  deps: SaveConflictResolutionDeps,
): Promise<void> {
  deps.activeFileVersionRef.current = outcome.version;
  if (pending.saveKind === 'save-as') {
    deps.documentGenerationRef.current = pending.documentGeneration + 1;
    const savedKind = getEditableFileKindForPath(outcome.path);
    deps.applyDocumentSessionState({
      ...deps.currentDocumentSessionState(),
      activeFileKind: savedKind,
      activeMimeType: savedKind === 'html' ? 'text/html' : null,
      activePath: outcome.path,
      lastSavedContent: pending.content,
    });
  } else {
    deps.paneStateRef.current = { ...deps.paneStateRef.current, lastSavedContent: pending.content };
    deps.setLastSavedContent(pending.content);
  }
  deps.setSaveConflictState(null);
  await deps.cleanupConfirmedCrashDraft(pending.content);
  if (outcome.cleanup_repair_receipt) {
    deps.setNotice('The document was saved, but background cleanup still needs attention.');
  }
  const workspace = deps.getActiveWorkspace();
  if (!workspace) return;
  const generation = deps.workspaceGenerationRef.current;
  try {
    await deps.refreshWorkspaceDirect(workspace, generation);
  } catch (refreshError) {
    if (deps.isCurrentWorkspaceRequest(workspace, generation)) {
      deps.setError(normalizeAppError(refreshError, deps.localeRef.current));
    }
  }
}

// 令牌化的覆盖重试：仍当前时签发/复用令牌并重试保存，失去当前性则回收令牌。
async function runOverwriteSave(
  pending: import('./sessionTypes').PendingDocumentSaveConflict,
  deps: SaveConflictResolutionDeps,
): Promise<DocumentSaveResponse | null> {
  if (!overwritePendingCurrent(pending, deps)) return null;
  const issuedToken = pending.overwriteToken ?? (await issueDocumentOverwriteToken(
    pending.path, pending.content, pending.operationId,
  )).overwriteToken;
  if (!overwritePendingCurrent(pending, deps)) {
    await cancelDocumentOverwriteToken(pending.path, issuedToken).catch(() => undefined);
    return null;
  }
  try {
    return await retryDocumentSaveWithToken(pending.path, pending.content, pending.operationId, issuedToken);
  } catch (retryError) {
    await cancelDocumentOverwriteToken(pending.path, issuedToken).catch(() => undefined);
    throw retryError;
  }
}

// 覆盖动作：取消待处理冲突与令牌化覆盖重试。
function useOverwriteConflictActions(deps: SaveConflictResolutionDeps) {
  const { saveConflictRef, setSaveConflictState, setExternalFileActionState } = deps;

  const handleCancelSaveConflict = useCallback(() => {
    const pending = saveConflictRef.current;
    if (!pending || pending.busy) return;
    setSaveConflictState(null);
    if (pending.resumeExternalAction) setExternalFileActionState(pending.resumeExternalAction);
    if (pending.overwriteToken) {
      void cancelDocumentOverwriteToken(pending.path, pending.overwriteToken).catch(() => undefined);
    }
  }, [setExternalFileActionState, setSaveConflictState]);

  const handleOverwriteSaveConflict = useCallback(async () => {
    const pending = saveConflictRef.current;
    if (!pending || pending.busy || deps.isPopout) return;
    setSaveConflictState({ ...pending, busy: true });
    const result = await deps.executeSessionOperation({
      run: () => runOverwriteSave(pending, deps),
      isCurrent: () => overwritePendingCurrent(pending, deps),
      apply: async (outcome) => {
        if (!outcome) return;
        if (outcome.status !== 'confirmed_committed') {
          applyOverwriteFailure(outcome, pending, deps);
          return;
        }
        await applyOverwriteCommitted(outcome, pending, deps);
      },
    });
    if (!result && saveConflictRef.current?.operationId === pending.operationId) {
      setSaveConflictState({ ...pending, busy: false });
    }
  }, [
    deps.cleanupConfirmedCrashDraft,
    deps.applyDocumentSessionState,
    deps.currentDocumentSessionState,
    deps.executeSessionOperation,
    deps.isPopout,
    deps.lockDocumentAuthorityUnknown,
    setSaveConflictState,
    setExternalFileActionState,
  ]);

  return { handleCancelSaveConflict, handleOverwriteSaveConflict };
}

// 已删草稿动作：另存恢复草稿或关闭并推进崩溃草稿身份。
function useDeletedDraftActions(deps: SaveConflictResolutionDeps) {
  const { externalFileActionRef, setExternalFileActionBusy, setExternalFileActionState } = deps;

  const handleSaveDeletedDraftAs = useCallback(async () => {
    const action = externalFileActionRef.current;
    if (action?.kind !== 'deleted-draft') return;
    const deletedPath = action.envelope.snapshot.status === 'missing'
      ? action.envelope.snapshot.path
      : deps.activePathRef.current;
    setExternalFileActionBusy(true);
    try {
      const saved = await deps.saveDocumentAs(displayName(deletedPath), true);
      if (saved && externalFileActionRef.current === action) {
        setExternalFileActionState(null);
      }
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [deps.saveDocumentAs, setExternalFileActionState]);

  const handleCloseDeletedDraft = useCallback(async () => {
    if (externalFileActionRef.current?.kind !== 'deleted-draft') return;
    setExternalFileActionBusy(true);
    try {
      const priorCrashDocumentId = deps.crashDraftDocumentIdRef.current;
      await deps.crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
      await deps.stopAcceptedActiveDocumentWatch();
      setExternalFileActionState(null);
      deps.documentOpenRequestRef.current += 1;
      deps.documentGenerationRef.current += 1;
      deps.clearActiveDocument();
      deps.advanceCrashDraftIdentity(priorCrashDocumentId);
    } catch {
      deps.setError('The recovery draft could not be saved. The current document remains open.');
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [deps.advanceCrashDraftIdentity, deps.clearActiveDocument, setExternalFileActionState, deps.stopAcceptedActiveDocumentWatch]);

  return { handleCloseDeletedDraft, handleSaveDeletedDraftAs };
}

// 保存冲突处置：取消、令牌化覆盖重试、保持当前/采用外部与已删草稿动作。
export function useSaveConflictOverwrite(deps: SaveConflictResolutionDeps) {
  const { resolveExternalConflict } = useExternalConflictResolution(deps);
  const overwrite = useOverwriteConflictActions(deps);
  const deletedDraft = useDeletedDraftActions(deps);

  const handleKeepCurrentExternal = useCallback(async () => {
    await resolveExternalConflict('keep-current');
    await overwrite.handleOverwriteSaveConflict();
  }, [overwrite.handleOverwriteSaveConflict, resolveExternalConflict]);

  const handleUseExternal = useCallback(async () => {
    await resolveExternalConflict('use-external');
  }, [resolveExternalConflict]);

  return {
    handleCancelSaveConflict: overwrite.handleCancelSaveConflict,
    handleCloseDeletedDraft: deletedDraft.handleCloseDeletedDraft,
    handleKeepCurrentExternal,
    handleOverwriteSaveConflict: overwrite.handleOverwriteSaveConflict,
    handleSaveDeletedDraftAs: deletedDraft.handleSaveDeletedDraftAs,
    handleUseExternal,
  };
}
