import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  FileText,
  FolderInput,
  FolderPlus,
  FolderSearch,
  Pencil,
  RefreshCw,
  Scissors,
  TextCursorInput,
  Trash2 } from 'lucide-react';
import type { FileTreeContextAction } from '../../lib/fileTreeContextMenu';

export interface MenuPosition {
  x: number;
  y: number;
}

const CONTEXT_MENU_ICONS: Record<FileTreeContextAction, React.ReactNode> = {
  'create-file': <FilePlus2 size={14} />,
  'create-folder': <FolderPlus size={14} />,
  'open': <FileText size={14} />,
  'insert-at-cursor': <TextCursorInput size={14} />,
  'refresh': <RefreshCw size={14} />,
  'rename': <Pencil size={14} />,
  'move': <FolderInput size={14} />,
  'copy': <Copy size={14} />,
  'cut': <Scissors size={14} />,
  'paste': <ClipboardPaste size={14} />,
  'reveal': <FolderSearch size={14} />,
  'delete': <Trash2 size={14} />,
};

export function ContextMenuIcon({ action }: { action: FileTreeContextAction }) {
  return CONTEXT_MENU_ICONS[action];
}
