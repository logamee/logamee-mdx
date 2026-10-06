import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import { FLOATING_MENU_VIEWPORT_MARGIN, getFloatingMenuPosition } from '../../lib/floatingMenuPosition';
import type { FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import type { MenuPosition } from './fileSidebarIcon';
import { getMenuSize } from './fileSidebarHelpers';
import type {
  ContextMenuState,
  FileSidebarMenuState,
  FileSidebarMenus,
  FileSidebarProps,
  FileSidebarSelection,
} from './fileSidebarTypes';

const MENU_TRIGGER_GAP = 4;
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// 菜单基础状态：右键菜单与添加菜单的开关、定位状态与宿主元素引用。
export function useFileSidebarMenuState(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
): FileSidebarMenuState {
  const { disabled } = props;
  const { setSelectedTarget } = selection;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<MenuPosition | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<MenuPosition | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const closeMenus = useCallback(() => {
    setContextMenu(null);
    setContextMenuPosition(null);
    setAddMenuOpen(false);
    setAddMenuPosition(null);
  }, []);

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
  }, [disabled, setSelectedTarget]);

  return {
    addMenuButtonRef, addMenuOpen, addMenuPosition, addMenuRef, closeMenus,
    contextMenu, contextMenuPosition, contextMenuRef, openContextMenu,
    setAddMenuOpen, setAddMenuPosition, setContextMenu, setContextMenuPosition, sidebarRef,
  };
}

// 菜单定位：挂载后按锚点与视口边界计算浮动菜单位置。
export function useFileSidebarMenuPositioning(menus: FileSidebarMenuState): void {
  const { addMenuButtonRef, addMenuOpen, addMenuRef, setAddMenuPosition, sidebarRef } = menus;
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
  }, [addMenuButtonRef, addMenuOpen, addMenuRef, setAddMenuPosition, sidebarRef]);

  const { contextMenu, contextMenuRef, setContextMenuPosition } = menus;
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
  }, [contextMenu, contextMenuRef, setContextMenuPosition]);
}

// 菜单外关闭：任一菜单打开时监听点击/失焦/Esc/视口缩放并统一关闭。
export function useFileSidebarMenuDismissal(menus: FileSidebarMenuState): void {
  const { addMenuOpen, closeMenus, contextMenu } = menus;
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
}

// 菜单触发器：根目录右键/键盘菜单、添加菜单开关与选中目标的"更多"菜单。
export function useFileSidebarMenuTriggers(
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
): FileSidebarMenus {
  const { rootTarget, selectedTarget } = selection;
  const {
    addMenuOpen,
    openContextMenu,
    setAddMenuOpen,
    setAddMenuPosition,
    setContextMenu,
    setContextMenuPosition,
  } = menus;

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

  const toggleAddMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setContextMenu(null);
    setContextMenuPosition(null);
    setAddMenuPosition(null);
    setAddMenuOpen(!addMenuOpen);
  }, [addMenuOpen, setAddMenuOpen, setAddMenuPosition, setContextMenu, setContextMenuPosition]);

  const openSelectedTargetMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (!selectedTarget) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu(rect.right, rect.bottom + MENU_TRIGGER_GAP, selectedTarget, 'end');
  }, [openContextMenu, selectedTarget]);

  return { openRootContextMenu, openRootContextMenuFromKeyboard, openSelectedTargetMenu, toggleAddMenu };
}
