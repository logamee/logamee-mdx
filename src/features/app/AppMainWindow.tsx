import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { AppToolbar } from './AppToolbar';
import { getPaneLayoutStyle } from '../../lib/paneLayout';
import { getWorkspaceSidebarLayoutStyle } from '../../lib/sidebarLayout';
import { getWorkspaceMoveDestinations } from '../../lib/fileTreeOperations';
import { useMemo } from 'react';
import { buildPaneSurfaceView, type PaneSurfaceBuildContext } from '../preview/appPaneSurface';
import { AppDialogStackSection } from '../feedback/AppDialogStack';
import type { AppDialogStackComposites } from '../feedback/appDialogStackComposites';
import type { useAppExitFlows } from '../feedback/appExitFlows';
import type { useAppOpenIntentFlow } from '../document/appOpenIntentFlow';
import type { useAppDocumentWorkspace } from '../document/appDocumentWorkspace';
import type { useAppEditorChannel } from '../preview/useAppEditorChannel';
import type { useAppWorkspacePanels } from '../workspace/appWorkspacePanels';
import type { useWorkspaceUiStates } from '../workspace/workspaceDialogStates';
import type { useExportFlow } from '../export/useExportFlow';
import type { usePaneResize } from './usePaneResize';
import type { useWorkspaceSidebarResize } from './useWorkspaceSidebarResize';
import { WorkspaceMainAreaSection } from '../workspace/workspaceMainAreaSection';
import type { WorkspaceMainAreaComposites } from '../workspace/workspaceMainAreaSection';
import type { EditorFontSizeState } from './appMainWindowTypes';

export interface AppMainWindowProps {
  appUpdater: AppDialogStackComposites['appUpdater'];
  channel: ReturnType<typeof useAppEditorChannel>['channel'] & {
    currentMediaInsertion: ReturnType<typeof useAppEditorChannel>['currentMediaInsertion'];
    handleEditorMediaCommandPick: ReturnType<typeof useAppEditorChannel>['handleEditorMediaCommandPick'];
    handleEditorPopoutOpen: () => void;
    handleWorkspaceAssetInsert: ReturnType<typeof useAppEditorChannel>['handleWorkspaceAssetInsert'];
  };
  editorFontSize: EditorFontSizeState;
  exitFlows: ReturnType<typeof useAppExitFlows>;
  exportFlow: ReturnType<typeof useExportFlow> & AppDialogStackComposites['exportFlow'];
  openIntentFlow: ReturnType<typeof useAppOpenIntentFlow>;
  outline: {
    currentOutlineJump: PaneSurfaceBuildContext['outline']['currentOutlineJump'];
    handleOutlineItemSelect: WorkspaceMainAreaComposites['outlineSelect'];
  };
  paneResize: ReturnType<typeof usePaneResize>;
  panels: ReturnType<typeof useAppWorkspacePanels>;
  paste: {
    handleAuthorizeResourceDirectory: () => Promise<string | null>;
    handleClipboardImagePaste: PaneSurfaceBuildContext['paste']['handleClipboardImagePaste'];
    handleEditorPasteError: PaneSurfaceBuildContext['paste']['handleEditorPasteError'];
  };
  popoutButtons: {
    editorPopoutButton: WorkspaceMainAreaComposites['paneViews']['editorPopoutButton'];
    openPanePopout: () => unknown;
    previewPopoutButton: WorkspaceMainAreaComposites['paneViews']['previewPopoutButton'];
  };
  requestWorkspaceFileOpen: WorkspaceMainAreaComposites['requestWorkspaceFileOpen'];
  layout: {
    editorPaneRatio: number;
    fileTreeCollapsed: boolean;
    setFileTreeCollapsed: WorkspaceMainAreaComposites['setFileTreeCollapsed'];
    sidebarResize: ReturnType<typeof useWorkspaceSidebarResize>;
    workspaceSidebarWidth: number;
  };
  uiStates: ReturnType<typeof useWorkspaceUiStates>;
  workspace: ReturnType<typeof useAppDocumentWorkspace>;
  settingsChrome: {
    locale: PaneSurfaceBuildContext['chrome']['locale'];
    settingsState: PaneSurfaceBuildContext['chrome']['settingsState'];
    setShowSettings: (show: boolean) => void;
    showSettings: boolean;
    showUnsavedExitPrompt: boolean;
    translate: PaneSurfaceBuildContext['chrome']['translate'];
  };
}

// 主窗口渲染面：工具栏/设置入口、共享模态栈与工作区主区。
// App 完成钩子编排；三个视图对象的字段组装集中在此。
export function AppMainWindow(props: AppMainWindowProps): ReactNode {
  const { workspace, panels, uiStates, channel, outline } = props;
  const paneSurfaceView = buildPaneSurfaceView({
    chrome: {
      dismissFeedbackDialog: props.exitFlows.dismissFeedbackDialog,
      editorFontSize: props.editorFontSize,
      excalidrawAssetSync: workspace.excalidrawAssetSync,
      feedbackDialog: workspace.feedbackDialog,
      locale: props.settingsChrome.locale,
      settingsState: props.settingsChrome.settingsState,
      translate: props.settingsChrome.translate },
    insertion: {
      currentMediaInsertion: channel.currentMediaInsertion,
      handleEditorMediaCommandPick: channel.handleEditorMediaCommandPick },
    outline: { currentOutlineJump: outline.currentOutlineJump },
    paste: {
      handleClipboardImagePaste: props.paste.handleClipboardImagePaste,
      handleEditorPasteError: props.paste.handleEditorPasteError },
    session: workspace.session,
    surface: workspace.surface });
  return (
    <div className="app-shell">
      <AppToolbar
        activePath={workspace.session.activePath}
        busy={workspace.session.busy}
        canSearch={Boolean(workspace.session.workspaceRoot && workspace.session.workspaceToken) && !workspace.session.busy && uiStates.workspaceSearchMode === null}
        dirty={workspace.session.dirty}
        onQuickOpen={() => panels.search.showWorkspaceSearchDialog('quick-open')}
        onWorkspaceSearch={() => panels.search.showWorkspaceSearchDialog('workspace-search')}
        onExport={workspace.session.activeFileKind === 'markdown' || workspace.session.activeFileKind === 'excalidraw' ? props.exportFlow.openExportDialog : undefined}
      />
      <button
        type="button"
        className="settings-launch-button"
        aria-label={props.settingsChrome.locale === 'zh-CN' ? '打开设置' : 'Open settings'}
        title={props.settingsChrome.locale === 'zh-CN' ? '设置' : 'Settings'}
        disabled={props.settingsChrome.settingsState.busy || props.settingsChrome.settingsState.settings === null}
        onClick={() => props.settingsChrome.setShowSettings(true)}
      >
        <Settings size={17} />
      </button>
      <AppDialogStackSection ctx={buildDialogComposites(props)} />
      <WorkspaceMainAreaSection ctx={buildMainComposites(props, paneSurfaceView)} />
    </div>
  );
}

function buildDialogComposites(props: AppMainWindowProps): AppDialogStackComposites {
  const { workspace, openIntentFlow, uiStates } = props;
  return {
    appUpdater: props.appUpdater,
    crashDraftRecovery: workspace.crashDraftRecovery,
    dismissFeedbackDialog: props.exitFlows.dismissFeedbackDialog,
    exportFlow: props.exportFlow,
    feedbackDialog: workspace.feedbackDialog,
    handleAuthorizeResourceDirectory: props.paste.handleAuthorizeResourceDirectory,
    intentDirtyModal: openIntentFlow.dirtyModalHandlers,
    locale: props.settingsChrome.locale,
    panels: props.panels,
    session: workspace.session,
    settingsState: props.settingsChrome.settingsState,
    setShowSettings: props.settingsChrome.setShowSettings,
    showSettings: props.settingsChrome.showSettings,
    uiStates,
    unsavedExit: {
      ...props.exitFlows,
      showUnsavedExitPrompt: props.settingsChrome.showUnsavedExitPrompt,
      unsavedExitPrompt: openIntentFlow.unsavedExitPrompt,
      unsavedFileSwitchPrompt: openIntentFlow.unsavedFileSwitchPrompt },
    workspaceMoveDestinations: useMemo(() => {
      const operation = uiStates.workspaceMoveOperation;
      if (!operation || !workspace.session.workspaceRoot) return [];
      return getWorkspaceMoveDestinations({
        fileTree: workspace.session.fileTree,
        sourceKind: operation.entryKind,
        sourcePath: operation.path,
        workspaceRoot: workspace.session.workspaceRoot });
    }, [uiStates.workspaceMoveOperation, workspace.session.fileTree, workspace.session.workspaceRoot]) };
}

function buildMainComposites(
  props: AppMainWindowProps,
  paneSurfaceView: PaneSurfaceBuildContext extends never ? never : ReturnType<typeof buildPaneSurfaceView>,
): WorkspaceMainAreaComposites {
  const { workspace, layout, paneResize, panels } = props;
  const session = workspace.session;
  return {
    fileTreeCollapsed: layout.fileTreeCollapsed,
    handleWorkspaceAssetInsert: props.channel.handleWorkspaceAssetInsert,
    layout: {
      editorPaneRatio: layout.editorPaneRatio,
      paneLayoutStyle: useMemo(() => getPaneLayoutStyle(layout.editorPaneRatio), [layout.editorPaneRatio]),
      sidebarLayoutStyle: getWorkspaceSidebarLayoutStyle(layout.workspaceSidebarWidth) },
    outlineSelect: props.outline.handleOutlineItemSelect,
    paneSurface: paneSurfaceView,
    paneViews: {
      editorPaneRef: paneResize.editorPaneRef,
      editorPopoutButton: props.popoutButtons.editorPopoutButton,
      handleEditorPopoutOpen: props.channel.handleEditorPopoutOpen,
      openPreviewPopout: props.popoutButtons.openPanePopout,
      previewPaneRef: paneResize.previewPaneRef,
      previewPopoutButton: props.popoutButtons.previewPopoutButton },
    panels: { tree: panels.tree },
    paneResize,
    requestWorkspaceFileOpen: props.requestWorkspaceFileOpen,
    session: {
      activeFileKind: session.activeFileKind,
      busy: session.busy,
      externalFileActionActive: session.externalFileAction !== null,
      fileTree: session.fileTree,
      handleOpenDirectory: session.handleOpenDirectory,
      moveWorkspaceEntryPath: session.moveWorkspaceEntryPath,
      pendingOpenIntentActive: props.openIntentFlow.pendingOpenIntent !== null,
      refreshWorkspace: session.refreshWorkspace,
      renameWorkspaceEntryPath: session.renameWorkspaceEntryPath },
    setFileTreeCollapsed: layout.setFileTreeCollapsed,
    sidebarResize: layout.sidebarResize,
    sidebarWidth: layout.workspaceSidebarWidth };
}
