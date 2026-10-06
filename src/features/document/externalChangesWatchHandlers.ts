/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import { } from '../../lib/documentNames';
import { } from '../../lib/documentSession';
import { type ExternalDocumentChangeDecision } from '../../lib/externalDocumentChange';
import { } from '../../lib/tauriPaneReplication';
import { } from '../../lib/tauriCommands';
import { } from '../../lib/i18n';
import { } from '../../lib/documentNames';
import { } from './sessionFacts';
import type { ExternalChangesDeps } from './externalChangesTypes';
import type { ActiveDocumentWatchSnapshotEnvelope } from '../../lib/activeDocumentWatch';
import type { AcceptedActiveDocumentWatch, ExternalFileActionState, PendingDocumentSaveConflict } from './sessionTypes';
import type { useExternalChangesWorkspace } from './externalChangesWorkspace';
import { useCallback as _useCallback } from 'react';
void _useCallback;
import {
  applyConflictDecision,
  applyDeletedDraftDecision,
  applyDocumentChangeDecision,
  applyWatchedFileDeletedDecision } from './externalChangeDecisions';

type WorkspaceProducts = ReturnType<typeof useExternalChangesWorkspace>;

// 监视守卫与决策：模态动作设置、停表、身份/序列与路径匹配谓词、外部变更四分支派发。
// 各 useCallback 依赖数组与提取前逐字一致，保证回调身份稳定（启动效果依赖入队器身份）。
type DecisionApplierContext = {

    activeFileVersionRef: import('react').RefObject<import('../../types').FileVersion | null>;
    activePathRef: import('react').RefObject<string | null>;
    advanceCrashDraftIdentity: (priorDocumentId: string) => void;
    applyDocumentSessionState: (state: import('../../lib/documentSession').DocumentSessionState) => void;
    crashDraftDocumentIdRef: import('react').RefObject<string>;
    crashDraftSchedulerRef: import('react').RefObject<import('../../lib/crashDrafts').CrashDraftScheduler | null>;
    currentDocumentSessionState: () => import('../../lib/documentSession').DocumentSessionState;
    documentGenerationRef: import('react').RefObject<number>;
    documentOpenRequestRef: import('react').RefObject<number>;
    externalFileActionRef: import('react').RefObject<ExternalFileActionState | null>;
    localeRef: import('react').RefObject<import('../../lib/locale').EffectiveLocale>;
    refreshWorkspaceAfterExternalPathChange: (previousPath: string) => Promise<void>;
    saveConflictRef: import('react').RefObject<PendingDocumentSaveConflict | null>;
    setError: (message: string | null) => void;
    setExternalFileActionState: (next: ExternalFileActionState | null) => void;
    setNotice: (message: string | null) => void;
    setSaveConflictState: (next: PendingDocumentSaveConflict | null) => void;
    stopAcceptedActiveDocumentWatch: () => Promise<void>;
};

export function useExternalChangesWatchHandlers(deps: ExternalChangesDeps, workspace: WorkspaceProducts) {
  void workspace;

    const guards = useWatchGuards(deps);
  const decision = useWatchDecision(deps, workspace, guards);
  return {
    applyExternalDocumentDecision: decision.applyExternalDocumentDecision,
    envelopeMatchesAcceptedPath: guards.envelopeMatchesAcceptedPath,
    isAcceptedWatchCurrent: guards.isAcceptedWatchCurrent,
    setExternalFileActionState: guards.setExternalFileActionState,
    stopAcceptedActiveDocumentWatch: guards.stopAcceptedActiveDocumentWatch };
}


function deletedDecisionCtx(ctx: Parameters<typeof createDecisionApplier>[0]) {
  return {
    activeFileVersionRef: ctx.activeFileVersionRef,
    activePathRef: ctx.activePathRef,
    advanceCrashDraftIdentity: ctx.advanceCrashDraftIdentity,
    applyDocumentSessionState: ctx.applyDocumentSessionState,
    crashDraftDocumentIdRef: ctx.crashDraftDocumentIdRef,
    crashDraftSchedulerRef: ctx.crashDraftSchedulerRef,
    currentDocumentSessionState: ctx.currentDocumentSessionState,
    documentGenerationRef: ctx.documentGenerationRef,
    documentOpenRequestRef: ctx.documentOpenRequestRef,
    localeRef: ctx.localeRef,
    refreshWorkspaceAfterExternalPathChange: ctx.refreshWorkspaceAfterExternalPathChange,
    setError: ctx.setError,
    setNotice: ctx.setNotice,
    stopAcceptedActiveDocumentWatch: ctx.stopAcceptedActiveDocumentWatch };
}

function watchSequenceIsNext(
  accepted: AcceptedActiveDocumentWatch,
  sequence: number | undefined,
  current: AcceptedActiveDocumentWatch | null,
  documentGeneration: number,
  pane: { documentId: string; authorityStatus?: string },
): boolean {
  if (!watchIdentityMatches(accepted, current, {
    documentGeneration,
    paneAuthority: pane.authorityStatus,
    paneDocumentId: pane.documentId,
  })) return false;
  if (sequence === undefined || !current) return true;
  return sequence > current.highestAppliedSequence
    && sequence > current.resolvedThroughSequence;
}

function watchIdentityMatches(
  accepted: AcceptedActiveDocumentWatch,
  current: AcceptedActiveDocumentWatch | null,
  session: {
    documentGeneration: number;
    paneDocumentId: string;
    paneAuthority?: string;
  },
): boolean {
  if (!current) return false;
  return watchRegistrationMatches(accepted, current)
    && session.documentGeneration === accepted.documentGeneration
    && session.paneDocumentId === accepted.documentId
    && (session.paneAuthority ?? 'unknown') === 'committed';
}

function watchRegistrationMatches(
  accepted: AcceptedActiveDocumentWatch,
  current: AcceptedActiveDocumentWatch,
): boolean {
  return current.watchId === accepted.watchId
    && current.documentId === accepted.documentId
    && current.documentGeneration === accepted.documentGeneration;
}


function useWatchGuards(deps: Parameters<typeof useExternalChangesWatchHandlers>[0]) {
  const {
    activeDocumentWatchRef, activeDocumentWatchTransport, activePathRef,
    documentGenerationRef, externalFileActionRef, paneStateRef, setExternalFileAction } = deps;
  const setExternalFileActionState = useCallback((next: ExternalFileActionState | null) => {
      externalFileActionRef.current = next;
      setExternalFileAction(next);
    }, []);

    const stopAcceptedActiveDocumentWatch = useCallback(async () => {
      const accepted = activeDocumentWatchRef.current;
      activeDocumentWatchRef.current = null;
      if (!accepted || !activeDocumentWatchTransport) return;
      await activeDocumentWatchTransport.stop(accepted.watchId).catch(() => false);
    }, [activeDocumentWatchTransport]);
    const isAcceptedWatchCurrent = useCallback((
      accepted: AcceptedActiveDocumentWatch,
      sequence?: number,
    ) => watchSequenceIsNext(
      accepted,
      sequence,
      activeDocumentWatchRef.current,
      documentGenerationRef.current,
      paneStateRef.current), []);
    const envelopeMatchesAcceptedPath = useCallback((
      accepted: AcceptedActiveDocumentWatch,
      envelope: ActiveDocumentWatchSnapshotEnvelope,
    ) => {
      const currentPath = activePathRef.current;
      if (!currentPath) return false;
      if (envelope.reason === 'renamed') {
        return envelope.previous_path === currentPath
          && envelope.snapshot.status === 'present';
      }
      const snapshotPath = envelope.snapshot.status === 'present'
        ? envelope.snapshot.file.path
        : envelope.snapshot.path;
      return snapshotPath === currentPath && accepted.path === currentPath;
    }, []);

  return {
    envelopeMatchesAcceptedPath,
    isAcceptedWatchCurrent,
    setExternalFileActionState,
    stopAcceptedActiveDocumentWatch };
}
function useWatchDecision(
  deps: Parameters<typeof useExternalChangesWatchHandlers>[0],
  workspace: WorkspaceProducts,
  guards: ReturnType<typeof useWatchGuards>,
) {
  const {
    activeFileVersionRef, activePathRef, advanceCrashDraftIdentity,
    applyDocumentSessionState, crashDraftDocumentIdRef, crashDraftSchedulerRef,
    currentDocumentSessionState, documentGenerationRef, documentOpenRequestRef,
    externalFileActionRef, localeRef, saveConflictRef, setError, setNotice,
    setSaveConflictState } = deps;
  const { refreshWorkspaceAfterExternalPathChange } = workspace;
  const { setExternalFileActionState, stopAcceptedActiveDocumentWatch } = guards;
  const applyExternalDocumentDecision = useCallback(
    createDecisionApplier(
      {
        activeFileVersionRef,
        activePathRef,
        advanceCrashDraftIdentity,
        applyDocumentSessionState,
        crashDraftDocumentIdRef,
        crashDraftSchedulerRef,
        currentDocumentSessionState,
        documentGenerationRef,
        documentOpenRequestRef,
        externalFileActionRef,
        localeRef,
        refreshWorkspaceAfterExternalPathChange,
        saveConflictRef,
        setError,
        setExternalFileActionState,
        setNotice,
        setSaveConflictState,
        stopAcceptedActiveDocumentWatch },
      deps.activeDocumentWatchRef),
    [
      applyDocumentSessionState,
      advanceCrashDraftIdentity,
      currentDocumentSessionState,
      refreshWorkspaceAfterExternalPathChange,
      setExternalFileActionState,
      setSaveConflictState,
      stopAcceptedActiveDocumentWatch,
    ]);
  return { applyExternalDocumentDecision };
}

function createDecisionApplier(
  ctx: DecisionApplierContext,
  activeDocumentWatchRef: import('react').RefObject<AcceptedActiveDocumentWatch | null>,
) {
  return async (decision: ExternalDocumentChangeDecision, sequence: number): Promise<void> => {
    const accepted = activeDocumentWatchRef.current;
    if (accepted) accepted.highestAppliedSequence = Math.max(accepted.highestAppliedSequence, sequence);
    if (decision.kind === 'ignore') return;
    const decisionRefs = {
      accepted,
      activeFileVersionRef: ctx.activeFileVersionRef,
      activePathRef: ctx.activePathRef,
      externalFileActionRef: ctx.externalFileActionRef,
      saveConflictRef: ctx.saveConflictRef };
    if (decision.kind === 'apply-document') {
      await applyDocumentChangeDecision(decision, {
        ...decisionRefs,
        applyDocumentSessionState: ctx.applyDocumentSessionState,
        refreshWorkspaceAfterExternalPathChange: ctx.refreshWorkspaceAfterExternalPathChange });
      return;
    }
    if (decision.kind === 'show-conflict') {
      applyConflictDecision(decision, {
        ...decisionRefs,
        setExternalFileActionState: ctx.setExternalFileActionState,
        setSaveConflictState: ctx.setSaveConflictState });
      return;
    }
    if (decision.kind === 'show-deleted-draft') {
      await applyDeletedDraftDecision(decision, {
        ...decisionRefs,
        setExternalFileActionState: ctx.setExternalFileActionState,
        setSaveConflictState: ctx.setSaveConflictState,
        stopAcceptedActiveDocumentWatch: ctx.stopAcceptedActiveDocumentWatch });
      return;
    }
    await applyWatchedFileDeletedDecision(decision, deletedDecisionCtx(ctx));
  };
}
