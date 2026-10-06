import type { RefObject } from 'react';
import { displayName, EMPTY_MARKDOWN } from '../../lib/documentNames';
import { isEditableFileKind, type DocumentSessionState } from '../../lib/documentSession';
import { coalesceExternalConflict, type ExternalDocumentChangeDecision } from '../../lib/externalDocumentChange';
import type { EffectiveLocale } from '../../lib/locale';
import { translate } from '../../lib/i18n';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import { cancelDocumentOverwriteToken } from '../../lib/tauriCommands';
import { editableFileVersion } from './sessionFacts';
import type {
  AcceptedActiveDocumentWatch,
  ExternalFileActionState,
  PendingDocumentSaveConflict } from './sessionTypes';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import type { FileVersion } from '../../types';

export interface ExternalDecisionRefs {
  accepted: AcceptedActiveDocumentWatch | null;
  activeFileVersionRef: RefObject<FileVersion | null>;
  activePathRef: RefObject<string | null>;
  externalFileActionRef: RefObject<ExternalFileActionState | null>;
  saveConflictRef: RefObject<PendingDocumentSaveConflict | null>;
}

// 应用文档态分支：落盘状态、按需更新可编辑文件版本水位、路径变更后刷新工作区。
export async function applyDocumentChangeDecision(
  decision: Extract<ExternalDocumentChangeDecision, { kind: 'apply-document' }>,
  ctx: ExternalDecisionRefs & {
    applyDocumentSessionState: (state: DocumentSessionState) => void;
    refreshWorkspaceAfterExternalPathChange: (previousPath: string) => Promise<void>;
  },
): Promise<void> {
  const previousPath = ctx.activePathRef.current;
  const appliedAction = ctx.externalFileActionRef.current;
  if (ctx.accepted && decision.state.activePath) ctx.accepted.path = decision.state.activePath;
  ctx.applyDocumentSessionState(decision.state);
  const sourceEnvelope = appliedAction?.envelope;
  if (sourceEnvelope?.snapshot.status === 'present'
    && isEditableFileKind(sourceEnvelope.snapshot.file.kind)) {
    ctx.activeFileVersionRef.current = editableFileVersion(sourceEnvelope.snapshot.file);
  }
  if (previousPath && decision.state.activePath !== previousPath) {
    await ctx.refreshWorkspaceAfterExternalPathChange(previousPath);
  }
}

function cancelPendingOverwrite(
  ctx: ExternalDecisionRefs,
  setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void,
): void {
  const pendingSave = ctx.saveConflictRef.current;
  setSaveConflictState(null);
  if (pendingSave?.overwriteToken) {
    void cancelDocumentOverwriteToken(pendingSave.path, pendingSave.overwriteToken).catch(() => undefined);
  }
}

// 冲突分支：取消待决覆写令牌，合并信封后进入 conflict 模态。
export function applyConflictDecision(
  decision: Extract<ExternalDocumentChangeDecision, { kind: 'show-conflict' }>,
  ctx: ExternalDecisionRefs & {
    setExternalFileActionState: (next: ExternalFileActionState | null) => void;
    setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void;
  },
): void {
  cancelPendingOverwrite(ctx, ctx.setSaveConflictState);
  const currentAction = ctx.externalFileActionRef.current;
  const envelope = currentAction?.kind === 'conflict'
    ? coalesceExternalConflict(currentAction.envelope, decision.envelope)
    : decision.envelope;
  ctx.setExternalFileActionState({ kind: 'conflict', envelope });
}

// 已删草稿分支：停止监视并进入 deleted-draft 模态。
export async function applyDeletedDraftDecision(
  decision: Extract<ExternalDocumentChangeDecision, { kind: 'show-deleted-draft' }>,
  ctx: ExternalDecisionRefs & {
    setExternalFileActionState: (next: ExternalFileActionState | null) => void;
    setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void;
    stopAcceptedActiveDocumentWatch: () => Promise<void>;
  },
): Promise<void> {
  cancelPendingOverwrite(ctx, ctx.setSaveConflictState);
  await ctx.stopAcceptedActiveDocumentWatch();
  ctx.setExternalFileActionState({ kind: 'deleted-draft', envelope: decision.envelope });
}

// 文档被删分支：冲崩溃草稿、停监视、换代并清空为空文档。
export async function applyWatchedFileDeletedDecision(
  decision: Extract<ExternalDocumentChangeDecision, { kind: 'close-with-notice' }>,
  ctx: {
    activeFileVersionRef: RefObject<FileVersion | null>;
    activePathRef: RefObject<string | null>;
    advanceCrashDraftIdentity: (priorDocumentId: string) => void;
    applyDocumentSessionState: (state: DocumentSessionState) => void;
    crashDraftDocumentIdRef: RefObject<string>;
    crashDraftSchedulerRef: RefObject<CrashDraftScheduler | null>;
    currentDocumentSessionState: () => DocumentSessionState;
    documentGenerationRef: RefObject<number>;
    documentOpenRequestRef: RefObject<number>;
    localeRef: RefObject<EffectiveLocale>;
    refreshWorkspaceAfterExternalPathChange: (previousPath: string) => Promise<void>;
    setError: (message: string | null) => void;
    setNotice: (message: string | null) => void;
    stopAcceptedActiveDocumentWatch: () => Promise<void>;
  },
): Promise<void> {
  const previousPath = ctx.activePathRef.current;
  const priorCrashDocumentId = ctx.crashDraftDocumentIdRef.current;
  try {
    await ctx.crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
  } catch {
    ctx.setError('The recovery draft could not be saved. The current document remains open.');
    return;
  }
  await ctx.stopAcceptedActiveDocumentWatch();
  ctx.documentOpenRequestRef.current += 1;
  ctx.documentGenerationRef.current += 1;
  const current = ctx.currentDocumentSessionState();
  ctx.applyDocumentSessionState({
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
  ctx.activeFileVersionRef.current = null;
  ctx.advanceCrashDraftIdentity(priorCrashDocumentId);
  ctx.setNotice(translate(ctx.localeRef.current, 'watchedFileDeleted', { name: displayName(decision.path) }));
  if (previousPath) await ctx.refreshWorkspaceAfterExternalPathChange(previousPath);
}
