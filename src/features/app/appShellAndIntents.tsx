import { useMemo, useRef, useState } from 'react';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import { useI18n } from '../../lib/i18n';
import { useObservedEffectiveTheme } from '../../lib/themeObservation';
import { isTauriRuntime } from '../../lib/activeDocumentWatch';
import { getPaneLayoutStyle } from '../../lib/paneLayout';
import { parsePopoutInstanceId, parsePopoutPane } from '../../lib/paneLayout';
import { DEFAULT_WORKSPACE_SIDEBAR_WIDTH } from '../../lib/sidebarLayout';
import { useAppUpdater } from './useAppUpdater';
import { useSettings } from '../settings/useSettings';
import { useEditorFontSize } from '../settings/useEditorFontSize';
import { useExportFlow } from '../export/useExportFlow';
import { useWorkspaceUiStates } from '../workspace/workspaceDialogStates';
import { useAppDocumentWorkspace } from '../document/appDocumentWorkspace';
import { useAppOpenIntentFlow } from '../document/appOpenIntentFlow';
import type { MarkdownOutlineJump } from '../../lib/markdownOutline';

function currentPopoutPane() {
  return typeof window === 'undefined' ? 'main' : parsePopoutPane(window.location.search);
}

function currentEditorPopoutInstanceId() {
  return typeof window === 'undefined' ? null : parsePopoutInstanceId(window.location.search);
}

// 应用外壳与意图编排：身份/状态/设置/字号/布局 + 文档工作台 + 导出流 + 打开意图全流程。
export function useAppShellAndIntents() {
  const shell = useAppWindowShell();
  const ws = useAppDocumentWorkspaceState(shell);
  const intents = useAppOpenIntentWiring(shell, ws);
  return assembleShellIntents(shell, ws, intents);
}

function assembleShellIntents(
  shell: ReturnType<typeof useAppWindowShell>,
  ws: ReturnType<typeof useAppDocumentWorkspaceState>,
  intents: ReturnType<typeof useAppOpenIntentWiring>,
) {
  const { workspace } = ws;
  const { session } = workspace;
  const outlineJump = workspace.outline.outlineJump;
  const currentOutlineJump = outlineJump?.documentId === session.documentId
    && outlineJump.documentEpoch === session.documentEpoch
    ? outlineJump
    : null;
  return {
    ...shell,
    ...documentFields(ws),
    ...intentFields(intents, currentOutlineJump),
    currentOutlineJump,
    editorPaneRatio: shell.editorPaneRatio,
    fileTreeCollapsed: shell.fileTreeCollapsed,
    paneLayoutStyle: shell.paneLayoutStyle,
    previewPaneRefHolder: shell.previewPaneRefHolder,
    setEditorPaneRatio: shell.setEditorPaneRatio,
    setFileTreeCollapsed: shell.setFileTreeCollapsed,
    setWorkspaceSidebarWidth: shell.setWorkspaceSidebarWidth,
    workspaceSidebarWidth: shell.workspaceSidebarWidth };
}

function useAppWindowShell() {
  const { locale, t } = useI18n();
  const { appearance, skin } = useObservedEffectiveTheme();
  const packagedOpenEvidenceEnabled = import.meta.env.VITE_MMD_PACKAGED_OPEN_E2E === '1';
  const popoutPane = useMemo(() => currentPopoutPane(), []);
  const isPopout = popoutPane !== 'main';
  const appUpdater = useAppUpdater(isTauriRuntime() && !isPopout);
  const [editorPopoutInstanceId] = useState(() => (
    popoutPane === 'editor'
      ? currentEditorPopoutInstanceId() ?? createPaneProtocolId('markdown-media-popout')
      : null
  ));
  const [showUnsavedExitPrompt, setShowUnsavedExitPrompt] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [editorPaneRatio, setEditorPaneRatio] = useState(0.5);
  const [workspaceSidebarWidth, setWorkspaceSidebarWidth] = useState(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
  const paneLayoutStyle = useMemo(() => getPaneLayoutStyle(editorPaneRatio), [editorPaneRatio]);
  const settingsState = useSettings();
  const editorFontSize = useEditorFontSize(settingsState.settings, settingsState.updateSettings);
  const workspaceUiStates = useWorkspaceUiStates();
  const previewPaneRefHolder = useRef<React.RefObject<HTMLElement | null> | null>(null);
  return {
    appearance, appUpdater, editorFontSize, editorPopoutInstanceId, editorPaneRatio,
    fileTreeCollapsed, isPopout, locale, packagedOpenEvidenceEnabled, paneLayoutStyle,
    popoutPane, previewPaneRefHolder, setEditorPaneRatio, setFileTreeCollapsed,
    setShowSettings, setWorkspaceSidebarWidth, settingsState, showSettings,
    showUnsavedExitPrompt, setShowUnsavedExitPrompt, skin, t, workspaceUiStates,
    workspaceSidebarWidth };
}


function useAppDocumentWorkspaceState(shell: ReturnType<typeof useAppWindowShell>) {
  const { appearance, isPopout, locale, popoutPane, previewPaneRefHolder, settingsState, skin, t } = shell;
  const workspace = useAppDocumentWorkspace({
    appearance,
    isPopout,
    locale,
    popoutPane,
    settings: settingsState.settings,
    translate: t });
  const { content } = workspace.session;
  const exportFlowValue = useExportFlow({
    activeFileKind: workspace.session.activeFileKind,
    activePath: workspace.session.activePath,
    appearance,
    content,
    locale,
    getPreviewPaneEl: () => previewPaneRefHolder.current?.current ?? null,
    setError: workspace.session.setError,
    setNotice: workspace.session.setNotice,
    skin });
  return { workspace, exportFlowValue };
}

function useAppOpenIntentWiring(
  shell: ReturnType<typeof useAppWindowShell>,
  ws: ReturnType<typeof useAppDocumentWorkspaceState>,
) {
  const workspace = ws.workspace;
  const { currentContentRef, mountedRef, session } = workspace;
  const { exportFlowValue } = ws;
  const { appUpdater, packagedOpenEvidenceEnabled, isPopout, locale, showSettings, workspaceUiStates } = shell;
  const openIntentFlow = useAppOpenIntentFlow({
    currentContentRef,
    evidenceEnabled: packagedOpenEvidenceEnabled,
    isPopout,
    locale,
    modalInputs: {
      appUpdate: appUpdater.update,
      busy: session.busy,
      crashDraftRecoveryError: workspace.crashDraftRecovery.error,
      externalFileAction: session.externalFileAction,
      feedbackDialog: workspace.feedbackDialog,
      saveConflict: session.saveConflict,
      settingsBusy: shell.settingsState.busy,
      settingsRecovery: shell.settingsState.recovery,
      showExport: exportFlowValue.showExport,
      showSettings,
      showUnsavedExitPrompt: shell.showUnsavedExitPrompt,

      workspaceEntryOperation: workspaceUiStates.workspaceEntryOperation,
      workspaceIndexActionBusy: workspaceUiStates.workspaceIndexActionBusy,
      workspaceMoveOperation: workspaceUiStates.workspaceMoveOperation,
      workspaceSearchMode: workspaceUiStates.workspaceSearchMode },
    mountedRef,
    session });
  const { enqueueLocalOpenIntent } = openIntentFlow;
  workspace.crashDraftIntentSinkRef.current = enqueueLocalOpenIntent;

  return { enqueueLocalOpenIntent, openIntentFlow };
}


function documentFields(ws: ReturnType<typeof useAppDocumentWorkspaceState>) {
  const { workspace, exportFlowValue } = ws;
  const { surface: documentSurface } = workspace;
  return {
    documentSurface,
    exportFlowValue,
    session: workspace.session,
    workspace,
    activePresentation: documentSurface.activePresentation,
    activeWorkspaceMarkdownFile: documentSurface.activeWorkspaceMarkdownFile,
    excalidrawAssetSync: workspace.excalidrawAssetSync,
    feedbackDialog: workspace.feedbackDialog,
    editorPasteContextRef: workspace.paste.contextRef,
    dispatchEditorMediaCommandPick: workspace.paste.handleEditorMediaCommandPick,
    handleClipboardImagePaste: workspace.paste.handleClipboardImagePaste,
    handleEditorPasteError: workspace.paste.handleEditorPasteError,
    handleExcalidrawError: documentSurface.handleExcalidrawError,
    outlineItems: documentSurface.outlineItems,
    mountedRef: workspace.mountedRef };
}

function intentFields(
  intents: ReturnType<typeof useAppOpenIntentWiring>,
  currentOutlineJump: MarkdownOutlineJump | null,
) {
  return {
    currentOutlineJump,
    enqueueLocalOpenIntent: intents.enqueueLocalOpenIntent,
    openIntentFlow: intents.openIntentFlow };
}
