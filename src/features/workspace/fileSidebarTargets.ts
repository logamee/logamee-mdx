import type { } from '../../lib/fileTreeContextMenu';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type { WorkspaceFileEntry } from '../../types';

export function findTreeTarget(
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

export function findWorkspaceFileEntry(
  nodes: WorkspaceFileTreeNode[],
  path: string,
): WorkspaceFileEntry | null {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const nested = findWorkspaceFileEntry(node.children, path);
      if (nested) return nested;
    } else if (node.path === path) {
      return node.file;
    }
  }
  return null;
}
