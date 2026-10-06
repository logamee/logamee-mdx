import type { KeyboardEvent, MouseEvent } from 'react';
import type { FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import { canRenameFileTreeTarget } from '../../lib/fileTreeContextMenu';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';

export type WorkspaceTreeTarget = Exclude<FileTreeContextTarget, { kind: 'root' }>;

export interface FileTreeRowsProps {
  activePath: string | null;
  collapsedFolders: Set<string>;
  depth?: number;
  disabled?: boolean;
  draggingPath: string | null;
  dropTargetPath: string | null;
  nodes: WorkspaceFileTreeNode[];
  onBeginRename: (target: WorkspaceTreeTarget) => void;
  onCancelRename: () => void;
  onCommitRename: (target: WorkspaceTreeTarget, name: string) => void;
  onDeleteEntry: (target: WorkspaceTreeTarget) => void;
  onOpenContextMenu: (x: number, y: number, target: FileTreeContextTarget) => void;
  onOpenFile: (path: string) => void;
  onSelectTarget: (target: WorkspaceTreeTarget) => void;
  onToggleFolder: (path: string) => void;
  renamingPath: string | null;
  selectedPath: string | null;
}

export function openMouseContextMenu(
  event: MouseEvent,
  target: FileTreeContextTarget,
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'],
) {
  event.preventDefault();
  event.stopPropagation();
  onOpenContextMenu(event.clientX, event.clientY, target);
}

function openKeyboardContextMenu(
  event: KeyboardEvent<HTMLElement>,
  target: FileTreeContextTarget,
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'],
) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  onOpenContextMenu(rect.left + 20, rect.bottom + 4, target);
  return true;
}

export interface TreeRowKeyActions {
  collapsed: boolean;
  contextTarget: WorkspaceTreeTarget;
  disabled: boolean;
  node: WorkspaceFileTreeNode;
  onBeginRename: FileTreeRowsProps['onBeginRename'];
  onDeleteEntry: FileTreeRowsProps['onDeleteEntry'];
  onOpenContextMenu: FileTreeRowsProps['onOpenContextMenu'];
  onOpenFile: FileTreeRowsProps['onOpenFile'];
  onToggleFolder: FileTreeRowsProps['onToggleFolder'];
}

// 树行键盘分派：右键菜单/重命名/删除/打开/文件夹方向键逐级尝试。
export function handleTreeRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, actions: TreeRowKeyActions): void {
  if (event.target instanceof HTMLInputElement) return;
  if (actions.disabled) return;
  if (openKeyboardContextMenu(event, actions.contextTarget, actions.onOpenContextMenu)) return;
  if (treeRowRenameKeyActivates(event, actions.contextTarget, actions.onBeginRename)) return;
  if (treeRowDeleteKeyActivates(event, actions.contextTarget, actions.onDeleteEntry)) return;
  if (treeRowOpenKeyActivates(event, actions.contextTarget, actions.onOpenFile)) return;
  treeRowFolderArrowToggles(event, actions);
}

function treeRowRenameKeyActivates(
  event: React.KeyboardEvent<HTMLDivElement>,
  contextTarget: WorkspaceTreeTarget,
  onBeginRename: TreeRowKeyActions['onBeginRename'],
): boolean {
  if ((event.key !== 'Enter' && event.key !== 'F2') || !canRenameFileTreeTarget(contextTarget)) return false;
  event.preventDefault();
  onBeginRename(contextTarget);
  return true;
}

function treeRowDeleteKeyActivates(
  event: React.KeyboardEvent<HTMLDivElement>,
  contextTarget: WorkspaceTreeTarget,
  onDeleteEntry: TreeRowKeyActions['onDeleteEntry'],
): boolean {
  if (!event.metaKey || (event.key !== 'Backspace' && event.key !== 'Delete')) return false;
  event.preventDefault();
  onDeleteEntry(contextTarget);
  return true;
}

function treeRowOpenKeyActivates(
  event: React.KeyboardEvent<HTMLDivElement>,
  contextTarget: WorkspaceTreeTarget,
  onOpenFile: TreeRowKeyActions['onOpenFile'],
): boolean {
  const opensFile = (event.metaKey && event.key.toLowerCase() === 'o')
    || event.key === ' ';
  if (!opensFile || contextTarget.kind !== 'file') return false;
  event.preventDefault();
  onOpenFile(contextTarget.path);
  return true;
}

function treeRowFolderArrowToggles(event: React.KeyboardEvent<HTMLDivElement>, actions: TreeRowKeyActions): void {
  if (actions.contextTarget.kind !== 'folder') return;
  if (event.key === 'ArrowRight' && actions.collapsed) {
    event.preventDefault();
    actions.onToggleFolder(actions.node.path);
    return;
  }
  if (event.key === 'ArrowLeft' && !actions.collapsed) {
    event.preventDefault();
    actions.onToggleFolder(actions.node.path);
  }
}
