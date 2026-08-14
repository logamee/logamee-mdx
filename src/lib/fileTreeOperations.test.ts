import { describe, expect, it } from 'vitest';
import type { WorkspaceFileTreeNode } from './fileTree';
import {
  canMoveWorkspaceEntry,
  getWorkspaceMoveDestinations,
} from './fileTreeOperations';

const tree: WorkspaceFileTreeNode[] = [
  {
    absolutePath: '/workspace/archive',
    kind: 'folder',
    name: 'archive',
    path: 'archive',
    children: [],
  },
  {
    absolutePath: '/workspace/notes',
    kind: 'folder',
    name: 'notes',
    path: 'notes',
    children: [
      {
        absolutePath: '/workspace/notes/drafts',
        kind: 'folder',
        name: 'drafts',
        path: 'notes/drafts',
        children: [],
      },
      {
        absolutePath: '/workspace/notes/readme.md',
        kind: 'file',
        name: 'readme.md',
        path: '/workspace/notes/readme.md',
        relativePath: 'notes/readme.md',
        file: {
          kind: 'markdown',
          name: 'readme.md',
          path: '/workspace/notes/readme.md',
          relative_path: 'notes/readme.md',
        },
      },
    ],
  },
];

describe('workspace file tree move policy', () => {
  it('allows a file to move to another folder or the root but not its current parent', () => {
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace/archive',
      sourceKind: 'file',
      sourcePath: '/workspace/notes/readme.md',
    })).toBe(true);
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace',
      sourceKind: 'file',
      sourcePath: '/workspace/notes/readme.md',
    })).toBe(true);
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace/notes',
      sourceKind: 'file',
      sourcePath: '/workspace/notes/readme.md',
    })).toBe(false);
  });

  it('rejects moving a folder into itself or one of its descendants', () => {
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace/notes',
      sourceKind: 'folder',
      sourcePath: '/workspace/notes',
    })).toBe(false);
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace/notes/drafts',
      sourceKind: 'folder',
      sourcePath: '/workspace/notes',
    })).toBe(false);
    expect(canMoveWorkspaceEntry({
      destinationParentPath: '/workspace/archive',
      sourceKind: 'folder',
      sourcePath: '/workspace/notes',
    })).toBe(true);
  });

  it('builds keyboard-accessible move destinations and excludes invalid folders', () => {
    expect(getWorkspaceMoveDestinations({
      fileTree: tree,
      sourceKind: 'folder',
      sourcePath: '/workspace/notes',
      workspaceRoot: '/workspace',
    })).toEqual([
      { label: 'archive', path: '/workspace/archive' },
    ]);

    expect(getWorkspaceMoveDestinations({
      fileTree: tree,
      sourceKind: 'file',
      sourcePath: '/workspace/notes/readme.md',
      workspaceRoot: '/workspace',
    })).toEqual([
      { label: 'Workspace Root', path: '/workspace' },
      { label: 'archive', path: '/workspace/archive' },
      { label: 'notes / drafts', path: '/workspace/notes/drafts' },
    ]);
  });
});
