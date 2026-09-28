import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceFileTree,
  collectAncestorFolderPaths,
  collectWorkspaceFolderPaths,
  workspaceTreeHasFile,
} from './fileTree';
import type { WorkspaceDirectoryEntry, WorkspaceFileEntry, WorkspaceFileKind } from '../types';

function file(relativePath: string, kind: WorkspaceFileKind = 'markdown'): WorkspaceFileEntry {
  const parts = relativePath.split('/');
  const name = parts[parts.length - 1] ?? relativePath;
  return { kind, path: `/workspace/${relativePath}`, relative_path: relativePath, name };
}

function directory(relativePath: string): WorkspaceDirectoryEntry {
  const parts = relativePath.split('/');
  const name = parts[parts.length - 1] ?? relativePath;
  return { path: `/workspace/${relativePath}`, relative_path: relativePath, name };
}

describe('workspace file tree', () => {
  it('builds nested folders from relative paths and sorts folders before files', () => {
    const tree = buildWorkspaceFileTree([
      file('z-root.md'),
      file('guides/setup.md'),
      file('guides/advanced/tips.mdx'),
      file('a-root.md'),
    ]);

    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:guides', 'file:a-root.md', 'file:z-root.md']);
    const guides = tree[0];
    expect(guides.kind).toBe('folder');
    if (guides.kind !== 'folder') throw new Error('expected folder');
    expect(guides.path).toBe('guides');
    expect(guides.absolutePath).toBe('/workspace/guides');
    expect(guides.children.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:advanced', 'file:setup.md']);
  });

  it('reuses folder nodes and keeps duplicate file names in separate folders', () => {
    const tree = buildWorkspaceFileTree([
      file('notes/today.md'),
      file('notes/archive/today.md'),
      file('notes/archive/yesterday.md'),
    ]);

    expect(tree).toHaveLength(1);
    const notes = tree[0];
    expect(notes.kind).toBe('folder');
    if (notes.kind !== 'folder') throw new Error('expected notes folder');
    expect(notes.children.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:archive', 'file:today.md']);
    const archive = notes.children[0];
    expect(archive.kind).toBe('folder');
    if (archive.kind !== 'folder') throw new Error('expected archive folder');
    expect(archive.children.map((node) => node.name)).toEqual(['today.md', 'yesterday.md']);
  });

  it('includes empty workspace directories so folder actions can target them', () => {
    const tree = buildWorkspaceFileTree([file('notes/today.md')], [directory('empty'), directory('notes/drafts')]);

    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:empty', 'folder:notes']);
    const empty = tree[0];
    expect(empty.kind).toBe('folder');
    if (empty.kind !== 'folder') throw new Error('expected empty folder');
    expect(empty.absolutePath).toBe('/workspace/empty');
    expect(empty.children).toEqual([]);

    const notes = tree[1];
    expect(notes.kind).toBe('folder');
    if (notes.kind !== 'folder') throw new Error('expected notes folder');
    expect(notes.children.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:drafts', 'file:today.md']);
  });

  it('preserves image file kinds for preview routing', () => {
    const tree = buildWorkspaceFileTree([file('assets/cover.png', 'image')]);
    const assets = tree[0];
    expect(assets.kind).toBe('folder');
    if (assets.kind !== 'folder') throw new Error('expected assets folder');
    const cover = assets.children[0];
    expect(cover.kind).toBe('file');
    if (cover.kind !== 'file') throw new Error('expected image file');
    expect(cover.file.kind).toBe('image');
  });
});

describe('collectWorkspaceFolderPaths', () => {
  it('collects every folder path so a fresh workspace can default to first-level-only', () => {
    const tree = buildWorkspaceFileTree(
      [file('notes/today.md'), file('guides/advanced/tips.md')],
      [directory('empty')],
    );

    expect(collectWorkspaceFolderPaths(tree)).toEqual(
      new Set(['empty', 'guides', 'guides/advanced', 'notes']),
    );
  });

  it('returns an empty set for an empty tree', () => {
    expect(collectWorkspaceFolderPaths([])).toEqual(new Set());
  });
});

describe('collectAncestorFolderPaths', () => {
  it('collects every ancestor folder of a file so the active document can be revealed', () => {
    const tree = buildWorkspaceFileTree([file('guides/advanced/tips.md'), file('a-root.md')]);

    expect(collectAncestorFolderPaths(tree, '/workspace/guides/advanced/tips.md')).toEqual(
      new Set(['guides', 'guides/advanced']),
    );
    expect(collectAncestorFolderPaths(tree, '/workspace/a-root.md')).toEqual(new Set());
  });

  it('returns an empty set when the path is not in the tree', () => {
    const tree = buildWorkspaceFileTree([file('notes/today.md')]);

    expect(collectAncestorFolderPaths(tree, '/workspace/missing.md')).toEqual(new Set());
  });
});

describe('workspaceTreeHasFile', () => {
  it('reports whether the tree contains a file path', () => {
    const tree = buildWorkspaceFileTree([file('notes/today.md'), file('a-root.md')]);

    expect(workspaceTreeHasFile(tree, '/workspace/notes/today.md')).toBe(true);
    expect(workspaceTreeHasFile(tree, '/workspace/a-root.md')).toBe(true);
    expect(workspaceTreeHasFile(tree, '/workspace/missing.md')).toBe(false);
  });

  it('returns false for an empty tree', () => {
    expect(workspaceTreeHasFile([], '/workspace/missing.md')).toBe(false);
  });
});
