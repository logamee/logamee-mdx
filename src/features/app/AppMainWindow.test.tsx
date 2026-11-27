// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyMotion, domAnimation } from 'motion/react';
import { currentSettingsEnvelope } from '../../lib/settingsFixtures';
import { AppMainWindow, type AppMainWindowProps } from './AppMainWindow';

const paneStubs = vi.hoisted(() => ({
  editorPane: (): null => null,
  fileSidebar: (): null => null,
  markdownPreviewContent: (): null => null,
  paneResizer: (): null => null,
  previewPane: (): null => null,
}));

vi.mock('../workspace/EditorPane', () => ({ EditorPane: paneStubs.editorPane }));
vi.mock('../workspace/FileSidebar', () => ({ FileSidebar: paneStubs.fileSidebar }));
vi.mock('../preview/markdownPreviewContent', () => ({
  MarkdownPreviewContent: paneStubs.markdownPreviewContent,
  PreviewPane: paneStubs.previewPane,
}));
vi.mock('../../components/PaneResizer', () => ({ PaneResizer: paneStubs.paneResizer }));

const noop = (): void => undefined;
const done = async (): Promise<void> => undefined;
const feedback = { kind: 'info', role: 'dialog', dismissLabel: 'OK', title: 'Saved', message: 'Settings saved' } as const;

function idleWindow(): AppMainWindowProps {
  const tree = {
    collapsedFolders: new Set<string>(), fileTreeClipboard: null, handleFileTreePaste: done, handleFileTreeReveal: done,
    setFileTreeClipboard: noop, setWorkspaceEntryOperation: noop, setWorkspaceMoveOperation: noop, toggleFolder: noop };
  const search = {
    discardCurrentWorkspaceIndex: noop, rebuildCurrentWorkspaceIndex: noop, requestWorkspaceSearchOpen: noop,
    setWorkspaceSearchMode: noop, showWorkspaceSearchDialog: noop, workspaceIndexActionBusy: false };
  const session = {
    activeFileKind: 'markdown', activePath: null as string | null, authorityStatus: 'committed', busy: false, content: '',
    dirty: false, documentEpoch: 1, documentId: 'document', externalFileAction: null, fileTree: [], previewRevision: 1,
    workspaceRoot: null as string | null, workspaceToken: null as string | null, saveConflict: null,
    handleCancelSaveConflict: noop, handleOpenDirectory: done, moveWorkspaceEntryPath: done, refreshWorkspace: done,
    renameWorkspaceEntryPath: done, setError: noop, setNotice: noop, updateContent: noop,
    handleCloseDeletedDraft: done, handleKeepCurrentExternal: done, handleOverwriteSaveConflict: done,
    handleSaveDeletedDraftAs: done, handleUseExternal: done };
  return {
    appUpdater: { update: null, installing: false, later: noop, skip: noop, install: done },
    channel: {
      currentMediaInsertion: null, handleEditorMediaCommandPick: done, handleEditorPopoutOpen: noop, handleWorkspaceAssetInsert: done },
    editorFontSize: { fontSize: 16, decrease: noop, increase: noop, reset: noop },
    exitFlows: { dismissFeedbackDialog: noop, handleCancelExit: noop, handleQuitWithoutSaving: noop, handleSaveAndQuit: noop },
    exportFlow: {
      exportBusy: false, exportIssues: [], exportValue: { format: 'html', theme: 'current', scale: 1 }, openExportDialog: noop,
      runExport: done, setExportValue: noop, setShowExport: noop, showExport: false },
    layout: {
      editorPaneRatio: 0.5, fileTreeCollapsed: false, setFileTreeCollapsed: noop, workspaceSidebarWidth: 264,
      sidebarResize: { moveWorkspaceSidebarResize: noop, resizeWorkspaceSidebarWithKeyboard: noop, startWorkspaceSidebarResize: noop, stopWorkspaceSidebarResize: noop } },
    openIntentFlow: {
      dirtyModalHandlers: { handleCancelFileSwitch: noop, handleFileSwitchWithoutSaving: noop, handleSaveAndSwitchFile: done },
      pendingOpenIntent: null, unsavedExitPrompt: null, unsavedFileSwitchPrompt: null },
    outline: { currentOutlineJump: null, handleOutlineItemSelect: noop },
    paneResize: {
      editorPaneRef: { current: null }, isResizing: false, movePaneResize: noop, previewPaneRef: { current: null }, resetPaneRatio: noop,
      resizePaneWithKeyboard: noop, startPaneResize: noop, stopPaneResize: noop },
    panels: { search, tree },
    paste: {
      handleAuthorizeResourceDirectory: async () => null, handleClipboardImagePaste: async () => null, handleEditorPasteError: noop },
    popoutButtons: { editorPopoutButton: undefined, openPanePopout: noop, previewPopoutButton: undefined },
    requestWorkspaceFileOpen: noop,
    settingsChrome: {
      locale: 'en', settingsState: { busy: false, recovery: null, reset: done, retry: done, settings: currentSettingsEnvelope.settings, updateSettings: done },
      setShowSettings: noop, showSettings: false, showUnsavedExitPrompt: false, translate: () => '' },
    uiStates: {
      setWorkspaceSearchMode: noop, workspaceEntryOperation: null, workspaceIndexActionBusy: false,
      workspaceMoveOperation: null, workspaceSearchMode: null },
    workspace: {
      crashDraftRecovery: { busy: false, canRepairOverflow: false, error: null, overflowRepairProgress: null, repairOverflowBatch: done, retry: done },
      excalidrawAssetSync: null, feedbackDialog: null, session,
      surface: {
        activePresentation: 'markdown', activeWorkspaceMarkdownFile: null, documentPreview: null, editorFileKind: 'markdown',
        handleExcalidrawError: noop, isDocumentFile: false, isExcalidrawFile: false, isImageFile: false, isMediaFile: false,
        mediaKind: 'audio', mediaMimeType: '', outlineItems: [] } },
  } as unknown as AppMainWindowProps;
}

const openDialogs: [string, (props: AppMainWindowProps) => void][] = [
  ['a feedback notification', props => { props.workspace.feedbackDialog = feedback; }],
  ['the settings dialog', props => { props.settingsChrome.showSettings = true; }],
];

describe('main window modal isolation', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (arrange?: (props: AppMainWindowProps) => void) => {
    const props = idleWindow();
    arrange?.(props);
    act(() => root.render(<LazyMotion features={domAnimation}><AppMainWindow {...props} /></LazyMotion>));
  };
  const isInert = (selector: string) => container.querySelector(selector)?.hasAttribute('inert');

  it('keeps the toolbar and workspace interactive while no dialog is open', () => {
    render();

    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(isInert('header.toolbar')).toBe(false);
    expect(isInert('main')).toBe(false);
  });

  it.each(openDialogs)('makes the toolbar and workspace inert behind %s until it closes', (_, arrange) => {
    render(arrange);

    expect(container.querySelector('[aria-modal="true"]')).not.toBeNull();
    expect(isInert('header.toolbar')).toBe(true);
    expect(isInert('main')).toBe(true);

    render();

    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(isInert('header.toolbar')).toBe(false);
    expect(isInert('main')).toBe(false);
  });

  it('keeps the toolbar and workspace inert while one dialog hands off to another', async () => {
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => undefined });
    try {
      render(props => { props.workspace.feedbackDialog = feedback; });
      render(props => {
        props.workspace.crashDraftRecovery.error = { code: 'storeFull', message: 'Storage full', canReset: false };
      });

      expect(container.querySelector('#app-feedback-title')).not.toBeNull();
      expect(container.querySelector('#crash-draft-store-repair-title')).toBeNull();
      expect(isInert('header.toolbar')).toBe(true);
      expect(isInert('main')).toBe(true);

      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(container.querySelector('#crash-draft-store-repair-title')).not.toBeNull();
      });

      expect(isInert('header.toolbar')).toBe(true);
      expect(isInert('main')).toBe(true);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });

  it('returns focus to a control inside the workspace when a dialog closes without an exit animation', () => {
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusOutsideInert(this: HTMLElement, options?: FocusOptions) {
      if (this.closest('[inert]')) return;
      nativeFocus.call(this, options);
    };
    try {
      render();
      const opener = container.querySelector<HTMLButtonElement>('.workspace-sidebar-resizer');
      act(() => opener?.focus());
      expect(document.activeElement).toBe(opener);

      render(props => { props.settingsChrome.showSettings = true; });
      expect(isInert('main')).toBe(true);

      render();

      expect(container.querySelector('[aria-modal="true"]')).toBeNull();
      expect(isInert('main')).toBe(false);
      expect(document.activeElement).toBe(opener);
    } finally {
      HTMLElement.prototype.focus = nativeFocus;
    }
  });
});
