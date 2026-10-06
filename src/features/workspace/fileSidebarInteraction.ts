import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import type { FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import type { MarkdownOutlineItem } from '../../lib/markdownOutline';
import { navigateOutlineTree, nextSidebarView, pathName } from './fileSidebarHelpers';
import { findTreeTarget } from './fileSidebarTargets';
import { handleTreeNavigationBody } from './fileSidebarTreeNavigation';
import type {
  FileSidebarDrag,
  FileSidebarMenuState,
  FileSidebarMenus,
  FileSidebarProps,
  FileSidebarSelection,
  FileSidebarTree,
  FileSidebarViews,
  SidebarView,
} from './fileSidebarTypes';

// 树内选中态：跟随 activePath 同步选中目标；工作区关闭或目标消失时复位。
export function useFileSidebarSelection(props: FileSidebarProps): FileSidebarSelection {
  const { activePath, fileTree, workspaceRoot } = props;
  const [selectedTarget, setSelectedTarget] = useState<FileTreeContextTarget | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const rootButtonRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
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

  return {
    renamingPath,
    rootButtonRef,
    rootTarget,
    selectedTarget,
    setRenamingPath,
    setSelectedTarget,
    treeRef,
  };
}

// 视图切换：文件/大纲选项卡状态、键盘往返与大纲选中项维护。
export function useFileSidebarViews(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
): FileSidebarViews {
  const { activePath, onSelectOutlineItem = () => undefined, outlineItems = [] } = props;
  const { setRenamingPath } = selection;
  const { setAddMenuOpen, setContextMenu } = menus;
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null);
  const sidebarTabRefs = useRef<Record<SidebarView, HTMLButtonElement | null>>({ files: null, outline: null });

  useEffect(() => {
    setSelectedOutlineId((current) => (
      outlineItems.some((item) => item.id === current) ? current : null
    ));
  }, [outlineItems]);

  useEffect(() => { setSelectedOutlineId(null); }, [activePath]);

  const selectSidebarView = useCallback((view: SidebarView) => {
    setSidebarView(view);
    setContextMenu(null);
    setAddMenuOpen(false);
    if (view === 'outline') setRenamingPath(null);
  }, [setAddMenuOpen, setContextMenu, setRenamingPath]);

  const handleSidebarTabNavigation = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentView: SidebarView,
  ) => {
    const nextView = nextSidebarView(event.key, currentView);
    if (!nextView) return;
    event.preventDefault();
    selectSidebarView(nextView);
    sidebarTabRefs.current[nextView]?.focus();
  }, [selectSidebarView]);

  const selectOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    setSelectedOutlineId(item.id);
    onSelectOutlineItem(item);
  }, [onSelectOutlineItem]);

  return {
    handleOutlineTreeNavigation: navigateOutlineTree, handleSidebarTabNavigation,
    selectOutlineItem, selectSidebarView, selectedOutlineId, sidebarTabRefs, sidebarView,
  };
}

// 树键盘与背景交互：Ctrl+C/X/V 剪贴板快捷键、方向键焦点移动与背景右键根菜单。
export function useFileSidebarTree(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenus,
  drag: FileSidebarDrag,
): FileSidebarTree {
  const { clipboard = null, onCopyEntry, onCutEntry, onPasteEntry } = props;
  const { rootButtonRef, rootTarget, treeRef } = selection;
  const { openRootContextMenu } = menus;
  const { fileTreeRef } = drag;

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
  }, [treeRef]);

  const handleTreeNavigation = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    handleTreeNavigationBody(event, {
      clipboard,
      fileTreeRef,
      onCopyEntry,
      onCutEntry,
      onPasteEntry,
      rootButtonRef,
    });
  }, [clipboard, fileTreeRef, onCopyEntry, onCutEntry, onPasteEntry, rootButtonRef]);

  return { focusTreeRow, handleTreeBackgroundContextMenu, handleTreeNavigation };
}
