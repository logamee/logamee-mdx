import type { AppDialogStackView } from './appDialogStackTypes';


export interface AppDialogStackComposites {
  appUpdater: AppDialogStackView['appUpdater'];
  crashDraftRecovery: AppDialogStackView['crashDraftRecovery'];
  dismissFeedbackDialog: () => void;
  exportFlow: {
    exportBusy: AppDialogStackView['exportBusy'];
    exportIssues: AppDialogStackView['exportIssues'];
    exportValue: AppDialogStackView['exportValue'];
    openExportDialog: () => void;
    runExport: () => Promise<void>;
    setExportValue: AppDialogStackView['setExportValue'];
    setShowExport: (show: boolean) => void;
    showExport: boolean;
  };
  feedbackDialog: AppDialogStackView['feedbackDialog'];
  intentDirtyModal: {
    handleCancelFileSwitch: () => void;
    handleFileSwitchWithoutSaving: () => void;
    handleSaveAndSwitchFile: () => Promise<void>;
  };
  locale: AppDialogStackView['locale'];
  panels: {
    search: {
      discardCurrentWorkspaceIndex: () => void;
      rebuildCurrentWorkspaceIndex: () => void;
      requestWorkspaceSearchOpen: AppDialogStackView['requestWorkspaceSearchOpen'];
      setWorkspaceSearchMode: AppDialogStackView['setWorkspaceSearchMode'];
      workspaceIndexActionBusy: boolean;
    };
    tree: {
      handleWorkspaceEntryConfirm: (name?: string) => void;
      handleWorkspaceMoveConfirm: (destinationParentPath: string) => void;
      setWorkspaceEntryOperation: AppDialogStackView['setWorkspaceEntryOperation'];
      setWorkspaceMoveOperation: AppDialogStackView['setWorkspaceMoveOperation'];
    };
  };
  session: {
    activeFileKind: string;
    busy: boolean;
    externalFileAction: AppDialogStackView['externalFileAction'];
    handleCancelSaveConflict: () => void;
    handleCloseDeletedDraft: () => Promise<void>;
    handleKeepCurrentExternal: () => Promise<void>;
    handleOverwriteSaveConflict: () => Promise<void>;
    handleSaveDeletedDraftAs: () => Promise<void>;
    handleUseExternal: () => Promise<void>;
    saveConflict: AppDialogStackView['saveConflict'];
    setError: (message: string | null) => void;
    setNotice: (message: string | null) => void;
    workspaceRoot: string | null;
    workspaceToken: string | null;
  };
  settingsState: AppDialogStackView['settingsState'];
  setShowSettings: (show: boolean) => void;
  uiStates: {
    setWorkspaceSearchMode: AppDialogStackView['setWorkspaceSearchMode'];
    workspaceEntryOperation: AppDialogStackView['workspaceEntryOperation'];
    workspaceIndexActionBusy: boolean;
    workspaceMoveOperation: AppDialogStackView['workspaceMoveOperation'];
    workspaceSearchMode: AppDialogStackView['workspaceSearchMode'];
  };
  unsavedExit: {
    handleCancelExit: () => void;
    handleQuitWithoutSaving: () => void;
    handleSaveAndQuit: () => void;
    showUnsavedExitPrompt: boolean;
    unsavedExitPrompt: AppDialogStackView['unsavedExitPrompt'];
    unsavedFileSwitchPrompt: AppDialogStackView['unsavedFileSwitchPrompt'];
  };
  workspaceMoveDestinations: AppDialogStackView['workspaceMoveDestinations'];
  handleAuthorizeResourceDirectory: () => Promise<string | null>;
  showSettings: boolean;
}


export function sessionDialogFields(ctx: AppDialogStackComposites) {
  const { session } = ctx;
  return {
    activeFileKind: session.activeFileKind,
    appUpdater: ctx.appUpdater,
    busy: session.busy,
    cancelSaveConflict: session.handleCancelSaveConflict,
    crashDraftRecovery: ctx.crashDraftRecovery,
    dismissFeedbackDialog: ctx.dismissFeedbackDialog,
    exportBusy: ctx.exportFlow.exportBusy,
    exportIssues: ctx.exportFlow.exportIssues,
    exportValue: ctx.exportFlow.exportValue,
    externalFileAction: session.externalFileAction,
    feedbackDialog: ctx.feedbackDialog,
    handleAuthorizeResourceDirectory: ctx.handleAuthorizeResourceDirectory,
    handleCloseDeletedDraft: session.handleCloseDeletedDraft,
    handleKeepCurrentExternal: session.handleKeepCurrentExternal,
    handleOverwriteSaveConflict: session.handleOverwriteSaveConflict,
    handleSaveDeletedDraftAs: session.handleSaveDeletedDraftAs,
    handleUseExternal: session.handleUseExternal,
    locale: ctx.locale,
    runExport: ctx.exportFlow.runExport,
    saveConflict: session.saveConflict,
    setError: session.setError,
    setNotice: session.setNotice,
    settingsState: ctx.settingsState,
    setShowSettings: ctx.setShowSettings,
    showSettings: ctx.showSettings,
    workspaceAvailable: Boolean(session.workspaceRoot && session.workspaceToken),
    workspaceMoveDestinations: ctx.workspaceMoveDestinations,
    workspaceRoot: session.workspaceRoot,
    workspaceToken: session.workspaceToken };
}

export function intentDialogFields(
  intentDirtyModal: AppDialogStackComposites['intentDirtyModal'],
  unsavedExit: AppDialogStackComposites['unsavedExit'],
) {
  return {
    handleCancelExit: unsavedExit.handleCancelExit,
    handleCancelFileSwitch: intentDirtyModal.handleCancelFileSwitch,
    handleFileSwitchWithoutSaving: intentDirtyModal.handleFileSwitchWithoutSaving,
    handleQuitWithoutSaving: unsavedExit.handleQuitWithoutSaving,
    handleSaveAndQuit: unsavedExit.handleSaveAndQuit,
    handleSaveAndSwitchFile: intentDirtyModal.handleSaveAndSwitchFile,
    showUnsavedExitPrompt: unsavedExit.showUnsavedExitPrompt,
    unsavedExitPrompt: unsavedExit.unsavedExitPrompt,
    unsavedFileSwitchPrompt: unsavedExit.unsavedFileSwitchPrompt };
}

export function panelDialogFields(
  panels: AppDialogStackComposites['panels'],
  uiStates: AppDialogStackComposites['uiStates'],
  exportFlow: AppDialogStackComposites['exportFlow'],
) {
  const { search, tree } = panels;
  return {
    discardWorkspaceIndex: search.discardCurrentWorkspaceIndex,
    handleWorkspaceEntryConfirm: tree.handleWorkspaceEntryConfirm,
    handleWorkspaceMoveConfirm: tree.handleWorkspaceMoveConfirm,
    rebuildWorkspaceIndex: search.rebuildCurrentWorkspaceIndex,
    requestWorkspaceSearchOpen: search.requestWorkspaceSearchOpen,
    setExportValue: exportFlow.setExportValue,
    setShowExport: exportFlow.setShowExport,
    setWorkspaceEntryOperation: tree.setWorkspaceEntryOperation,
    setWorkspaceMoveOperation: tree.setWorkspaceMoveOperation,
    setWorkspaceSearchMode: search.setWorkspaceSearchMode,
    showExport: exportFlow.showExport,
    workspaceEntryOperation: uiStates.workspaceEntryOperation,
    workspaceIndexActionBusy: search.workspaceIndexActionBusy,
    workspaceMoveOperation: uiStates.workspaceMoveOperation,
    workspaceSearchMode: uiStates.workspaceSearchMode };
}
