import { useCallback } from 'react';
import { usePaneResize } from './usePaneResize';
import { useWorkspaceSidebarResize } from './useWorkspaceSidebarResize';
import { usePanePopouts } from './usePanePopouts';
import { useProgramCloseGuard } from './useProgramCloseGuard';
import { useAppWorkspacePanels } from '../workspace/appWorkspacePanels';
import { useAppEditorChannel } from '../preview/useAppEditorChannel';
import { useAppExitFlows } from '../feedback/appExitFlows';
import { buildPaneSurfaceView } from '../preview/appPaneSurface';
import type { useAppShellAndIntents } from './appShellAndIntents';


// 面板与通道编排：工作区面板、窗格缩放、弹出窗、编辑器通道、退出流程与呈现面视图。
export function useAppPanesAndChannels(shell: ReturnType<typeof useAppShellAndIntents>) {
  const panes = useAppPanelWiring(shell);
  const flows = useAppChannelAndExitFlows(shell, panes);
  return panesResult(shell, panes, flows);
}

function useAppPanelWiring(shell: ReturnType<typeof useAppShellAndIntents>) {
  const {
    editorFontSize, editorPaneRatio, enqueueLocalOpenIntent, exportFlowValue, isPopout,
    locale, session, setEditorPaneRatio, setShowSettings,
    setWorkspaceSidebarWidth, settingsState, t, workspaceSidebarWidth,
    workspaceUiStates } = shell;
  const workspacePanels = useAppWorkspacePanels({
    activePath: session.activePath,
    editorFontSize,
    enqueueLocalOpenIntent,
    handleClearRecent: session.handleClearRecent,
    handleSave: session.handleSave,
    handleSaveAs: session.handleSaveAs,
    isPopout,
    locale,
    modalActive: shell.openIntentFlow.openIntentModalActive ?? false,
    onDismissSettings: () => setShowSettings(false),
    onOpenSettings: () => setShowSettings(true),
    openExportDialog: exportFlowValue.openExportDialog,
    setError: session.setError,
    setNotice: session.setNotice,
    session,
    shortcutsConfig: settingsState.settings?.shortcuts ?? {},
    translate: t,
    uiStates: workspaceUiStates,
    workspaceRollback: session.workspaceRollback,
    workspaceToken: session.workspaceToken });
  const paneResizeState = usePaneResize({ editorPaneRatio, setEditorPaneRatio });
  const sidebarResizeState = useWorkspaceSidebarResize({
    setSidebarWidth: setWorkspaceSidebarWidth,
    sidebarWidth: workspaceSidebarWidth });
  return { paneResizeState, sidebarResizeState, workspacePanels };
}

function useAppChannelAndExitFlows(
  shell: ReturnType<typeof useAppShellAndIntents>,
  panes: ReturnType<typeof useAppPanelWiring>,
) {
  const {
    
    
    
    
    isPopout, 
    session, 
 } = shell;
  const { paneResizeState } = panes;
  const { editorPaneRef, previewPaneRef } = paneResizeState;
  shell.previewPaneRefHolder.current = previewPaneRef;
  const { closePopoutWindows, editorPopoutButton, openPanePopout, previewPopoutButton } = usePanePopouts({ broadcastPaneState: session.broadcastPaneState, isPopout, setError: session.setError, setNotice: session.setNotice });
  const editorPopoutOpen = editorPopoutButton?.isPoppedOut === true;
  const editorChannel = useAppEditorChannelChannel(shell, openPanePopout, editorPopoutOpen);
  const mediaChannel = editorChannel.channel;
  const currentMediaInsertion = editorChannel.currentMediaInsertion;
  const handleEditorMediaCommandPick = editorChannel.handleEditorMediaCommandPick;
  const exitProducts = useAppExitFlowProducts(shell, closePopoutWindows, editorChannel);
  return {
    channel: mediaChannel,
    mediaChannel,
    currentMediaInsertion,
    editorChannel,
    handleEditorPopoutOpen: mediaChannel.handleEditorPopoutOpen,
    handleWorkspaceAssetInsert: editorChannel.handleWorkspaceAssetInsert,
    editorPaneRef,
    editorPopoutButton,
    exitFlows: exitProducts.exitFlows,
    handleEditorMediaCommandPick,
    openPanePopout,
    previewPaneRef,
    previewPopoutButton,
    requestWorkspaceFileOpen: exitProducts.requestWorkspaceFileOpen };
}



function useAppEditorChannelChannel(
  shell: ReturnType<typeof useAppShellAndIntents>,
  openPanePopout: (pane: 'preview') => unknown,
  editorPopoutOpen: boolean,
) {
  const {
    activeWorkspaceMarkdownFile, appearance, dispatchEditorMediaCommandPick,
    editorPopoutInstanceId, editorPasteContextRef, excalidrawAssetSync, isPopout,
    locale, mountedRef, popoutPane, session } = shell;
  void openPanePopout;
  return useAppEditorChannel({
    activeFileKind: session.activeFileKind,
    dispatchEditorMediaCommandPick,
    editorPopoutInstanceId,
    editorPopoutOpen,
    excalidrawAssetSync,
    isPopout,
    locale,
    mountedRef,
    openPanePopout: openPanePopout as never,
    pasteContextRef: editorPasteContextRef,
    popoutPane,
    documentScope: {
      activePath: session.activePath,
      activeWorkspaceMarkdownFile,
      appearance },
    session,
    translate: shell.t });
}

function useAppExitFlowProducts(
  shell: ReturnType<typeof useAppShellAndIntents>,
  closePopoutWindows: () => Promise<void>,
  editorChannel: ReturnType<typeof useAppEditorChannel>,
) {
  void editorChannel;
  const { isPopout, locale, session, setShowUnsavedExitPrompt } = shell;
  const flushSessionBeforeProgramClose = useCallback(async () => {
    await session.flushCrashDraft();
    await session.flushWorkspaceSession();
  }, [session]);
  const { forceCloseProgram } = useProgramCloseGuard({
    closePopoutWindows,
    dirty: session.dirty,
    flushWorkspaceSession: flushSessionBeforeProgramClose,
    isPopout,
    setError: session.setError,
    setNotice: session.setNotice,
    setShowUnsavedExitPrompt });
















  const exitFlows = useAppExitFlows({
    forceCloseProgram,
    locale,
    saveCurrentDocument: session.saveCurrentDocument,
    setError: session.setError,
    setNotice: session.setNotice,
    setShowUnsavedExitPrompt });
  return { exitFlows, requestWorkspaceFileOpen: useWorkspaceFileOpenRequest(shell) };
}

function useWorkspaceFileOpenRequest(shell: ReturnType<typeof useAppShellAndIntents>) {
  const { enqueueLocalOpenIntent, session } = shell;
  const requestWorkspaceFileOpen = useCallback((path: string) => {
    if (path === session.activePath) return;
    session.setError(null);
    session.setNotice(null);
    enqueueLocalOpenIntent('sidebar', path, { kind: 'workspace_file', path });
  }, [enqueueLocalOpenIntent, session]);
  return requestWorkspaceFileOpen;
}

function panesResult(
  shell: ReturnType<typeof useAppShellAndIntents>,
  panes: ReturnType<typeof useAppPanelWiring>,
  flows: ReturnType<typeof useAppChannelAndExitFlows>,
) {
  const {
    currentOutlineJump, editorFontSize, excalidrawAssetSync, feedbackDialog,
    handleClipboardImagePaste, handleEditorPasteError, locale, 
    settingsState, t, workspace, session, documentSurface } = shell;
  const { dismissFeedbackDialog } = flows.exitFlows;
  const { currentMediaInsertion, handleEditorMediaCommandPick } = flows;
  const paneSurfaceView = buildPaneSurfaceView({
    chrome: {
      dismissFeedbackDialog,
      editorFontSize,
      excalidrawAssetSync,
      feedbackDialog,
      locale,
      settingsState,
      translate: t },
    insertion: {
      currentMediaInsertion,
      handleEditorMediaCommandPick },
    outline: { currentOutlineJump },
    paste: {
      handleClipboardImagePaste,
      handleEditorPasteError },
    session,
    surface: documentSurface });

  return {
    ...shell,
    ...flows,
    documentSurface,
    paneResizeState: panes.paneResizeState,
    sidebarResizeState: panes.sidebarResizeState,
    workspacePanels: panes.workspacePanels,
    paneSurfaceView,
    handleOutlineItemSelect: workspace.outline.handleOutlineItemSelect,
    handleAuthorizeResourceDirectory: workspace.paste.handleAuthorizeResourceDirectory };
}
