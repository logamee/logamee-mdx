import { useOpenIntentQueue } from './appOpenIntentQueue';
import { useOpenIntentExecution, type OpenIntentProcessingSession } from './appOpenIntentProcessing';
import { useOpenIntentPeek, useOpenIntentModalSync } from './appOpenIntentPeek';
import {
  packagedUnicodeRenameIsPending,
  useOpenIntentDirtyModalHandlers,
  usePackagedIntentDecisions } from './packagedIntentDecisions';
import { usePackagedOpenEvidence } from './packagedOpenEvidence';
import type { AppOpenIntent } from '../../lib/openIntent';
import { getUnsavedExitPrompt, getUnsavedFileSwitchPrompt } from '../../lib/closeGuard';
import type { EffectiveLocale } from '../../lib/locale';
import type { PackagedEvidenceSession } from './packagedOpenSteps';

// 打开意图的模态互斥输入：任一为真时新意图不激活、peek 暂停。
export interface OpenIntentModalInputs {
  appUpdate: unknown;
  busy: boolean;
  crashDraftRecoveryError: unknown;
  externalFileAction: unknown;
  feedbackDialog: unknown;
  saveConflict: unknown;
  settingsBusy: boolean;
  settingsRecovery: unknown;
  showExport: boolean;
  showSettings: boolean;
  showUnsavedExitPrompt: boolean;
  unsavedFileSwitchPromptActive?: boolean;
  workspaceEntryOperation: unknown;
  workspaceIndexActionBusy: boolean;
  workspaceMoveOperation: unknown;
  workspaceSearchMode: unknown;
}

export type OpenIntentFlowSession = Omit<OpenIntentProcessingSession, 'settleSessionRestore'>
  & Pick<PackagedEvidenceSession, 'activePath' | 'authorityStatus' | 'dirty' | 'updateContent' | 'workspaceRoot' | 'workspaceToken'>
  & { settleWorkspaceSessionRestore: () => void };

// 打开意图全流程：队列 → 打包证据/结算屏障 → 模态互斥 → peek/自动处理 → 脏决策。
// 结算经 ref 下沉，避免与打包证据钩子形成循环依赖。
export function useAppOpenIntentFlow(deps: {
  currentContentRef: React.RefObject<string>;
  evidenceEnabled: boolean;
  isPopout: boolean;
  locale: EffectiveLocale;
  modalInputs: OpenIntentModalInputs;
  mountedRef: React.RefObject<boolean>;
  session: OpenIntentFlowSession;
}) {
  const { currentContentRef, session } = deps;
  const queue = useOpenIntentQueue({
    evidenceEnabled: deps.evidenceEnabled,
    isPopout: deps.isPopout,
    locale: deps.locale,
    mountedRef: deps.mountedRef,
    session: {
      settleSessionRestore: session.settleWorkspaceSessionRestore,
      setError: session.setError,
      setNotice: session.setNotice } });
  const {



    pendingOpenIntent } = queue;
  void currentContentRef;

  const unsavedFileSwitchPrompt = pendingFileSwitchPrompt(
    deps.session.dirty, pendingOpenIntent, deps.session.activePath, deps.locale);
  const packaged = useOpenIntentPackagedBridge(deps, queue, pendingOpenIntent, unsavedFileSwitchPrompt !== null);
  queue.packagedSettlementSinkRef.current = (settlement) => {
    packaged.setPendingPackagedSettlement({
      intent: settlement.intent,
      status: settlement.status });
  };
  const openIntentModalActive = useOpenIntentGating(deps, queue, packaged, unsavedFileSwitchPrompt !== null);
  const dirtyModal = useOpenIntentDecisionFlow(
    deps, queue, packaged, openIntentModalActive, unsavedFileSwitchPrompt !== null);
  return {
    dirtyModalHandlers: dirtyModal,
    enqueueLocalOpenIntent: queue.enqueueLocalOpenIntent,
    openIntentModalActive,
    pendingOpenIntent,
    unsavedExitPrompt: getUnsavedExitPrompt(deps.session.activePath, deps.locale),
    unsavedFileSwitchPrompt: pendingFileSwitchPrompt(
      deps.session.dirty, pendingOpenIntent, deps.session.activePath, deps.locale) };
}

function pendingFileSwitchPrompt(
  dirty: boolean,
  pendingOpenIntent: AppOpenIntent | null,
  activePath: string | null,
  locale: EffectiveLocale,
) {
  const target = dirty && pendingOpenIntent ? pendingOpenIntent.displayPath : null;
  return target ? getUnsavedFileSwitchPrompt(activePath, target, locale) : null;
}

function useOpenIntentPackagedBridge(
  deps: Parameters<typeof useAppOpenIntentFlow>[0],
  queue: ReturnType<typeof useOpenIntentQueue>,
  pendingOpenIntent: AppOpenIntent | null,
  unsavedFileSwitchPromptActive: boolean,
) {
  return usePackagedOpenEvidence({
    currentContentRef: deps.currentContentRef,
    evidenceEnabled: deps.evidenceEnabled,
    isPopout: deps.isPopout,
    locale: deps.locale,
    onSettlementReleased: queue.bumpPollRevision,
    pendingOpenIntent,
    session: {
      activePath: deps.session.activePath,
      authorityStatus: deps.session.authorityStatus,
      dirty: deps.session.dirty,
      setError: deps.session.setError,
      setNotice: deps.session.setNotice,
      updateContent: deps.session.updateContent,
      workspaceRoot: deps.session.workspaceRoot,
      workspaceToken: deps.session.workspaceToken },
    unsavedFileSwitchPromptActive });
}

function useOpenIntentGating(
  deps: Parameters<typeof useAppOpenIntentFlow>[0],
  queue: ReturnType<typeof useOpenIntentQueue>,
  packaged: ReturnType<typeof usePackagedOpenEvidence>,
  unsavedFileSwitchPromptActive: boolean,
): boolean {
  const modalActive = useOpenIntentModalActive(
    packaged.packagedSettlementBarrierActive,
    { ...deps.modalInputs, unsavedFileSwitchPromptActive });
  useOpenIntentModalSync({
    barrierRef: packaged.packagedSettlementBarrierRef,
    coordinator: queue.openIntentCoordinator,
    modalActive });
  useOpenIntentPeek({
    coordinator: queue.openIntentCoordinator,
    evidenceEnabled: deps.evidenceEnabled,
    isPopout: deps.isPopout,
    locale: deps.locale,
    modalActive,
    openConfig: packaged.packagedOpenConfig,
    pollRevision: queue.openIntentPollRevision,
    setError: deps.session.setError,
    setNotice: deps.session.setNotice });
  return modalActive;
}

function useOpenIntentDecisionFlow(
  deps: Parameters<typeof useAppOpenIntentFlow>[0],
  queue: ReturnType<typeof useOpenIntentQueue>,
  packaged: ReturnType<typeof usePackagedOpenEvidence>,
  openIntentModalActive: boolean,
  unsavedFileSwitchPromptActive: boolean,
) {
  const { session } = deps;
  const { activeOpenIntentIdRef, openIntentSettlementRef, pendingOpenIntent } = queue;
  const execution = useOpenIntentExecution({
    activeOpenIntentIdRef,
    coordinator: queue.openIntentCoordinator,
    dirty: session.dirty,
    isPopout: deps.isPopout,
    locale: deps.locale,
    openIntentModalActive,
    openIntentSettlementRef,
    packaged: {
      evidenceEnabled: deps.evidenceEnabled,
      evidenceTailRef: packaged.packagedEvidenceTailRef,
      openConfig: packaged.packagedOpenConfig,
      recordEvidence: packaged.recordPackagedEvidence,
      reportEvidenceFailure: packaged.reportPackagedEvidenceFailure,
      setOpenConfig: packaged.setPackagedOpenConfig,
      setSettlementBarrierActive: packaged.setPackagedSettlementBarrierActive },
    pendingOpenIntent,
    session: { ...session, settleSessionRestore: session.settleWorkspaceSessionRestore },
    unicodeRenamePending: packagedUnicodeRenameIsPending(pendingOpenIntent, packaged.packagedOpenConfig) });
  const dirtyModal = useOpenIntentDirtyModalHandlers({
    activeOpenIntentIdRef,
    cancelOpenIntent: execution.cancelOpenIntent,
    pendingOpenIntent,
    processOpenIntent: execution.processOpenIntent,
    recordEvidence: packaged.recordPackagedEvidence,
    reportEvidenceFailure: packaged.reportPackagedEvidenceFailure });
  usePackagedIntentDecisions({
    dirty: session.dirty,
    onCancelFileSwitch: dirtyModal.handleCancelFileSwitch,
    onFileSwitchWithoutSaving: dirtyModal.handleFileSwitchWithoutSaving,
    openConfig: packaged.packagedOpenConfig,
    pendingOpenIntent,
    setOpenConfig: packaged.setPackagedOpenConfig,
    unsavedFileSwitchPromptActive });
  return dirtyModal;
}

function useOpenIntentModalActive(barrierActive: boolean, inputs: OpenIntentModalInputs): boolean {
  // Open intents must wait behind every app-owned modal and in-flight session operation.
  // This keeps a late OS launch from replacing the target of an existing decision dialog.
  return barrierActive || [
    inputs.busy,
    inputs.settingsBusy,
    inputs.settingsRecovery,
    inputs.crashDraftRecoveryError,
    inputs.externalFileAction,
    inputs.saveConflict,
    inputs.showUnsavedExitPrompt,
    inputs.unsavedFileSwitchPromptActive,
    inputs.workspaceSearchMode,
    inputs.workspaceEntryOperation,
    inputs.workspaceMoveOperation,
    inputs.showExport,
    inputs.showSettings,
    inputs.workspaceIndexActionBusy,
    inputs.appUpdate,
    inputs.feedbackDialog].some(Boolean);
}
