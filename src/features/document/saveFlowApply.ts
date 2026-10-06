import { normalizeAppError } from '../../lib/appFeedback';
import { getEditableFileKindForPath } from '../../lib/documentSession';
import { saveAsDialog, writeFile } from '../../lib/tauriCommands';
import type { SaveFlowDeps } from './saveFlowTypes';
import type { DocumentSaveResponse } from '../../types';

type DocumentSaveFailure = Extract<DocumentSaveResponse, { status: 'conflict' }> | Extract<DocumentSaveResponse, { status: 'indeterminate' }> | { status: string; message: string; path: string };
import type { PendingDocumentSaveConflict } from './sessionTypes';

// Save As 的 apply 分支：冲突入模态、失败上报、确认提交后换路径/类型并直刷工作区。
export async function applySaveAsOutcome(
  outcome: Awaited<ReturnType<typeof saveAsDialog>>,
  ctx: {
    deps: SaveFlowDeps;
    allowExternalRecovery: boolean;
    contentToSave: string;
    document: ReturnType<SaveFlowDeps['currentDocumentSessionState']>;
    operationId: string;
    requestedDocumentGeneration: number;
    requestedWorkspaceGeneration: number;
    requestedWorkspace: ReturnType<SaveFlowDeps['getActiveWorkspace']>;
    sourcePath: string | null;
  },
): Promise<void> {
  const { deps } = ctx;
  if (!outcome) return;
  if (outcome.status !== 'confirmed_committed') {
    applySaveAsFailure(outcome, ctx);
    return;
  }

  deps.documentGenerationRef.current = ctx.requestedDocumentGeneration + 1;
  const savedPath = outcome.path;
  const savedKind = getEditableFileKindForPath(savedPath);
  deps.activeFileVersionRef.current = outcome.version;
  deps.applyDocumentSessionState({
    ...deps.currentDocumentSessionState(),
    activeFileKind: savedKind,
    activeMimeType: savedKind === 'html' ? 'text/html' : null,
    activePath: savedPath,
    lastSavedContent: ctx.contentToSave,
  });
  await deps.cleanupConfirmedCrashDraft(ctx.contentToSave);
  if (outcome.cleanup_repair_receipt) {
    deps.setNotice('The document was saved, but background cleanup still needs attention.');
  }
  await refreshAfterSave(deps, ctx.requestedWorkspace, ctx.requestedWorkspaceGeneration);
}

function applySaveAsFailure(
  outcome: DocumentSaveFailure,
  ctx: Parameters<typeof applySaveAsOutcome>[1],
): void {
  const { deps } = ctx;
  if (outcome.status === 'conflict' && 'overwrite_token' in outcome && outcome.overwrite_token) {
    const resumeExternalAction = ctx.allowExternalRecovery ? deps.externalFileActionRef.current : null;
    if (ctx.allowExternalRecovery) deps.setExternalFileActionState(null);
    deps.setSaveConflictState({
      busy: false,
      content: ctx.contentToSave,
      documentGeneration: ctx.requestedDocumentGeneration,
      documentId: ctx.document.documentId,
      operationId: ctx.operationId,
      overwriteToken: outcome.overwrite_token as string,
      path: outcome.path,
      sourcePath: ctx.sourcePath,
      saveKind: 'save-as',
      ...(resumeExternalAction ? { resumeExternalAction } : {}),
    });
    return;
  }
  deps.setError(normalizeAppError(new Error(outcome.message), deps.localeRef.current));
  if (outcome.status === 'indeterminate') deps.lockDocumentAuthorityUnknown();
}

// 同文件保存的 apply 分支：冲突/失败阻断自动保存，确认提交后更新版本水位与最后保存内容。
export async function applySameFileOutcome(
  outcome: Awaited<ReturnType<typeof writeFile>>,
  ctx: {
    deps: SaveFlowDeps;
    contentToSave: string;
    documentId: string;
    operationId: string;
    pathToSave: string;
    requestedDocumentGeneration: number;
    requestedWorkspace: ReturnType<SaveFlowDeps['getActiveWorkspace']>;
    requestedWorkspaceGeneration: number;
  },
): Promise<void> {
  const { deps } = ctx;
  if (outcome.status === 'conflict') {
    deps.setAutosaveBlockedContent(ctx.contentToSave);
    deps.setSaveConflictState(sameFileConflict(ctx));
    return;
  }
  if (outcome.status !== 'confirmed_committed') {
    deps.setAutosaveBlockedContent(ctx.contentToSave);
    deps.setError(normalizeAppError(new Error(outcome.message), deps.localeRef.current));
    if (outcome.status === 'indeterminate') deps.lockDocumentAuthorityUnknown();
    return;
  }
  deps.activeFileVersionRef.current = outcome.version;
  deps.setAutosaveBlockedContent(null);
  deps.paneStateRef.current = {
    ...deps.paneStateRef.current,
    lastSavedContent: ctx.contentToSave,
  };
  deps.setLastSavedContent(ctx.contentToSave);
  await deps.cleanupConfirmedCrashDraft(ctx.contentToSave);
  if (outcome.cleanup_repair_receipt) {
    deps.setNotice('The document was saved, but background cleanup still needs attention.');
  }
  await refreshAfterSave(deps, ctx.requestedWorkspace, ctx.requestedWorkspaceGeneration);
}

function sameFileConflict(ctx: Parameters<typeof applySameFileOutcome>[1]): PendingDocumentSaveConflict {
  return {
    busy: false,
    content: ctx.contentToSave,
    documentGeneration: ctx.requestedDocumentGeneration,
    documentId: ctx.documentId,
    operationId: ctx.operationId,
    path: ctx.pathToSave,
    sourcePath: ctx.pathToSave,
    saveKind: 'same-file',
  };
}

async function refreshAfterSave(
  deps: SaveFlowDeps,
  requestedWorkspace: ReturnType<SaveFlowDeps['getActiveWorkspace']>,
  requestedWorkspaceGeneration: number,
): Promise<void> {
  if (!requestedWorkspace
    || !deps.isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) return;
  try {
    await deps.refreshWorkspaceDirect(requestedWorkspace, requestedWorkspaceGeneration);
  } catch (err) {
    if (deps.isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) {
      deps.setError(normalizeAppError(err, deps.localeRef.current));
    }
  }
}

