import { canMoveWorkspaceEntry, isSameOrDescendantPath } from './fileTreeOperations';

export type FileTreeClipboardMode = 'copy' | 'cut';

export interface FileTreeClipboardItem {
  mode: FileTreeClipboardMode;
  path: string;
  isFile: boolean;
}

export function workspaceParentPath(path: string): string | null {
  const index = path.lastIndexOf('/');
  if (index <= 0) return null;
  return path.slice(0, index);
}

// Cut mirrors a move: pasting back into the source's own folder is a no-op and
// pasting a folder into its own descendant is rejected. Copy allows the same
// folder (the backend derives a free " copy" name) but never a folder into its
// own descendant.
export function canPasteFileTreeClipboard(
  clipboard: FileTreeClipboardItem | null,
  destinationParentPath: string,
): boolean {
  if (!clipboard) return false;
  if (clipboard.mode === 'cut') {
    return canMoveWorkspaceEntry({
      destinationParentPath,
      sourceKind: clipboard.isFile ? 'file' : 'folder',
      sourcePath: clipboard.path,
    });
  }
  if (clipboard.isFile) return true;
  return !isSameOrDescendantPath(destinationParentPath, clipboard.path);
}
