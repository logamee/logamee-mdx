import type { ComponentProps } from 'react';
import type { CrashDraftStoreRepairDialog } from './CrashDraftStoreRepairDialog';
import type { ExportDialog } from '../export/ExportDialog';
import type { SettingsDialog } from '../settings/SettingsDialog';
import type { WorkspaceSearchMode, WorkspaceSearchSelection } from '../workspace/WorkspaceSearchDialog';
import type { WorkspaceEntryOperation } from '../workspace/WorkspaceEntryDialog';
import type { WorkspaceMoveOperation } from '../workspace/WorkspaceMoveDialog';
import type { WorkspaceMoveDestination } from '../../lib/fileTreeOperations';
import type { UnsavedExitPrompt } from '../../lib/closeGuard';
import type { AppUpdate } from '../../lib/appUpdater';
import type { AppSettings } from '../../types';
import type { FeedbackDialog } from '../../lib/appFeedback';
import type { ExternalFileChangeDialog } from './ExternalFileChangeDialog';
import type { DocumentSaveConflictDialog } from './DocumentSaveConflictDialog';

type CrashDraftRecoveryView = Pick<
  ComponentProps<typeof CrashDraftStoreRepairDialog>,
  'busy' | 'canRepairOverflow' | 'error' | 'overflowRepairProgress'
> & {
  repairOverflowBatch: ComponentProps<typeof CrashDraftStoreRepairDialog>['onRepairOverflow'];
  retry: () => Promise<void> | void;
};

export type AppDialogSettingsView = {
  busy: boolean;
  recovery: ComponentProps<typeof SettingsDialog>['recovery'];
  reset: () => Promise<void>;
  retry: () => Promise<void>;
  settings: AppSettings | null;
  updateSettings: (settings: AppSettings) => Promise<void>;
};

export interface AppDialogStackView {
  activeFileKind: string;
  appUpdater: {
    update: AppUpdate | null;
    installing: boolean;
    later: () => void;
    skip: () => void;
    install: () => Promise<void>;
  };
  busy: boolean;
  cancelSaveConflict: () => void;
  crashDraftRecovery: CrashDraftRecoveryView;
  discardWorkspaceIndex: () => Promise<void> | void;
  dismissFeedbackDialog: () => void;
  exportBusy: boolean;
  exportIssues: ComponentProps<typeof ExportDialog>['issues'];
  exportValue: ComponentProps<typeof ExportDialog>['value'];
  externalFileAction: ComponentProps<typeof ExternalFileChangeDialog>['action'] | null;
  feedbackDialog: FeedbackDialog | null;
  handleAuthorizeResourceDirectory: () => Promise<string | null>;
  handleCancelExit: () => void;
  handleCancelFileSwitch: () => void;
  handleCloseDeletedDraft: () => Promise<void>;
  handleFileSwitchWithoutSaving: () => void;
  handleKeepCurrentExternal: () => Promise<void>;
  handleOverwriteSaveConflict: () => Promise<void>;
  handleQuitWithoutSaving: () => void;
  handleSaveAndQuit: () => void;
  handleSaveAndSwitchFile: () => Promise<void>;
  handleSaveDeletedDraftAs: () => Promise<void>;
  handleUseExternal: () => Promise<void>;
  handleWorkspaceEntryConfirm: (name?: string) => void;
  handleWorkspaceMoveConfirm: (destinationParentPath: string) => void;
  locale: 'zh-CN' | 'en';
  rebuildWorkspaceIndex: () => Promise<void> | void;
  requestWorkspaceSearchOpen: (selection: WorkspaceSearchSelection) => void;
  runExport: () => Promise<void>;
  saveConflict: ComponentProps<typeof DocumentSaveConflictDialog>['conflict'] | null;
  setError: (message: string | null) => void;
  setExportValue: ComponentProps<typeof ExportDialog>['onChange'];
  setNotice: (message: string | null) => void;
  setShowExport: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setWorkspaceEntryOperation: (operation: WorkspaceEntryOperation | null) => void;
  setWorkspaceMoveOperation: (operation: WorkspaceMoveOperation | null) => void;
  setWorkspaceSearchMode: (mode: WorkspaceSearchMode | null) => void;
  settingsState: AppDialogSettingsView;
  showExport: boolean;
  showSettings: boolean;
  showUnsavedExitPrompt: boolean;
  unsavedExitPrompt: UnsavedExitPrompt | null;
  unsavedFileSwitchPrompt: UnsavedExitPrompt | null;
  updateAppDialog?: () => void;
  workspaceAvailable: boolean;
  workspaceEntryOperation: WorkspaceEntryOperation | null;
  workspaceIndexActionBusy: boolean;
  workspaceMoveDestinations: WorkspaceMoveDestination[];
  workspaceMoveOperation: WorkspaceMoveOperation | null;
  workspaceRoot: string | null;
  workspaceSearchMode: WorkspaceSearchMode | null;
  workspaceToken: string | null;
}
