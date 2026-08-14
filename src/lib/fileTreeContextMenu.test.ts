import { describe, expect, it } from 'vitest';
import { getFileTreeContextMenuItems, type FileTreeContextTarget } from './fileTreeContextMenu';

describe('file tree context menu model', () => {
  it('shows create actions for workspace root', () => {
    const target: FileTreeContextTarget = { kind: 'root', name: 'workspace root', path: '/workspace' };
    expect(getFileTreeContextMenuItems(target).map((item) => item.action)).toEqual(['create-file', 'create-folder', 'refresh']);
  });

  it('shows create and destructive actions for folders', () => {
    const target: FileTreeContextTarget = { kind: 'folder', name: 'notes', path: '/workspace/notes' };
    const items = getFileTreeContextMenuItems(target);
    expect(items.map((item) => item.action)).toEqual(['create-file', 'create-folder', 'rename', 'move', 'delete']);
    expect(items.find((item) => item.action === 'delete')?.label).toBe('Move to Trash');
  });

  it('shows open, rename, and delete actions for files', () => {
    const target: FileTreeContextTarget = { fileKind: 'markdown', kind: 'file', name: 'draft.md', path: '/workspace/draft.md' };
    const items = getFileTreeContextMenuItems(target);
    expect(items.map((item) => item.action)).toEqual(['open', 'rename', 'move', 'delete']);
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
      'move',
      'delete',
    ]);
  });

  it('omits cursor insertion when insertion is disabled or the target is unsupported', () => {
    const image: FileTreeContextTarget = { fileKind: 'image', kind: 'file', name: 'cover.png', path: '/workspace/cover.png' };
    const markdown: FileTreeContextTarget = { fileKind: 'markdown', kind: 'file', name: 'guide.md', path: '/workspace/guide.md' };

    expect(getFileTreeContextMenuItems(image).some((item) => item.action === 'insert-at-cursor')).toBe(false);
    expect(getFileTreeContextMenuItems(markdown, { canInsertWorkspaceAsset: true }).some((item) => item.action === 'insert-at-cursor')).toBe(false);
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
        'move',
        'delete',
      ]);
    }
  });
});
