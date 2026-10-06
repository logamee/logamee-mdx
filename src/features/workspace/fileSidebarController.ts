import { useFileSidebarActions } from './fileSidebarActions';
import { useFileSidebarDrag, useFileSidebarDragState } from './fileSidebarDragState';
import { useFileSidebarSelection, useFileSidebarTree, useFileSidebarViews } from './fileSidebarInteraction';
import {
  useFileSidebarMenuDismissal,
  useFileSidebarMenuPositioning,
  useFileSidebarMenuState,
  useFileSidebarMenuTriggers,
} from './fileSidebarMenuState';
import type { FileSidebarProps } from './fileSidebarTypes';

// FileSidebar 控制器：按域组合交互子钩子，视图区块从返回对象取状态与回调。
export function useFileSidebarController(props: FileSidebarProps) {
  const selection = useFileSidebarSelection(props);
  const menuState = useFileSidebarMenuState(props, selection);
  useFileSidebarMenuPositioning(menuState);
  useFileSidebarMenuDismissal(menuState);
  const menus = useFileSidebarMenuTriggers(selection, menuState);
  const dragState = useFileSidebarDragState(props, selection, menuState);
  const drag = useFileSidebarDrag(props, selection, menuState, dragState);
  const actions = useFileSidebarActions(props, selection, menuState, drag);
  const views = useFileSidebarViews(props, selection, menuState);
  const tree = useFileSidebarTree(props, selection, menus, drag);
  return { props, selection, menuState, menus, drag, actions, views, tree };
}

export type FileSidebarController = ReturnType<typeof useFileSidebarController>;
