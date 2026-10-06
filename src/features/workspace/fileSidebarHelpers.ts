import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { WorkspaceFileEntry } from '../../types';
import { findTreeTarget, findWorkspaceFileEntry } from './fileSidebarTargets';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';

export function pathName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export function getMenuSize(menu: HTMLElement): { height: number; width: number } {
  const rect = menu.getBoundingClientRect();
  return {
    height: menu.offsetHeight || rect.height,
    width: menu.offsetWidth || rect.width,
  };
}

// 指针落点媒体资产判定：源行是可插入媒体且落点处于编辑器媒体投放区时返回资产。
export function mediaAssetAtPointer(
  source: WorkspaceTreeTarget,
  clientX: number,
  clientY: number,
  ctx: { canInsert: boolean; fileTree: WorkspaceFileTreeNode[] },
): WorkspaceFileEntry | null {
  if (!mediaDropCandidate(source, ctx.canInsert)) return null;
  const hit = typeof document.elementFromPoint === 'function'
    ? document.elementFromPoint(clientX, clientY)
    : null;
  if (!(hit instanceof Element) || !hit.closest('[data-markdown-media-drop-target]')) return null;
  const asset = findWorkspaceFileEntry(ctx.fileTree, source.path);
  return insertableMediaAsset(asset);
}

function mediaDropCandidate(source: WorkspaceTreeTarget, canInsert: boolean): boolean {
  return canInsert
    && source.kind === 'file'
    && (source.fileKind === 'image' || source.fileKind === 'audio' || source.fileKind === 'video');
}

function insertableMediaAsset(asset: WorkspaceFileEntry | null): WorkspaceFileEntry | null {
  return asset?.kind === 'image' || asset?.kind === 'audio' || asset?.kind === 'video' ? asset : null;
}

// 按下命中判定：主键按在非交互控件的树行上（且不在重命名态）才允许启动拖拽。
export function draggableTreeRow(
  event: ReactPointerEvent<HTMLElement>,
  disabled: boolean,
  fileTree: WorkspaceFileTreeNode[],
): { element: HTMLElement; source: WorkspaceTreeTarget } | null {
  if (disabled || !primaryPointerOnTreeRow(event)) return null;
  const row = event.target instanceof Element
    ? event.target.closest<HTMLElement>('.tree-row[data-tree-entry-path]')
    : null;
  const path = row?.dataset.treeEntryPath;
  const source = path ? findTreeTarget(fileTree, path) : null;
  if (!row || !source || row.classList.contains('renaming')) return null;
  return { element: row, source };
}

function primaryPointerOnTreeRow(event: ReactPointerEvent<HTMLElement>): boolean {
  if (event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return false;
  return !event.target.closest('button, input, select, textarea');
}

// 指针落点父目录判定：树行（仅文件夹）/分支子区/根区/树背景分别解析目的地。
export function pointerDropDestination(clientX: number, clientY: number, workspaceRoot: string): string | null {
  if (typeof document.elementFromPoint !== 'function') return null;
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
}

export function nextSidebarView(key: string, currentView: 'files' | 'outline'): 'files' | 'outline' | null {
  if (key === 'Home') return 'files';
  if (key === 'End') return 'outline';
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp') {
    return currentView === 'files' ? 'outline' : 'files';
  }
  return null;
}

// 大纲树键盘导航：ArrowUp/Down/Home/End 在大纲项之间移动焦点并滚动到可视区。
export function navigateOutlineTree(event: ReactKeyboardEvent<HTMLDivElement>): void {
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
}
