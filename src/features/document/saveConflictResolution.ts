/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ActiveDocumentWatchSnapshotEnvelope, ActiveDocumentWatchTransport } from '../../lib/activeDocumentWatch';
import type { CrashDraftScheduler } from '../../lib/crashDrafts';
import { createDocumentSaveOperationId, type DocumentSessionState, type WorkspaceIdentity } from '../../lib/documentSession';
import type { ExternalDocumentChangeDecision } from '../../lib/externalDocumentChange';
import { resolveKeepCurrent, resolveUseExternal } from '../../lib/externalDocumentChange';
import type { EffectiveLocale } from '../../lib/locale';
import { normalizeAppError } from '../../lib/appFeedback';
import type { PaneReplicatedState } from '../../lib/paneSync';
import type { ActiveWorkspaceIdentity, AcceptedActiveDocumentWatch, ExternalFileActionState, PendingDocumentSaveConflict } from './sessionTypes';
import { editableFileVersion } from './sessionFacts';

export interface SaveConflictResolutionDeps {
  activeDocumentWatchRef: RefObject<AcceptedActiveDocumentWatch | null>;
  activeDocumentWatchTransport: ActiveDocumentWatchTransport | null;
  activeFileVersionRef: RefObject<import('../../types').FileVersion | null>;
  activePathRef: RefObject<string | null>;
  advanceCrashDraftIdentity: (priorDocumentId: string) => void;
  applyDocumentSessionState: (next: DocumentSessionState) => void;
  applyExternalDocumentDecision: (decision: ExternalDocumentChangeDecision, sequence: number) => Promise<void>;
  cleanupConfirmedCrashDraft: (committedContent: string) => Promise<void>;
  clearActiveDocument: () => void;
  crashDraftDocumentIdRef: RefObject<string>;
  crashDraftSchedulerRef: RefObject<CrashDraftScheduler | null>;
  currentDocumentSessionState: () => DocumentSessionState;
  documentGenerationRef: RefObject<number>;
  documentOpenRequestRef: RefObject<number>;
  envelopeMatchesAcceptedPath: (
    accepted: AcceptedActiveDocumentWatch,
    envelope: ActiveDocumentWatchSnapshotEnvelope,
  ) => boolean;
  executeSessionOperation: <T>(operation: import('../../lib/documentSessionQueue').DocumentSessionQueueOperation<T>) => Promise<import('../../lib/documentSessionQueue').DocumentSessionQueueResult<T> | null>;
  externalFileActionRef: RefObject<ExternalFileActionState | null>;
  getActiveWorkspace: () => ActiveWorkspaceIdentity | null;
  isCurrentWorkspaceRequest: (requestedWorkspace: ActiveWorkspaceIdentity, requestedGeneration: number) => boolean;
  isPopout: boolean;
  localeRef: RefObject<EffectiveLocale>;
  lockDocumentAuthorityUnknown: () => void;
  paneStateRef: RefObject<PaneReplicatedState>;
  refreshWorkspaceDirect: (requestedWorkspace: ActiveWorkspaceIdentity, requestedGeneration: number) => Promise<void>;
  saveConflictRef: RefObject<PendingDocumentSaveConflict | null>;
  saveDocumentAs: (defaultName: string, allowExternalRecovery?: boolean) => Promise<boolean>;
  sessionQueue: import('../../lib/documentSessionQueue').DocumentSessionQueue;
  setError: Dispatch<SetStateAction<string | null>>;
  setExternalFileActionBusy: Dispatch<SetStateAction<boolean>>;
  setExternalFileActionState: (next: ExternalFileActionState | null) => void;
  setLastSavedContent: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void;
  stopAcceptedActiveDocumentWatch: () => Promise<void>;
  workspaceGenerationRef: RefObject<number>;
  workspaceIdentityRef: RefObject<WorkspaceIdentity>;
}

// 冲突回执是否已过期：监听会话、路径或序号任一不匹配即跳过。
function externalConflictEnvelopeStale(
  current: AcceptedActiveDocumentWatch,
  accepted: AcceptedActiveDocumentWatch,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
  deps: SaveConflictResolutionDeps,
): boolean {
  return current.watchId !== accepted.watchId
    || current.documentId !== accepted.documentId
    || current.documentGeneration !== accepted.documentGeneration
    || !deps.envelopeMatchesAcceptedPath(current, envelope)
    || envelope.sequence <= current.resolvedThroughSequence;
}

// 外部冲突回执应用：推进已解决序号，按选择保持当前或采用外部版本。
async function applyExternalConflictEnvelope(
  envelope: ActiveDocumentWatchSnapshotEnvelope,
  accepted: AcceptedActiveDocumentWatch,
  choice: 'keep-current' | 'use-external',
  deps: SaveConflictResolutionDeps,
): Promise<void> {
  const current = deps.activeDocumentWatchRef.current;
  if (!current || externalConflictEnvelopeStale(current, accepted, envelope, deps)) return;
  current.resolvedThroughSequence = Math.max(current.resolvedThroughSequence, envelope.sequence);
  current.highestAppliedSequence = Math.max(current.highestAppliedSequence, envelope.sequence);
  if (choice === 'use-external' && envelope.snapshot.status === 'present') {
    deps.activeFileVersionRef.current = editableFileVersion(envelope.snapshot.file);
  }
  deps.setExternalFileActionState(null);
  const currentDocument = deps.currentDocumentSessionState();
  const decision = choice === 'keep-current'
    ? resolveKeepCurrent(currentDocument, envelope)
    : resolveUseExternal(currentDocument, envelope);
  await deps.applyExternalDocumentDecision(decision, envelope.sequence);
  if (choice === 'keep-current' && envelope.snapshot.status === 'present') {
    deps.setSaveConflictState({
      busy: false,
      content: currentDocument.content,
      documentGeneration: accepted.documentGeneration,
      documentId: currentDocument.documentId,
      operationId: createDocumentSaveOperationId(),
      path: envelope.snapshot.file.path,
      sourcePath: envelope.snapshot.file.path,
      saveKind: 'same-file',
    });
  }
}

// 对账请求是否仍指向同一冲突会话。
function externalConflictReconcileCurrent(
  accepted: AcceptedActiveDocumentWatch,
  deps: SaveConflictResolutionDeps,
): boolean {
  const current = deps.activeDocumentWatchRef.current;
  const currentAction = deps.externalFileActionRef.current;
  return current?.watchId === accepted.watchId
    && current.documentId === accepted.documentId
    && current.documentGeneration === accepted.documentGeneration
    && currentAction?.kind === 'conflict'
    && currentAction.envelope.watch_id === accepted.watchId;
}

// 外部变更冲突处置：与监视器对账后按选择保持当前或采用外部版本。
export function useExternalConflictResolution(deps: SaveConflictResolutionDeps) {
  const {
    activeDocumentWatchRef, activeDocumentWatchTransport, externalFileActionRef,
    setExternalFileActionBusy,
  } = deps;

  const resolveExternalConflict = useCallback(async (choice: 'keep-current' | 'use-external') => {
    const action = externalFileActionRef.current;
    const accepted = activeDocumentWatchRef.current;
    if (action?.kind !== 'conflict' || !accepted || !activeDocumentWatchTransport) return;
    setExternalFileActionBusy(true);
    try {
      await deps.sessionQueue.enqueue({
        run: () => activeDocumentWatchTransport.reconcile(
          accepted.watchId,
          accepted.documentId,
          accepted.documentGeneration,
        ),
        isCurrent: () => externalConflictReconcileCurrent(accepted, deps),
        apply: async (envelope) => {
          await applyExternalConflictEnvelope(envelope, accepted, choice, deps);
        },
      });
    } catch (watchError) {
      deps.setError(normalizeAppError(watchError, deps.localeRef.current));
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [
    activeDocumentWatchTransport,
    deps.applyExternalDocumentDecision,
    deps.currentDocumentSessionState,
    deps.envelopeMatchesAcceptedPath,
    deps.sessionQueue,
    deps.setSaveConflictState,
    deps.setExternalFileActionState,
  ]);

  return { resolveExternalConflict };
}
