import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  canPasteFileTreeClipboard,
  workspaceParentPath,
  type FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { } from '../../lib/fileTreeContextMenu';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';

export interface TreeNavigationContext {
  clipboard: FileTreeClipboardItem | null;
  fileTreeRef: { current: WorkspaceFileTreeNode[] };
  onCopyEntry: ((target: WorkspaceTreeTarget) => void) | undefined;
  onCutEntry: ((target: WorkspaceTreeTarget) => void) | undefined;
  onPasteEntry: ((destinationParentPath: string) => void) | undefined;
  rootButtonRef: { current: HTMLButtonElement | null };
}

// 文件树键盘导航：Ctrl/Cmd+C/X/V 走剪贴板语义（含文件夹目的地判定），
// 无修饰时在树行与根按钮之间移动焦点（ArrowUp/Down/Home/End）。
export function handleTreeNavigationBody(
  event: ReactKeyboardEvent<HTMLDivElement>,
  ctx: TreeNavigationContext,
): void {
  if (event.defaultPrevented || event.target instanceof HTMLInputElement) return;
  if (event.metaKey || event.ctrlKey) {
    dispatchClipboardShortcut(event, ctx);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  if (rows.length === 0) return;
  moveTreeFocus(event, rows, ctx.rootButtonRef);
}

// 修饰键分派：命中树行且按键为 c/x/v 时交给剪贴板语义。
function dispatchClipboardShortcut(event: ReactKeyboardEvent<HTMLDivElement>, ctx: TreeNavigationContext): void {
  const key = event.key.toLowerCase();
  const target = treeShortcutTarget(event);
  if (target && (key === 'c' || key === 'x' || key === 'v')) {
    applyClipboardShortcut(event, ctx, key, target);
  }
}

// 目标行下标：Home/End 跳端，ArrowDown 步进，ArrowUp 在首行之上下沉到 -1。
function nextTreeFocusIndex(key: string, currentIndex: number, rowCount: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return rowCount - 1;
  if (key === 'ArrowDown') return Math.min(currentIndex + 1, rowCount - 1);
  return currentIndex - 1;
}

// 焦点移动：计算目标行，首行之上回到根按钮，其余聚焦并滚动可见。
function moveTreeFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  rows: HTMLElement[],
  rootButtonRef: { current: HTMLButtonElement | null },
): void {
  const currentIndex = rows.findIndex((row) => row === document.activeElement);
  const nextIndex = nextTreeFocusIndex(event.key, currentIndex, rows.length);
  if (nextIndex < 0) {
    event.preventDefault();
    rootButtonRef.current?.focus();
    return;
  }
  if (nextIndex === currentIndex) return;
  event.preventDefault();
  rows[nextIndex]?.focus();
  rows[nextIndex]?.scrollIntoView?.({ block: 'nearest' });
}

function treeShortcutTarget(event: ReactKeyboardEvent<HTMLDivElement>): { path: string; kind: string } | null {
  const row = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[role="treeitem"]')
    : null;
  const path = row?.dataset.treeEntryPath;
  const kind = row?.dataset.contextMenuTarget;
  if (path && (kind === 'file' || kind === 'folder')) return { path, kind };
  return null;
}

function applyClipboardShortcut(
  event: ReactKeyboardEvent<HTMLDivElement>,
  ctx: TreeNavigationContext,
  key: string,
  target: { path: string; kind: string },
): void {
  const resolved = findTreeTarget(ctx.fileTreeRef.current, target.path);
  if (!resolved) return;
  if (key === 'v') {
    applyPasteShortcut(event, ctx, target);
    return;
  }
  applyCopyCutShortcut(event, ctx, key, resolved as WorkspaceTreeTarget);
}

// 复制/剪切：命中回调即拦截按键并下发目标。
function applyCopyCutShortcut(
  event: ReactKeyboardEvent<HTMLDivElement>,
  ctx: TreeNavigationContext,
  key: string,
  resolved: WorkspaceTreeTarget,
): void {
  const handler = key === 'c' ? ctx.onCopyEntry : ctx.onCutEntry;
  if (!handler) return;
  event.preventDefault();
  handler(resolved);
}

// 粘贴：文件目标落到父目录，剪贴板可接收时拦截下发。
function applyPasteShortcut(
  event: ReactKeyboardEvent<HTMLDivElement>,
  ctx: TreeNavigationContext,
  target: { path: string; kind: string },
): void {
  if (!ctx.onPasteEntry) return;
  const destination = target.kind === 'folder' ? target.path : workspaceParentPath(target.path);
  if (destination && canPasteFileTreeClipboard(ctx.clipboard, destination)) {
    event.preventDefault();
    ctx.onPasteEntry(destination);
  }
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
