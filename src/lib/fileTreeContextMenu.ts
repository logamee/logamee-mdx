export type FileTreeContextTargetKind = 'file' | 'folder' | 'root';

import type { WorkspaceFileKind } from '../types';
import { isMarkdownWorkspaceReferenceKind } from './markdownMedia';

export type FileTreeContextTarget =
  | { kind: 'root'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string }
  | { fileKind: WorkspaceFileKind; kind: 'file'; name: string; path: string };

export type FileTreeContextAction = 'create-file' | 'create-folder' | 'delete' | 'insert-at-cursor' | 'move' | 'open' | 'refresh' | 'rename';

interface FileTreeContextMenuOptions {
  canInsertWorkspaceAsset?: boolean;
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
  if (target.kind === 'root') {
    return [
      { action: 'create-file', label: 'New Markdown File' },
      { action: 'create-folder', label: 'New Folder' },
      { action: 'refresh', label: 'Refresh', separatorBefore: true, shortcut: '⌘R' },
    ];
  }

  if (target.kind === 'folder') {
    return [
      { action: 'create-file', label: 'New Markdown File' },
      { action: 'create-folder', label: 'New Folder' },
      { action: 'rename', label: 'Rename', separatorBefore: true, shortcut: 'Return' },
      { action: 'move', label: 'Move…' },
      { action: 'delete', danger: true, label: 'Move to Trash', separatorBefore: true, shortcut: '⌘⌫' },
    ];
  }

  const items: FileTreeContextMenuItem[] = [
    { action: 'open', label: 'Open', shortcut: '⌘O' },
  ];
  if (options.canInsertWorkspaceAsset && isMarkdownWorkspaceReferenceKind(target.fileKind)) {
    items.push({ action: 'insert-at-cursor', label: 'Insert at Current Cursor' });
  }
  if (canRenameFileTreeTarget(target)) {
    items.push({ action: 'rename', label: 'Rename', separatorBefore: true, shortcut: 'Return' });
  }
  items.push({ action: 'move', label: 'Move…', separatorBefore: !canRenameFileTreeTarget(target) });
  items.push({ action: 'delete', danger: true, label: 'Move to Trash', separatorBefore: true, shortcut: '⌘⌫' });
  return items;
}
