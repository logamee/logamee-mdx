import { AnimatePresence, m, useIsPresent, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { CrashDraftStoreRepairDialog } from './CrashDraftStoreRepairDialog';
import { DocumentSaveConflictDialog } from './DocumentSaveConflictDialog';
import { ExportDialog } from '../export/ExportDialog';
import { ExternalFileChangeDialog } from './ExternalFileChangeDialog';
import { FeedbackDialog } from './FeedbackDialog';
import { QuickOpenDialog } from '../workspace/QuickOpenDialog';
import { SettingsDialog } from '../settings/SettingsDialog';
import { UnsavedExitDialog } from './UnsavedExitDialog';
import { UpdateAvailableDialog } from './UpdateAvailableDialog';
import { WorkspaceEntryDialog } from '../workspace/WorkspaceEntryDialog';
import { WorkspaceMoveDialog } from '../workspace/WorkspaceMoveDialog';
import { WorkspaceSearchDialog } from '../workspace/WorkspaceSearchDialog';
import { normalizeAppError } from '../../lib/appFeedback';
import { OVERLAY_MOTION } from '../../lib/motionPresets';
import type { AppDialogStackView } from './appDialogStackTypes';
import type { AppDialogStackComposites } from './appDialogStackComposites';
import {
  sessionDialogFields,
  intentDialogFields,
  panelDialogFields } from './appDialogStackComposites';

// 共享模态反馈模型的应用弹窗栈：任意时刻至多一个模态（含反馈通知），
// 由 openIntentModalActive 与各流程互斥驱动。
type DialogView = AppDialogStackView;

type DialogBranch = [key: string, active: boolean, render: () => ReactNode];

function dialogBranches(view: DialogView): DialogBranch[] {
  return [
    ['export', view.showExport, () => exportDialog(view)],
    ['search', Boolean(view.workspaceSearchMode && view.workspaceRoot && view.workspaceToken), () => searchDialog(view)],
    ['repair', Boolean(view.crashDraftRecovery.error), () => repairDialog(view)],
    ['recovery', Boolean(view.settingsState.recovery), () => recoveryDialog(view)],
    ['external-change', Boolean(view.externalFileAction), () => externalChangeDialog(view)],
    ['save-conflict', Boolean(view.saveConflict), () => saveConflictDialog(view)],
    ['unsaved-exit', view.showUnsavedExitPrompt, () => unsavedExitDialog(view)],
    ['unsaved-switch', Boolean(view.unsavedFileSwitchPrompt), () => unsavedSwitchDialog(view)],
    ['entry', Boolean(view.workspaceEntryOperation), () => entryDialog(view)],
    ['move', Boolean(view.workspaceMoveOperation), () => moveDialog(view)],
    ['settings', Boolean(view.showSettings && view.settingsState.settings), () => settingsDialog(view)],
    ['update', Boolean(view.appUpdater.update), () => updateDialog(view)],
    ['feedback', Boolean(view.feedbackDialog), () => (
      <FeedbackDialog dialog={view.feedbackDialog as never} onDismiss={view.dismissFeedbackDialog} />
    )] ];
}

function isBranchActive(branch: DialogBranch): boolean {
  return branch[1];
}

export function isDialogStackActive(view: AppDialogStackView): boolean {
  return dialogBranches(view).some(isBranchActive);
}

function DialogMotionLayer({ children }: { children: ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <m.div className="app-dialog-motion-layer" inert={!isPresent} {...OVERLAY_MOTION}>
      {children}
    </m.div>
  );
}

export function AppDialogStackSection({ view }: { view: DialogView }): ReactNode {
  const activeBranch = dialogBranches(view).find(isBranchActive);
  const reduceMotion = useReducedMotion();
  if (reduceMotion || typeof Element === 'undefined' || !Element.prototype.animate) {
    return activeBranch ? activeBranch[2]() : null;
  }
  return (
    <AnimatePresence mode="wait">
      {activeBranch && <DialogMotionLayer key={activeBranch[0]}>{activeBranch[2]()}</DialogMotionLayer>}
    </AnimatePresence>
  );
}

function exportDialog(view: DialogView): ReactNode {
  return (
    <ExportDialog
      busy={view.exportBusy}
      canExportExcalidraw={view.activeFileKind === 'excalidraw'}
      issues={view.exportIssues as never}
      locale={view.locale}
      value={view.exportValue as never}
      onCancel={() => view.setShowExport(false)}
      onChange={view.setExportValue as never}
      onExport={() => void view.runExport()}
    />
  );
}

function searchDialog(view: DialogView): ReactNode {
  const close = () => view.setWorkspaceSearchMode(null);
  const onError = (error: unknown) => {
    view.setWorkspaceSearchMode(null);
    view.setError(normalizeAppError(error, view.locale));
    view.setNotice(null);
  };
  return view.workspaceSearchMode === 'quick-open'
    ? (
      <QuickOpenDialog
        workspaceRoot={view.workspaceRoot as string}
        workspaceToken={view.workspaceToken as string}
        onCancel={close}
        onError={onError}
        onSelect={view.requestWorkspaceSearchOpen as never}
      />
    )
    : (
      <WorkspaceSearchDialog
        mode="workspace-search"
        workspaceRoot={view.workspaceRoot as string}
        workspaceToken={view.workspaceToken as string}
        onCancel={close}
        onError={onError}
        onSelect={view.requestWorkspaceSearchOpen as never}
      />
    );
}

function repairDialog(view: DialogView): ReactNode {
  return (
    <CrashDraftStoreRepairDialog
      busy={view.crashDraftRecovery.busy}
      canRepairOverflow={view.crashDraftRecovery.canRepairOverflow}
      error={view.crashDraftRecovery.error as never}
      locale={view.locale}
      overflowRepairProgress={view.crashDraftRecovery.overflowRepairProgress}
      onRepairOverflow={view.crashDraftRecovery.repairOverflowBatch}
      onRetry={() => void view.crashDraftRecovery.retry()}
    />
  );
}

function recoveryDialog(view: DialogView): ReactNode {
  return (
    <SettingsDialog
      busy={view.settingsState.busy}
      locale={view.locale}
      recovery={view.settingsState.recovery as never}
      onReset={view.settingsState.reset}
      onRetry={() => Promise.resolve(view.settingsState.retry())}
    />
  );
}

function externalChangeDialog(view: DialogView): ReactNode {
  return (
    <ExternalFileChangeDialog
      action={view.externalFileAction as never}
      onCloseDeletedDraft={() => void view.handleCloseDeletedDraft()}
      onKeepCurrent={() => void view.handleKeepCurrentExternal()}
      onSaveDeletedDraftAs={() => void view.handleSaveDeletedDraftAs()}
      onUseExternal={() => void view.handleUseExternal()}
    />
  );
}

function saveConflictDialog(view: DialogView): ReactNode {
  return (
    <DocumentSaveConflictDialog
      conflict={view.saveConflict as never}
      onCancel={view.cancelSaveConflict}
      onOverwrite={() => void view.handleOverwriteSaveConflict()}
    />
  );
}

function unsavedExitDialog(view: DialogView): ReactNode {
  return (
    <UnsavedExitDialog
      busy={view.busy}
      prompt={view.unsavedExitPrompt as never}
      onCancelExit={view.handleCancelExit}
      onQuitWithoutSaving={view.handleQuitWithoutSaving}
      onSaveAndQuit={view.handleSaveAndQuit}
    />
  );
}

function unsavedSwitchDialog(view: DialogView): ReactNode {
  return (
    <UnsavedExitDialog
      busy={view.busy}
      prompt={view.unsavedFileSwitchPrompt as never}
      onCancelExit={view.handleCancelFileSwitch}
      onQuitWithoutSaving={view.handleFileSwitchWithoutSaving}
      onSaveAndQuit={() => void view.handleSaveAndSwitchFile()}
    />
  );
}

function entryDialog(view: DialogView): ReactNode {
  return (
    <WorkspaceEntryDialog
      busy={view.busy}
      operation={view.workspaceEntryOperation as never}
      onCancel={() => view.setWorkspaceEntryOperation(null)}
      onConfirm={view.handleWorkspaceEntryConfirm}
    />
  );
}

function moveDialog(view: DialogView): ReactNode {
  return (
    <WorkspaceMoveDialog
      busy={view.busy}
      destinations={view.workspaceMoveDestinations as never}
      operation={view.workspaceMoveOperation as never}
      onCancel={() => view.setWorkspaceMoveOperation(null)}
      onConfirm={view.handleWorkspaceMoveConfirm}
    />
  );
}

function settingsDialog(view: DialogView): ReactNode {
  return (
    <SettingsDialog
      busy={view.settingsState.busy || view.workspaceIndexActionBusy}
      locale={view.locale}
      settings={view.settingsState.settings as never}
      workspaceAvailable={view.workspaceAvailable}
      onAuthorizeResourceDirectory={view.handleAuthorizeResourceDirectory}
      onClose={() => view.setShowSettings(false)}
      onDiscardWorkspaceIndex={() => Promise.resolve(view.discardWorkspaceIndex())}
      onRebuildWorkspaceIndex={() => Promise.resolve(view.rebuildWorkspaceIndex())}
      onReset={async () => {
        await view.settingsState.reset();
        view.setShowSettings(false);
      }}
      onSave={async (nextSettings) => {
        await view.settingsState.updateSettings(nextSettings as never);
        view.setShowSettings(false);
      }}
    />
  );
}

function updateDialog(view: DialogView): ReactNode {
  const update = view.appUpdater.update as { version: string; currentVersion: string; body: string };
  return (
    <UpdateAvailableDialog
      locale={view.locale}
      version={update.version}
      currentVersion={update.currentVersion}
      body={update.body}
      busy={view.appUpdater.installing}
      onLater={view.appUpdater.later}
      onSkip={view.appUpdater.skip}
      onUpdate={async () => {
        try {
          await view.appUpdater.install();
        } catch (updateError) {
          view.setError(normalizeAppError(updateError, view.locale));
          view.setNotice(null);
          view.appUpdater.later();
        }
      }}
    />
  );
}

export function buildDialogStackView(ctx: AppDialogStackComposites): AppDialogStackView {
  const { uiStates, panels, unsavedExit, intentDirtyModal, exportFlow } = ctx;
  return {
    ...sessionDialogFields(ctx),
    ...intentDialogFields(intentDirtyModal, unsavedExit),
    ...panelDialogFields(panels, uiStates, exportFlow) };
}
