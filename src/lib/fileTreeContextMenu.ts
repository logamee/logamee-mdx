
import type { WorkspaceFileKind } from '../types';
import { isMarkdownWorkspaceReferenceKind } from './markdownMedia';

export type FileTreeContextTarget =
  | { kind: 'root'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string }
  | { fileKind: WorkspaceFileKind; kind: 'file'; name: string; path: string };

export type FileTreeContextAction =
  | 'copy'
  | 'create-file'
  | 'create-folder'
  | 'cut'
  | 'delete'
  | 'insert-at-cursor'
  | 'move'
  | 'open'
  | 'paste'
  | 'refresh'
  | 'rename'
  | 'reveal';

interface FileTreeContextMenuOptions {
  canInsertWorkspaceAsset?: boolean;
  canPaste?: boolean;
}

export interface FileTreeContextMenuItem {
  action: FileTreeContextAction;
  danger?: boolean;
  label: string;
  separatorBefore?: boolean;
  shortcut?: string;
}

export function canRenameFileTreeTarget(target: FileTreeContextTarget): boolean {
  return target.kind !== 'root'
    && (target.kind === 'folder' || (target.fileKind !== 'pdf' && target.fileKind !== 'docx'));
}

export function getFileTreeContextMenuItems(
  target: FileTreeContextTarget,
  options: FileTreeContextMenuOptions = {},
): FileTreeContextMenuItem[] {
  if (target.kind === 'root') return rootContextMenuItems(options);
  if (target.kind === 'folder') return folderContextMenuItems(options);
  return fileContextMenuItems(target, options);
}

// 工作区根菜单：新建两项 + 可选粘贴 + 刷新。
function rootContextMenuItems(options: FileTreeContextMenuOptions): FileTreeContextMenuItem[] {
  const items: FileTreeContextMenuItem[] = [
    { action: 'create-file', label: 'New Markdown File' },
    { action: 'create-folder', label: 'New Folder' },
  ];
  if (options.canPaste) items.push({ action: 'paste', label: 'Paste', shortcut: '⌘V' });
  items.push({ action: 'refresh', label: 'Refresh', separatorBefore: true, shortcut: '⌘R' });
  return items;
}

// 文件夹菜单：新建/重命名/剪贴板 + 移动/显示/删除。
function folderContextMenuItems(options: FileTreeContextMenuOptions): FileTreeContextMenuItem[] {
  const items: FileTreeContextMenuItem[] = [
    { action: 'create-file', label: 'New Markdown File' },
    { action: 'create-folder', label: 'New Folder' },
    { action: 'rename', label: 'Rename', separatorBefore: true, shortcut: 'Return' },
    { action: 'copy', label: 'Copy', shortcut: '⌘C' },
    { action: 'cut', label: 'Cut', shortcut: '⌘X' },
  ];
  if (options.canPaste) items.push({ action: 'paste', label: 'Paste', shortcut: '⌘V' });
  items.push(
    { action: 'move', label: 'Move…' },
    { action: 'reveal', label: 'Reveal in Finder' },
    { action: 'delete', danger: true, label: 'Move to Trash', separatorBefore: true, shortcut: '⌘⌫' },
  );
  return items;
}

// 文件菜单：打开 + 条件插入光标/重命名，其余与文件夹一致。
function fileContextMenuItems(
  target: Extract<FileTreeContextTarget, { kind: 'file' }>,
  options: FileTreeContextMenuOptions,
): FileTreeContextMenuItem[] {
  const canRename = canRenameFileTreeTarget(target);
  const items: FileTreeContextMenuItem[] = [
    { action: 'open', label: 'Open', shortcut: '⌘O' },
  ];
  if (options.canInsertWorkspaceAsset && isMarkdownWorkspaceReferenceKind(target.fileKind)) {
    items.push({ action: 'insert-at-cursor', label: 'Insert at Current Cursor' });
  }
  if (canRename) items.push({ action: 'rename', label: 'Rename', separatorBefore: true, shortcut: 'Return' });
  items.push(
    { action: 'copy', label: 'Copy', separatorBefore: !canRename, shortcut: '⌘C' },
    { action: 'cut', label: 'Cut', shortcut: '⌘X' },
  );
  if (options.canPaste) items.push({ action: 'paste', label: 'Paste', shortcut: '⌘V' });
  items.push(
    { action: 'move', label: 'Move…', separatorBefore: !canRename },
    { action: 'reveal', label: 'Reveal in Finder' },
    { action: 'delete', danger: true, label: 'Move to Trash', separatorBefore: true, shortcut: '⌘⌫' },
  );
  return items;
}
