import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  Ellipsis,
  FolderInput,
  FolderOpen,
  FolderPlus,
  ListTree,
  Pencil,
  PencilRuler,
  Plus,
  RefreshCw,
  TextCursorInput,
  Trash2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getFileTreeContextMenuItems,
  type FileTreeContextAction,
  type FileTreeContextTarget,
} from '../lib/fileTreeContextMenu';
import { canMoveWorkspaceEntry } from '../lib/fileTreeOperations';
import type { WorkspaceFileTreeNode } from '../lib/fileTree';
import {
  FLOATING_MENU_VIEWPORT_MARGIN,
  getFloatingMenuPosition,
} from '../lib/floatingMenuPosition';
import { useI18n } from '../lib/i18n';
import type { MarkdownOutlineItem } from '../lib/markdownOutline';
import {
  isMarkdownWorkspaceReferenceKind,
  type MarkdownMediaInsertionTarget,
} from '../lib/markdownMedia';
import type { WorkspaceFileEntry, WorkspaceFileKind } from '../types';
import { FileTreeRows } from './FileTreeRows';

interface FileSidebarProps {
  activePath: string | null;
  collapsed: boolean;
  collapsedFolders: Set<string>;
  disabled?: boolean;
  fileTree: WorkspaceFileTreeNode[];
  onCollapseChange: (collapsed: boolean) => void;
  onCreateFile: (
    parentPath: string,
    parentName: string,
    fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'>,
  ) => void;
  onCreateFolder: (parentPath: string, parentName: string) => void;
  onDeleteEntry: (path: string, name: string, kind: 'file' | 'folder') => void;
  onInsertWorkspaceAsset?: (asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void;
  onMoveEntry: (path: string, destinationParentPath: string) => void;
  onOpenFile: (path: string) => void;
  onRefreshWorkspace: () => void;
  onRenameEntry: (path: string, newName: string, kind: 'file' | 'folder') => void;
  onRequestMove: (target: Exclude<FileTreeContextTarget, { kind: 'root' }>) => void;
  onSelectOutlineItem?: (item: MarkdownOutlineItem) => void;
  onToggleFolder: (path: string) => void;
  outlineItems?: MarkdownOutlineItem[];
  workspaceRoot: string | null;
}

interface ContextMenuState {
  align: 'end' | 'start';
  target: FileTreeContextTarget;
  x: number;
  y: number;
}

interface MenuPosition {
  x: number;
  y: number;
}

type WorkspaceTreeTarget = Exclude<FileTreeContextTarget, { kind: 'root' }>;
type SidebarView = 'files' | 'outline';

interface PointerDragSession {
  active: boolean;
  pointerId: number;
  source: WorkspaceTreeTarget;
  sourceElement: HTMLElement;
  startX: number;
  startY: number;
}

const POINTER_DRAG_THRESHOLD = 6;
const MENU_TRIGGER_GAP = 4;
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function ContextMenuIcon({ action }: { action: FileTreeContextAction }) {
  if (action === 'create-file') return <FilePlus2 size={14} />;
  if (action === 'create-folder') return <FolderPlus size={14} />;
  if (action === 'open') return <FileText size={14} />;
  if (action === 'insert-at-cursor') return <TextCursorInput size={14} />;
  if (action === 'refresh') return <RefreshCw size={14} />;
  if (action === 'rename') return <Pencil size={14} />;
  if (action === 'move') return <FolderInput size={14} />;
  return <Trash2 size={14} />;
}

function pathName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function findTreeTarget(
  nodes: WorkspaceFileTreeNode[],
  path: string,
): WorkspaceTreeTarget | null {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      if (node.absolutePath === path) {
        return { kind: 'folder', name: node.name, path: node.absolutePath };
      }
      const nested = findTreeTarget(node.children, path);
      if (nested) return nested;
    } else if (node.path === path) {
      return {
        fileKind: node.file.kind,
        kind: 'file',
        name: node.name,
        path: node.path,
      };
    }
  }
  return null;
}

function findWorkspaceFileEntry(
  nodes: WorkspaceFileTreeNode[],
  path: string,
): WorkspaceFileEntry | null {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const nested = findWorkspaceFileEntry(node.children, path);
      if (nested) return nested;
    } else if (node.path === path) {
      return node.file;
    }
  }
  return null;
}

function getMenuSize(menu: HTMLElement) {
  const rect = menu.getBoundingClientRect();
  return {
    height: menu.offsetHeight || rect.height,
    width: menu.offsetWidth || rect.width,
  };
}

export function FileSidebar({
  activePath,
  collapsed,
  collapsedFolders,
  disabled = false,
  fileTree,
  onCollapseChange,
  onCreateFile,
  onCreateFolder,
  onDeleteEntry,
  onInsertWorkspaceAsset,
  onMoveEntry,
  onOpenFile,
  onRefreshWorkspace,
  onRenameEntry,
  onRequestMove,
  onSelectOutlineItem = () => undefined,
  onToggleFolder,
  outlineItems = [],
  workspaceRoot,
}: FileSidebarProps) {
  const { t } = useI18n();
  const sidebarToggleLabel = collapsed ? t('expandFileTree') : t('collapseFileTree');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<MenuPosition | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<MenuPosition | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<FileTreeContextTarget | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [draggedTarget, setDraggedTarget] = useState<WorkspaceTreeTarget | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rootButtonRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const sidebarTabRefs = useRef<Record<SidebarView, HTMLButtonElement | null>>({
    files: null,
    outline: null,
  });
  const pointerDragRef = useRef<PointerDragSession | null>(null);
  const suppressNextClickRef = useRef(false);
  const onMoveEntryRef = useRef(onMoveEntry);
  onMoveEntryRef.current = onMoveEntry;
  const onInsertWorkspaceAssetRef = useRef(onInsertWorkspaceAsset);
  onInsertWorkspaceAssetRef.current = onInsertWorkspaceAsset;
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;
  const rootTarget = useMemo<FileTreeContextTarget | null>(() => (
    workspaceRoot
      ? { kind: 'root', name: pathName(workspaceRoot), path: workspaceRoot }
      : null
  ), [workspaceRoot]);

  useEffect(() => {
    if (!activePath) return;
    const activeTarget = findTreeTarget(fileTree, activePath);
    if (activeTarget) setSelectedTarget(activeTarget);
  }, [activePath, fileTree]);

  useEffect(() => {
    if (!workspaceRoot) {
      setSelectedTarget(null);
      setRenamingPath(null);
      return;
    }
    if (!selectedTarget) {
      setSelectedTarget(activePath ? findTreeTarget(fileTree, activePath) ?? rootTarget : rootTarget);
      return;
    }
    if (selectedTarget.kind === 'root' && selectedTarget.path === workspaceRoot) return;
    if (findTreeTarget(fileTree, selectedTarget.path)) return;
    setSelectedTarget(activePath ? findTreeTarget(fileTree, activePath) ?? rootTarget : rootTarget);
    setRenamingPath(null);
  }, [activePath, fileTree, rootTarget, selectedTarget, workspaceRoot]);

  const closeMenus = useCallback(() => {
    setContextMenu(null);
    setContextMenuPosition(null);
    setAddMenuOpen(false);
    setAddMenuPosition(null);
  }, []);

  useClientLayoutEffect(() => {
    if (!addMenuOpen) return;
    const button = addMenuButtonRef.current;
    const menu = addMenuRef.current;
    const sidebar = sidebarRef.current;
    if (!button || !menu || !sidebar) return;

    const buttonRect = button.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    setAddMenuPosition(getFloatingMenuPosition({
      align: 'end',
      anchor: {
        x: sidebarRect.right - FLOATING_MENU_VIEWPORT_MARGIN,
        y: buttonRect.bottom + MENU_TRIGGER_GAP,
      },
      menu: getMenuSize(menu),
      viewport: { height: window.innerHeight, width: window.innerWidth },
    }));
  }, [addMenuOpen]);

  useClientLayoutEffect(() => {
    if (!contextMenu) return;
    const menu = contextMenuRef.current;
    if (!menu) return;

    setContextMenuPosition(getFloatingMenuPosition({
      align: contextMenu.align,
      anchor: { x: contextMenu.x, y: contextMenu.y },
      menu: getMenuSize(menu),
      viewport: { height: window.innerHeight, width: window.innerWidth },
    }));
  }, [contextMenu]);

  useEffect(() => {
    if (!disabled) return;
    closeMenus();
    setRenamingPath(null);
    pointerDragRef.current = null;
    setDraggedTarget(null);
    setDropTargetPath(null);
  }, [closeMenus, disabled]);

  useEffect(() => {
    setSelectedOutlineId((current) => (
      outlineItems.some((item) => item.id === current) ? current : null
    ));
  }, [outlineItems]);

  useEffect(() => {
    setSelectedOutlineId(null);
  }, [activePath]);

  const selectSidebarView = useCallback((view: SidebarView) => {
    setSidebarView(view);
    setContextMenu(null);
    setAddMenuOpen(false);
    if (view === 'outline') setRenamingPath(null);
  }, []);

  const handleSidebarTabNavigation = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentView: SidebarView,
  ) => {
    let nextView: SidebarView | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextView = currentView === 'files' ? 'outline' : 'files';
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextView = currentView === 'files' ? 'outline' : 'files';
    } else if (event.key === 'Home') {
      nextView = 'files';
    } else if (event.key === 'End') {
      nextView = 'outline';
    }
    if (!nextView) return;
    event.preventDefault();
    selectSidebarView(nextView);
    sidebarTabRefs.current[nextView]?.focus();
  }, [selectSidebarView]);

  useEffect(() => {
    if (!contextMenu && !addMenuOpen) return undefined;
    const close = () => closeMenus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
    };
  }, [addMenuOpen, closeMenus, contextMenu]);

  const openContextMenu = useCallback((
    x: number,
    y: number,
    target: FileTreeContextTarget,
    align: ContextMenuState['align'] = 'start',
  ) => {
    if (disabled) return;
    setSelectedTarget(target);
    setAddMenuOpen(false);
    setAddMenuPosition(null);
    setContextMenuPosition(null);
    setContextMenu({ align, target, x, y });
  }, [disabled]);

  const openRootContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!rootTarget) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.clientX, event.clientY, rootTarget);
  }, [openContextMenu, rootTarget]);

  const openRootContextMenuFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!rootTarget || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu(rect.left + 20, rect.bottom + 4, rootTarget);
  }, [openContextMenu, rootTarget]);

  const creationTarget = useMemo(() => (
    selectedTarget?.kind === 'folder' ? selectedTarget : rootTarget
  ), [rootTarget, selectedTarget]);

  const beginCreate = useCallback((kind: 'file' | 'excalidraw' | 'folder', target = creationTarget) => {
    if (disabled || !target) return;
    closeMenus();
    if (kind === 'folder') {
      onCreateFolder(target.path, target.name);
      return;
    }
    onCreateFile(target.path, target.name, kind === 'excalidraw' ? 'excalidraw' : 'markdown');
  }, [closeMenus, creationTarget, disabled, onCreateFile, onCreateFolder]);

  const beginRename = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(target.path);
    closeMenus();
  }, [closeMenus, disabled]);

  const requestDelete = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(null);
    closeMenus();
    onDeleteEntry(target.path, target.name, target.kind);
  }, [closeMenus, disabled, onDeleteEntry]);

  const requestMove = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(null);
    closeMenus();
    onRequestMove(target);
  }, [closeMenus, disabled, onRequestMove]);

  const runContextAction = useCallback((action: FileTreeContextAction) => {
    const target = contextMenu?.target;
    if (!target) return;
    if (action === 'create-file') beginCreate('file', target);
    else if (action === 'create-folder') beginCreate('folder', target);
    else if (action === 'open' && target.kind === 'file') {
      closeMenus();
      onOpenFile(target.path);
    } else if (action === 'insert-at-cursor' && target.kind === 'file') {
      const asset = findWorkspaceFileEntry(fileTreeRef.current, target.path);
      closeMenus();
      if (asset && isMarkdownWorkspaceReferenceKind(asset.kind)) {
        onInsertWorkspaceAssetRef.current?.(asset, { kind: 'cursor' });
      }
    } else if (action === 'refresh') {
      closeMenus();
      onRefreshWorkspace();
    } else if (action === 'rename' && target.kind !== 'root') beginRename(target);
    else if (action === 'move' && target.kind !== 'root') requestMove(target);
    else if (action === 'delete' && target.kind !== 'root') requestDelete(target);
  }, [beginCreate, beginRename, closeMenus, contextMenu, onOpenFile, onRefreshWorkspace, requestDelete, requestMove]);

  const getPointerDropDestination = useCallback((clientX: number, clientY: number) => {
    if (!workspaceRoot || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(clientX, clientY);
    if (!(hit instanceof Element)) return null;
    const row = hit.closest<HTMLElement>('.tree-row');
    if (row) {
      if (row.dataset.contextMenuTarget === 'folder') return row.dataset.treeEntryPath ?? null;
      return null;
    }
    const branch = hit.closest<HTMLElement>('.tree-branch-children[data-tree-parent-path]');
    if (branch?.dataset.treeParentPath) return branch.dataset.treeParentPath;
    if (hit.closest('.workspace-root')) return workspaceRoot;
    if (hit.closest('.file-tree')) return workspaceRoot;
    return null;
  }, [workspaceRoot]);

  const canPointerDropOn = useCallback((source: WorkspaceTreeTarget, destinationParentPath: string | null) => (
    !disabled && destinationParentPath !== null && canMoveWorkspaceEntry({
      destinationParentPath,
      sourceKind: source.kind,
      sourcePath: source.path,
    })
  ), [disabled]);

  const getPointerMediaAsset = useCallback((
    source: WorkspaceTreeTarget,
    clientX: number,
    clientY: number,
  ): WorkspaceFileEntry | null => {
    if (
      !onInsertWorkspaceAssetRef.current
      || source.kind !== 'file'
      || (source.fileKind !== 'image' && source.fileKind !== 'audio')
      || typeof document.elementFromPoint !== 'function'
    ) return null;
    const hit = document.elementFromPoint(clientX, clientY);
    if (!(hit instanceof Element) || !hit.closest('[data-markdown-media-drop-target]')) return null;
    const asset = findWorkspaceFileEntry(fileTreeRef.current, source.path);
    return asset?.kind === 'image' || asset?.kind === 'audio' ? asset : null;
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return;
    if (event.target.closest('button, input, select, textarea')) return;
    const row = event.target.closest<HTMLElement>('.tree-row[data-tree-entry-path]');
    const path = row?.dataset.treeEntryPath;
    const source = path ? findTreeTarget(fileTree, path) : null;
    if (!row || !source || row.classList.contains('renaming')) return;
    pointerDragRef.current = {
      active: false,
      pointerId: event.pointerId,
      source,
      sourceElement: row,
      startX: event.clientX,
      startY: event.clientY,
    };
    row.setPointerCapture?.(event.pointerId);
  }, [disabled, fileTree]);

  useEffect(() => {
    const armClickSuppression = () => {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    };

    const reset = (session: PointerDragSession | null) => {
      pointerDragRef.current = null;
      setDraggedTarget(null);
      setDropTargetPath(null);
      if (session?.sourceElement.hasPointerCapture?.(session.pointerId)) {
        session.sourceElement.releasePointerCapture(session.pointerId);
      }
    };

    const move = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (!session.active) {
        const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
        if (distance < POINTER_DRAG_THRESHOLD) return;
        session.active = true;
        setSelectedTarget(session.source);
        setRenamingPath(null);
        closeMenus();
        setDraggedTarget(session.source);
      }
      event.preventDefault();
      const mediaAsset = getPointerMediaAsset(session.source, event.clientX, event.clientY);
      const destination = getPointerDropDestination(event.clientX, event.clientY);
      setDropTargetPath(
        !mediaAsset && canPointerDropOn(session.source, destination) ? destination : null,
      );
    };

    const finish = (event: PointerEvent, commit: boolean) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (session.active) {
        event.preventDefault();
        armClickSuppression();
        if (commit) {
          const mediaAsset = getPointerMediaAsset(session.source, event.clientX, event.clientY);
          if (mediaAsset) {
            onInsertWorkspaceAssetRef.current?.(mediaAsset, {
              kind: 'coordinates',
              clientX: event.clientX,
              clientY: event.clientY,
            });
            reset(session);
            return;
          }
          const destination = getPointerDropDestination(event.clientX, event.clientY);
          if (canPointerDropOn(session.source, destination)) {
            onMoveEntryRef.current(session.source.path, destination!);
          }
        }
      }
      reset(session);
    };

    const cancelSession = (session: PointerDragSession | null) => {
      if (session?.active) armClickSuppression();
      reset(session);
    };

    const cancel = (event: PointerEvent) => finish(event, false);
    const drop = (event: PointerEvent) => finish(event, true);
    const cancelOnLostCapture = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      cancelSession(session);
    };
    const cancelOnBlur = () => cancelSession(pointerDragRef.current);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', drop, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('lostpointercapture', cancelOnLostCapture, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', drop, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('lostpointercapture', cancelOnLostCapture, true);
      window.removeEventListener('blur', cancelOnBlur);
      cancelSession(pointerDragRef.current);
    };
  }, [canPointerDropOn, closeMenus, getPointerDropDestination, getPointerMediaAsset]);

  const handleTreeBackgroundContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!rootTarget) return;
    if (event.target instanceof Element && event.target.closest('.tree-row')) return;
    openRootContextMenu(event);
  }, [openRootContextMenu, rootTarget]);

  const focusTreeRow = useCallback((position: 'first' | 'last') => {
    const rows = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    if (!rows?.length) return;
    const row = position === 'first' ? rows[0] : rows[rows.length - 1];
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const handleTreeNavigation = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target instanceof HTMLInputElement) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    if (rows.length === 0) return;
    const currentIndex = rows.findIndex((row) => row === document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = rows.length - 1;
    else if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, rows.length - 1);
    else if (currentIndex <= 0) {
      event.preventDefault();
      rootButtonRef.current?.focus();
      return;
    } else nextIndex = currentIndex - 1;
    if (nextIndex < 0 || nextIndex === currentIndex) return;
    event.preventDefault();
    rows[nextIndex]?.focus();
    rows[nextIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const selectOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    setSelectedOutlineId(item.id);
    onSelectOutlineItem(item);
  }, [onSelectOutlineItem]);

  const handleOutlineTreeNavigation = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
    if (rows.length === 0) return;
    const currentIndex = rows.findIndex((row) => row === document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = rows.length - 1;
    else if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, rows.length - 1);
    else nextIndex = Math.max(currentIndex - 1, 0);
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    rows[nextIndex]?.focus();
    rows[nextIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  return (
    <aside
      ref={sidebarRef}
      className={collapsed ? 'sidebar is-collapsed' : 'sidebar'}
      onClickCapture={(event) => {
        if (!suppressNextClickRef.current) return;
        suppressNextClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handlePointerDown}
    >
      {collapsed ? (
        <div className="sidebar-rail">
          <button
            type="button"
            className="sidebar-icon-button sidebar-collapse-toggle"
            aria-label={sidebarToggleLabel}
            title={sidebarToggleLabel}
            onClick={() => onCollapseChange(false)}
          >
            <ChevronRight size={16} />
          </button>
          <div className="sidebar-rail-label" title={t('workspaceFiles')}>
            <FolderOpen size={18} />
            <span>{t('files')}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="sidebar-heading" aria-label={t('workspaceFiles')}>
            <div className="sidebar-heading-title">
              <strong>{t('workspace')}</strong>
              <span>{sidebarView === 'files' ? t('files') : t('outline')}</span>
            </div>
            <div className="sidebar-heading-actions">
              {sidebarView === 'files' && (
                <>
                  {workspaceRoot && (
                    <div className="sidebar-add-menu-wrap">
                      <button
                        ref={addMenuButtonRef}
                        type="button"
                        className="sidebar-icon-button"
                        aria-label={t('addWorkspaceItem')}
                        aria-expanded={addMenuOpen}
                        aria-haspopup="menu"
                        disabled={disabled}
                        title={t('addWorkspaceItem')}
                        onClick={(event) => {
                          event.stopPropagation();
                          setContextMenu(null);
                          setContextMenuPosition(null);
                          setAddMenuPosition(null);
                          setAddMenuOpen(!addMenuOpen);
                        }}
                      >
                        <Plus size={16} />
                      </button>
                      {addMenuOpen && typeof document !== 'undefined' && createPortal(
                        <div
                          ref={addMenuRef}
                          className="sidebar-add-menu"
                          role="menu"
                          tabIndex={-1}
                          style={{
                            left: addMenuPosition?.x ?? 0,
                            top: addMenuPosition?.y ?? 0,
                            visibility: addMenuPosition ? 'visible' : 'hidden',
                          }}
                        >
                          <button type="button" role="menuitem" onClick={() => beginCreate('file')}>
                            <FilePlus2 size={14} />
                            <span>{t('newMarkdownFile')}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => beginCreate('excalidraw')}>
                            <PencilRuler size={14} />
                            <span>{t('newExcalidrawFile')}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => beginCreate('folder')}>
                            <FolderPlus size={14} />
                            <span>{t('newFolder')}</span>
                          </button>
                        </div>,
                        document.body,
                      )}
                    </div>
                  )}
                  {selectedTarget && selectedTarget.kind !== 'root' && (
                    <button
                      type="button"
                      className="sidebar-icon-button"
                      aria-label={t('moreActions', { name: selectedTarget.name })}
                      aria-expanded={contextMenu?.target.path === selectedTarget.path}
                      aria-haspopup="menu"
                      disabled={disabled}
                      title={t('moreActions', { name: selectedTarget.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        openContextMenu(rect.right, rect.bottom + MENU_TRIGGER_GAP, selectedTarget, 'end');
                      }}
                    >
                      <Ellipsis size={16} />
                    </button>
                  )}
                  {workspaceRoot && (
                    <button
                      type="button"
                      className="sidebar-icon-button"
                      aria-label={t('refreshWorkspace')}
                      disabled={disabled}
                      title={t('refreshWorkspace')}
                      onClick={onRefreshWorkspace}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="sidebar-icon-button sidebar-collapse-toggle"
                aria-label={sidebarToggleLabel}
                title={sidebarToggleLabel}
                onClick={() => onCollapseChange(true)}
              >
                <ChevronLeft size={15} />
              </button>
            </div>
          </div>

          <div className="sidebar-tabs" role="tablist" aria-label={t('workspaceViews')}>
            <button
              ref={(element) => { sidebarTabRefs.current.files = element; }}
              id="workspace-files-tab"
              type="button"
              role="tab"
              className={sidebarView === 'files' ? 'sidebar-tab is-active' : 'sidebar-tab'}
              aria-controls="workspace-files-panel"
              aria-selected={sidebarView === 'files'}
              tabIndex={sidebarView === 'files' ? 0 : -1}
              onClick={() => selectSidebarView('files')}
              onKeyDown={(event) => handleSidebarTabNavigation(event, 'files')}
            >
              <FolderOpen size={14} />
              <span>{t('files')}</span>
            </button>
            <button
              ref={(element) => { sidebarTabRefs.current.outline = element; }}
              id="document-outline-tab"
              type="button"
              role="tab"
              className={sidebarView === 'outline' ? 'sidebar-tab is-active' : 'sidebar-tab'}
              aria-controls="document-outline-panel"
              aria-selected={sidebarView === 'outline'}
              tabIndex={sidebarView === 'outline' ? 0 : -1}
              onClick={() => selectSidebarView('outline')}
              onKeyDown={(event) => handleSidebarTabNavigation(event, 'outline')}
            >
              <ListTree size={14} />
              <span>{t('outline')}</span>
            </button>
          </div>

          <div
            id="workspace-files-panel"
            className="sidebar-panel"
            role="tabpanel"
            aria-labelledby="workspace-files-tab"
            hidden={sidebarView !== 'files'}
          >
              {rootTarget ? (
                <button
                  ref={rootButtonRef}
                  type="button"
                  className={[
                    'workspace-root',
                    selectedTarget?.kind === 'root' ? 'selected' : '',
                    dropTargetPath === rootTarget.path ? 'drop-target' : '',
                  ].filter(Boolean).join(' ')}
                  data-context-menu-target="workspace-root"
                  title={workspaceRoot ?? undefined}
                  aria-haspopup="menu"
                  onClick={() => setSelectedTarget(rootTarget)}
                  onContextMenu={openRootContextMenu}
                  onFocus={() => setSelectedTarget(rootTarget)}
                  onKeyDown={(event) => {
                    openRootContextMenuFromKeyboard(event);
                    if (!event.defaultPrevented && event.key === 'ArrowDown') {
                      event.preventDefault();
                      focusTreeRow('first');
                    }
                  }}
                >
                  <FolderOpen size={15} />
                  <span>{rootTarget.name}</span>
                </button>
              ) : null}

              <div
                ref={treeRef}
                className="file-tree"
                role="tree"
                tabIndex={-1}
                aria-label={t('workspaceFileTree')}
                onClick={(event) => {
                  if (event.target === event.currentTarget && rootTarget) setSelectedTarget(rootTarget);
                }}
                onContextMenu={handleTreeBackgroundContextMenu}
                onKeyDown={handleTreeNavigation}
              >
                {fileTree.length === 0 ? (
                  <div className="empty-sidebar">
                    <FolderOpen size={20} />
                    <span>{workspaceRoot ? t('folderEmpty') : t('noFolderOpen')}</span>
                  </div>
                ) : (
                  <FileTreeRows
                    activePath={activePath}
                    collapsedFolders={collapsedFolders}
                    disabled={disabled}
                    draggingPath={draggedTarget?.path ?? null}
                    dropTargetPath={dropTargetPath}
                    nodes={fileTree}
                    onBeginRename={beginRename}
                    onCancelRename={() => setRenamingPath(null)}
                    onCommitRename={(target, name) => {
                      setRenamingPath(null);
                      onRenameEntry(target.path, name, target.kind);
                    }}
                    onDeleteEntry={requestDelete}
                    onOpenContextMenu={openContextMenu}
                    onOpenFile={onOpenFile}
                    onSelectTarget={setSelectedTarget}
                    onToggleFolder={onToggleFolder}
                    renamingPath={renamingPath}
                    selectedPath={selectedTarget?.path ?? activePath ?? workspaceRoot}
                  />
                )}
              </div>

              {contextMenu && typeof document !== 'undefined' && createPortal(
                <div
                  ref={contextMenuRef}
                  className="file-tree-context-menu"
                  role="menu"
                  tabIndex={-1}
                  style={{
                    left: contextMenuPosition?.x ?? 0,
                    top: contextMenuPosition?.y ?? 0,
                    visibility: contextMenuPosition ? 'visible' : 'hidden',
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {getFileTreeContextMenuItems(contextMenu.target, {
                    canInsertWorkspaceAsset: Boolean(onInsertWorkspaceAsset),
                  }).map((item) => (
                    <button
                      key={item.action}
                      type="button"
                      role="menuitem"
                      className={[
                        'context-menu-item',
                        item.danger ? 'danger' : '',
                        item.separatorBefore ? 'separator-before' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={disabled}
                      onClick={() => runContextAction(item.action)}
                    >
                      <ContextMenuIcon action={item.action} />
                      <span>{item.action === 'create-file' ? t('newMarkdownFile') : item.action === 'create-folder' ? t('newFolder') : item.action === 'refresh' ? t('refreshWorkspace') : item.action === 'rename' ? t('rename') : item.action === 'move' ? `${t('move')}…` : item.action === 'delete' ? t('delete') : item.action === 'insert-at-cursor' ? t('insertAtCurrentCursor') : t('openDocument')}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  ))}
                </div>,
                document.body,
              )}
          </div>
          <div
            id="document-outline-panel"
            className="sidebar-panel outline-panel"
            role="tabpanel"
            aria-labelledby="document-outline-tab"
            hidden={sidebarView !== 'outline'}
          >
              {outlineItems.length === 0 ? (
                <div className="empty-sidebar">
                  <ListTree size={20} />
                  <span>{t('noHeadings')}</span>
                </div>
              ) : (
                <div
                  className="outline-tree"
                  role="tree"
                  tabIndex={-1}
                  aria-label={t('documentOutline')}
                  onKeyDown={handleOutlineTreeNavigation}
                >
                  {outlineItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="treeitem"
                      className={selectedOutlineId === item.id ? 'outline-item is-selected' : 'outline-item'}
                      aria-level={item.depth + 1}
                      aria-selected={selectedOutlineId === item.id}
                      data-outline-heading-id={item.id}
                      style={{ paddingLeft: `${7 + item.depth * 14}px` }}
                      tabIndex={selectedOutlineId === item.id || (!selectedOutlineId && item.ordinal === 0) ? 0 : -1}
                      onClick={() => selectOutlineItem(item)}
                    >
                      <span className="outline-item-level">H{item.level}</span>
                      <span className="outline-item-label">{item.text}</span>
                    </button>
                  ))}
                </div>
              )}
          </div>
        </>
      )}
    </aside>
  );
}
