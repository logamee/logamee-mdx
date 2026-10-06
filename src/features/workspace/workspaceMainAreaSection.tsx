import type { ComponentProps, Ref } from 'react';
import { FileSidebar } from './FileSidebar';
import { getWorkspaceLayoutClassName } from '../../lib/sidebarLayout';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { WorkspaceFileKind } from '../../types';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { AppPaneSurfaceView } from '../preview/appPaneSurface';
import {
  WorkspaceMainArea,
  type PopoutButton,
  type ResizerHandlers,
  type WorkspaceMainAreaView } from './WorkspaceMainArea';

export interface WorkspaceMainAreaComposites {
  fileTreeCollapsed: boolean;
  handleWorkspaceAssetInsert: WorkspaceMainAreaView['handleWorkspaceAssetInsert'];
  layout: {
    editorPaneRatio: number;
    paneLayoutStyle: React.CSSProperties;
    sidebarLayoutStyle: React.CSSProperties;
  };
  outlineSelect: ComponentProps<typeof FileSidebar>['onSelectOutlineItem'];
  requestWorkspaceFileOpen: (path: string) => void;
  setFileTreeCollapsed: (collapsed: boolean) => void;
  paneSurface: AppPaneSurfaceView;
  paneViews: {
    editorPaneRef: Ref<HTMLElement>;
    editorPopoutButton: PopoutButton;
    handleEditorPopoutOpen: () => void;
    openPreviewPopout: () => unknown;
    previewPaneRef: Ref<HTMLElement>;
    previewPopoutButton: PopoutButton;
  };
  panels: {
    tree: {
      collapsedFolders: Set<string>;
      fileTreeClipboard: FileTreeClipboardItem | null;
      handleFileTreePaste: WorkspaceMainAreaView['handleFileTreePaste'];
      handleFileTreeReveal: WorkspaceMainAreaView['handleFileTreeReveal'];
      setFileTreeClipboard: (clipboard: FileTreeClipboardItem | null) => void;
      setWorkspaceEntryOperation: WorkspaceMainAreaView['setWorkspaceEntryOperation'];
      setWorkspaceMoveOperation: WorkspaceMainAreaView['setWorkspaceMoveOperation'];
      toggleFolder: (path: string) => void;
    };
  };
  paneResize: {
    resizePaneWithKeyboard: ResizerHandlers['onKeyDown'];
    stopPaneResize: ResizerHandlers['onPointerCancel'];
    startPaneResize: ResizerHandlers['onPointerDown'];
    movePaneResize: ResizerHandlers['onPointerMove'];
  };
  sidebarResize: {
    resizeWorkspaceSidebarWithKeyboard: ResizerHandlers['onKeyDown'];
    stopWorkspaceSidebarResize: ResizerHandlers['onPointerCancel'];
    startWorkspaceSidebarResize: ResizerHandlers['onPointerDown'];
    moveWorkspaceSidebarResize: ResizerHandlers['onPointerMove'];
  };
  session: {
    activeFileKind: WorkspaceFileKind;
    busy: boolean;
    externalFileActionActive: boolean;
    fileTree: WorkspaceFileTreeNode[];
    handleOpenDirectory: () => Promise<void>;
    moveWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>;
    pendingOpenIntentActive: boolean;
    refreshWorkspace: () => Promise<void>;
    renameWorkspaceEntryPath: (path: string, newName: string) => Promise<void>;
  };
  sidebarWidth: number;
}

export function WorkspaceMainAreaSection({ ctx }: { ctx: WorkspaceMainAreaComposites }) {
  return WorkspaceMainArea({ view: buildMainAreaView(ctx) });
}

function buildMainAreaView(ctx: WorkspaceMainAreaComposites): WorkspaceMainAreaView {
  const { session, panels, layout, paneViews } = ctx;
  return {
    ...ctx.paneSurface,
    activeFileKind: session.activeFileKind,
    busy: session.busy,
    collapsedFolders: panels.tree.collapsedFolders,
    editorPaneRatio: layout.editorPaneRatio,
    editorPaneRef: paneViews.editorPaneRef,
    editorPopoutButton: paneViews.editorPopoutButton,
    externalFileActionActive: session.externalFileActionActive,
    fileTree: session.fileTree,
    fileTreeClipboard: panels.tree.fileTreeClipboard,
    fileTreeCollapsed: ctx.fileTreeCollapsed,
    handleEditorPopoutOpen: paneViews.handleEditorPopoutOpen,
    handleFileTreePaste: panels.tree.handleFileTreePaste,
    handleFileTreeReveal: panels.tree.handleFileTreeReveal,
    handleOpenDirectory: session.handleOpenDirectory,
    handleOutlineItemSelect: ctx.outlineSelect,
    handleWorkspaceAssetInsert: ctx.handleWorkspaceAssetInsert,
    layoutClassName: getWorkspaceLayoutClassName(ctx.fileTreeCollapsed, session.activeFileKind),
    layoutStyle: { ...layout.sidebarLayoutStyle, ...layout.paneLayoutStyle },
    moveWorkspaceEntryPath: session.moveWorkspaceEntryPath,
    openPreviewPopout: paneViews.openPreviewPopout,
    paneResizer: {
      onKeyDown: ctx.paneResize.resizePaneWithKeyboard,
      onPointerCancel: ctx.paneResize.stopPaneResize as () => void,
      onPointerDown: ctx.paneResize.startPaneResize,
      onPointerMove: ctx.paneResize.movePaneResize,
      onPointerUp: ctx.paneResize.stopPaneResize },
    pendingOpenIntentActive: session.pendingOpenIntentActive,
    previewPaneRef: paneViews.previewPaneRef,
    previewPopoutButton: paneViews.previewPopoutButton,
    refreshWorkspace: session.refreshWorkspace,
    renameWorkspaceEntryPath: session.renameWorkspaceEntryPath,
    requestWorkspaceFileOpen: ctx.requestWorkspaceFileOpen,
    setFileTreeCollapsed: ctx.setFileTreeCollapsed,
    setFileTreeClipboard: panels.tree.setFileTreeClipboard,
    setWorkspaceEntryOperation: panels.tree.setWorkspaceEntryOperation,
    setWorkspaceMoveOperation: panels.tree.setWorkspaceMoveOperation,
    sidebarResizerHandlers: {
      sidebarWidth: ctx.sidebarWidth,
      onKeyDown: ctx.sidebarResize.resizeWorkspaceSidebarWithKeyboard,
      onPointerCancel: ctx.sidebarResize.stopWorkspaceSidebarResize as () => void,
      onPointerDown: ctx.sidebarResize.startWorkspaceSidebarResize,
      onPointerMove: ctx.sidebarResize.moveWorkspaceSidebarResize,
      onPointerUp: ctx.sidebarResize.stopWorkspaceSidebarResize as () => void },
    toggleFolder: panels.tree.toggleFolder };
}
