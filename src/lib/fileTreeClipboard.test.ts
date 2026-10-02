import { describe, expect, it } from 'vitest';
import {
  canPasteFileTreeClipboard,
  workspaceParentPath,
  type FileTreeClipboardItem,
} from './fileTreeClipboard';

describe('workspaceParentPath', () => {
  it('returns the parent segment of a workspace path', () => {
    expect(workspaceParentPath('/ws/notes/a.md')).toBe('/ws/notes');
    expect(workspaceParentPath('/ws/a.md')).toBe('/ws');
  });

  it('returns null for root-level or malformed paths', () => {
    expect(workspaceParentPath('/ws')).toBeNull();
    expect(workspaceParentPath('')).toBeNull();
    expect(workspaceParentPath('relative/a.md')).toBe('relative');
  });
});

describe('canPasteFileTreeClipboard', () => {
  const copiedFile: FileTreeClipboardItem = { mode: 'copy', path: '/ws/notes/a.md', isFile: true };
  const copiedFolder: FileTreeClipboardItem = { mode: 'copy', path: '/ws/notes', isFile: false };

  it('rejects pasting with an empty clipboard', () => {
    expect(canPasteFileTreeClipboard(null, '/ws')).toBe(false);
  });

  it('allows copying a file into any folder including its own', () => {
    expect(canPasteFileTreeClipboard(copiedFile, '/ws/notes')).toBe(true);
    expect(canPasteFileTreeClipboard(copiedFile, '/ws')).toBe(true);
  });

  it('allows copying a folder into other folders but not into itself', () => {
    expect(canPasteFileTreeClipboard(copiedFolder, '/ws')).toBe(true);
    expect(canPasteFileTreeClipboard(copiedFolder, '/ws/notes')).toBe(false);
    expect(canPasteFileTreeClipboard(copiedFolder, '/ws/notes/inner')).toBe(false);
  });

  it('treats cut like a move and rejects pasting into the source folder', () => {
    const cutFile: FileTreeClipboardItem = { mode: 'cut', path: '/ws/notes/a.md', isFile: true };
    const cutFolder: FileTreeClipboardItem = { mode: 'cut', path: '/ws/notes', isFile: false };
    expect(canPasteFileTreeClipboard(cutFile, '/ws/notes')).toBe(false);
    expect(canPasteFileTreeClipboard(cutFile, '/ws')).toBe(true);
    expect(canPasteFileTreeClipboard(cutFolder, '/ws/notes')).toBe(false);
    // Pasting a cut folder back into its own parent is the same path, a no-op.
    expect(canPasteFileTreeClipboard(cutFolder, '/ws')).toBe(false);
  });
});
