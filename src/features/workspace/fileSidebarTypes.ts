import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from 'react';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { FileTreeContextAction, FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { MarkdownMediaInsertionTarget } from '../../lib/markdownMedia';
import type { MarkdownOutlineItem } from '../../lib/markdownOutline';
import type { MenuPosition } from './fileSidebarIcon';
import type { PointerDragSession, WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type { WorkspaceFileEntry, WorkspaceFileKind } from '../../types';

export interface FileSidebarProps {
  activePath: string | null;
  collapsed: boolean;
  collapsedFolders: Set<string>;
  disabled?: boolean;
  fileTree: WorkspaceFileTreeNode[];
  clipboard?: FileTreeClipboardItem | null;
  onCollapseChange: (collapsed: boolean) => void;
  onCopyEntry?: (target: WorkspaceTreeTarget) => void;
  onCreateFile: (
    parentPath: string,
    parentName: string,
    fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'>,
  ) => void;
  onCreateFolder: (parentPath: string, parentName: string) => void;
  onCutEntry?: (target: WorkspaceTreeTarget) => void;
  onDeleteEntry: (path: string, name: string, kind: 'file' | 'folder') => void;
  onInsertWorkspaceAsset?: (asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void;
  onMoveEntry: (path: string, destinationParentPath: string) => void;
  onOpenDirectory?: () => void;
  onOpenFile: (path: string) => void;
  onPasteEntry?: (destinationParentPath: string) => void;
  onRefreshWorkspace: () => void;
  onRenameEntry: (path: string, newName: string, kind: 'file' | 'folder') => void;
  onRequestMove: (target: Exclude<FileTreeContextTarget, { kind: 'root' }>) => void;
  onRevealEntry?: (target: FileTreeContextTarget) => void;
  onSelectOutlineItem?: (item: MarkdownOutlineItem) => void;
  onToggleFolder: (path: string) => void;
  outlineItems?: MarkdownOutlineItem[];
  workspaceRoot: string | null;
}

export interface ContextMenuState {
  align: 'end' | 'start';
  target: FileTreeContextTarget;
  x: number;
  y: number;
}

export type SidebarView = 'files' | 'outline';

export interface FileSidebarSelection {
  renamingPath: string | null;
  rootButtonRef: RefObject<HTMLButtonElement | null>;
  rootTarget: FileTreeContextTarget | null;
  selectedTarget: FileTreeContextTarget | null;
  setRenamingPath: Dispatch<SetStateAction<string | null>>;
  setSelectedTarget: Dispatch<SetStateAction<FileTreeContextTarget | null>>;
  treeRef: RefObject<HTMLDivElement | null>;
}

export interface FileSidebarMenuState {
  addMenuButtonRef: RefObject<HTMLButtonElement | null>;
  addMenuOpen: boolean;
  addMenuPosition: MenuPosition | null;
  addMenuRef: RefObject<HTMLDivElement | null>;
  closeMenus: () => void;
  contextMenu: ContextMenuState | null;
  contextMenuPosition: MenuPosition | null;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  openContextMenu: (
    x: number,
    y: number,
    target: FileTreeContextTarget,
    align?: 'end' | 'start',
  ) => void;
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>;
  setAddMenuPosition: Dispatch<SetStateAction<MenuPosition | null>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  setContextMenuPosition: Dispatch<SetStateAction<MenuPosition | null>>;
  sidebarRef: RefObject<HTMLElement | null>;
}

export interface FileSidebarMenus {
  openRootContextMenu: (event: MouseEvent<HTMLElement>) => void;
  openRootContextMenuFromKeyboard: (event: ReactKeyboardEvent<HTMLElement>) => void;
  openSelectedTargetMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  toggleAddMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}

export interface FileSidebarViews {
  handleOutlineTreeNavigation: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  handleSidebarTabNavigation: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentView: SidebarView,
  ) => void;
  selectOutlineItem: (item: MarkdownOutlineItem) => void;
  selectSidebarView: (view: SidebarView) => void;
  selectedOutlineId: string | null;
  sidebarTabRefs: RefObject<Record<SidebarView, HTMLButtonElement | null>>;
  sidebarView: SidebarView;
}

export interface FileSidebarCreateEntry {
  beginCreate: (
    kind: 'file' | 'excalidraw' | 'folder',
    target?: FileTreeContextTarget | null,
  ) => void;
}

export interface FileSidebarTargetActions {
  beginRename: (target: WorkspaceTreeTarget) => void;
  requestDelete: (target: WorkspaceTreeTarget) => void;
  requestMove: (target: WorkspaceTreeTarget) => void;
}

export interface FileSidebarContextActions {
  contextMenuCanPaste: (target: FileTreeContextTarget) => boolean;
  contextMenuPasteDestination: (target: FileTreeContextTarget) => string;
}

export interface FileSidebarActions
  extends FileSidebarCreateEntry, FileSidebarTargetActions, FileSidebarContextActions {
  runContextAction: (action: FileTreeContextAction) => void;
}

export interface FileSidebarDragState {
  draggedTarget: WorkspaceTreeTarget | null;
  dropTargetPath: string | null;
  fileTreeRef: RefObject<WorkspaceFileTreeNode[]>;
  handleSidebarClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onInsertWorkspaceAssetRef: RefObject<
    ((asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void) | undefined
  >;
  pointerDragRef: RefObject<PointerDragSession | null>;
  setDraggedTarget: Dispatch<SetStateAction<WorkspaceTreeTarget | null>>;
  setDropTargetPath: Dispatch<SetStateAction<string | null>>;
  suppressNextClickRef: RefObject<boolean>;
}

export interface FileSidebarDrag {
  draggedTarget: WorkspaceTreeTarget | null;
  dropTargetPath: string | null;
  fileTreeRef: RefObject<WorkspaceFileTreeNode[]>;
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  handleSidebarClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onInsertWorkspaceAssetRef: RefObject<
    ((asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void) | undefined
  >;
}

export interface FileSidebarDragGestures {
  canPointerDropOn: (source: WorkspaceTreeTarget, destinationParentPath: string | null) => boolean;
  getPointerDropDestination: (clientX: number, clientY: number) => string | null;
  getPointerMediaAsset: (
    source: WorkspaceTreeTarget,
    clientX: number,
    clientY: number,
  ) => WorkspaceFileEntry | null;
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface FileSidebarTree {
  focusTreeRow: (position: 'first' | 'last') => void;
  handleTreeBackgroundContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  handleTreeNavigation: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}
