import { useAppShellAndIntents } from './appShellAndIntents';
import { useAppPanesAndChannels } from './appPanesAndChannels';
import { AppEditorPopoutShell, AppPreviewPopoutShell } from '../preview/AppPopoutShells';
import { AppMainWindow } from './AppMainWindow';

export function useAppBootstrap() {
  return useAppPanesAndChannels(useAppShellAndIntents());
}

export function renderAppWindow(boot: ReturnType<typeof useAppBootstrap>) {
  if (boot.popoutPane === 'editor') {
    return AppEditorPopoutShell(boot.paneSurfaceView);
  }
  if (boot.popoutPane === 'preview') {
    return AppPreviewPopoutShell(boot.paneSurfaceView);
  }
  return (
    <AppMainWindow
      appUpdater={boot.appUpdater}
      channel={{ ...boot.mediaChannel,
        currentMediaInsertion: boot.currentMediaInsertion,
        handleEditorMediaCommandPick: boot.handleEditorMediaCommandPick,
        handleEditorPopoutOpen: boot.handleEditorPopoutOpen,
        handleWorkspaceAssetInsert: boot.handleWorkspaceAssetInsert }}
      editorFontSize={boot.editorFontSize}
      exitFlows={boot.exitFlows}
      exportFlow={boot.exportFlowValue}
      layout={{
        editorPaneRatio: boot.editorPaneRatio,
        fileTreeCollapsed: boot.fileTreeCollapsed,
        setFileTreeCollapsed: boot.setFileTreeCollapsed,
        sidebarResize: boot.sidebarResizeState,
        workspaceSidebarWidth: boot.workspaceSidebarWidth }}
      openIntentFlow={boot.openIntentFlow}
      outline={{
        currentOutlineJump: boot.currentOutlineJump,
        handleOutlineItemSelect: boot.handleOutlineItemSelect }}
      paneResize={boot.paneResizeState}
      panels={boot.workspacePanels}
      paste={{
        handleAuthorizeResourceDirectory: boot.handleAuthorizeResourceDirectory,
        handleClipboardImagePaste: boot.handleClipboardImagePaste,
        handleEditorPasteError: boot.handleEditorPasteError }}
      popoutButtons={{
        editorPopoutButton: boot.editorPopoutButton,
        openPanePopout: () => boot.openPanePopout('preview'),
        previewPopoutButton: boot.previewPopoutButton }}
      requestWorkspaceFileOpen={boot.requestWorkspaceFileOpen}
      settingsChrome={{
        locale: boot.locale,
        settingsState: boot.settingsState,
        setShowSettings: boot.setShowSettings,
        showSettings: boot.showSettings,
        showUnsavedExitPrompt: boot.showUnsavedExitPrompt,
        translate: boot.t }}
      uiStates={boot.workspaceUiStates}
      workspace={boot.workspace} />
  );
}
