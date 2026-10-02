import { describe, expect, it } from 'vitest';
import { getFileTreeContextMenuItems, type FileTreeContextTarget } from './fileTreeContextMenu';

describe('file tree context menu model', () => {
  it('shows create actions for workspace root', () => {
    const target: FileTreeContextTarget = { kind: 'root', name: 'workspace root', path: '/workspace' };
    expect(getFileTreeContextMenuItems(target).map((item) => item.action)).toEqual(['create-file', 'create-folder', 'refresh']);
  });

  it('shows paste and reveal for the workspace root when paste is available', () => {
    const target: FileTreeContextTarget = { kind: 'root', name: 'workspace root', path: '/workspace' };
    const items = getFileTreeContextMenuItems(target, { canPaste: true });
    expect(items.map((item) => item.action)).toEqual(['create-file', 'create-folder', 'paste', 'refresh']);
    expect(items.find((item) => item.action === 'paste')?.shortcut).toBe('⌘V');
  });

  it('shows clipboard, move, and destructive actions for folders', () => {
    const target: FileTreeContextTarget = { kind: 'folder', name: 'notes', path: '/workspace/notes' };
    const items = getFileTreeContextMenuItems(target, { canPaste: true });
    expect(items.map((item) => item.action)).toEqual([
      'create-file',
      'create-folder',
      'rename',
      'copy',
      'cut',
      'paste',
      'move',
      'reveal',
      'delete',
    ]);
    expect(items.find((item) => item.action === 'delete')?.label).toBe('Move to Trash');
    expect(items.find((item) => item.action === 'copy')?.shortcut).toBe('⌘C');
    expect(items.find((item) => item.action === 'cut')?.shortcut).toBe('⌘X');
  });

  it('shows open, clipboard, and destructive actions for files', () => {
    const target: FileTreeContextTarget = { fileKind: 'markdown', kind: 'file', name: 'draft.md', path: '/workspace/draft.md' };
    const items = getFileTreeContextMenuItems(target, { canPaste: true });
    expect(items.map((item) => item.action)).toEqual([
      'open',
      'rename',
      'copy',
      'cut',
      'paste',
      'move',
      'reveal',
      'delete',
    ]);
    expect(items.find((item) => item.action === 'delete')?.label).toBe('Move to Trash');
  });

  it.each([
    ['image', 'cover.png'],
    ['audio', 'intro.mp3'],
    ['html', 'demo.html'],
    ['excalidraw', 'diagram.excalidraw'],
  ] as const)('shows cursor insertion for a %s file when Markdown insertion is enabled', (fileKind, name) => {
    const target: FileTreeContextTarget = { fileKind, kind: 'file', name, path: `/workspace/${name}` };
    expect(getFileTreeContextMenuItems(target, { canInsertWorkspaceAsset: true }).map((item) => item.action)).toEqual([
      'open',
      'insert-at-cursor',
      'rename',
      'copy',
      'cut',
      'move',
      'reveal',
      'delete',
    ]);
  });

  it('omits cursor insertion when insertion is disabled or the target is unsupported', () => {
    const image: FileTreeContextTarget = { fileKind: 'image', kind: 'file', name: 'cover.png', path: '/workspace/cover.png' };
    const markdown: FileTreeContextTarget = { fileKind: 'markdown', kind: 'file', name: 'guide.md', path: '/workspace/guide.md' };

    expect(getFileTreeContextMenuItems(image).some((item) => item.action === 'insert-at-cursor')).toBe(false);
    expect(getFileTreeContextMenuItems(markdown, { canInsertWorkspaceAsset: true }).some((item) => item.action === 'insert-at-cursor')).toBe(false);
  });

  it('omits paste unless paste is available for the target', () => {
    const folder: FileTreeContextTarget = { kind: 'folder', name: 'notes', path: '/workspace/notes' };
    const items = getFileTreeContextMenuItems(folder);
    expect(items.some((item) => item.action === 'paste')).toBe(false);
    expect(items.some((item) => item.action === 'copy')).toBe(true);
  });

  it('omits rename for read-only PDF and DOCX documents', () => {
    for (const fileKind of ['pdf', 'docx'] as const) {
      const target: FileTreeContextTarget = {
        fileKind,
        kind: 'file',
        name: `guide.${fileKind}`,
        path: `/workspace/guide.${fileKind}`,
      };
      expect(getFileTreeContextMenuItems(target).map((item) => item.action)).toEqual([
        'open',
        'copy',
        'cut',
        'move',
        'reveal',
        'delete',
      ]);
    }
  });
});
