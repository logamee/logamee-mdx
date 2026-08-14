import type { WorkspaceFileTreeNode } from './fileTree';

export interface WorkspaceMoveDestination {
  label: string;
  path: string;
}

interface MoveWorkspaceEntryPolicyInput {
  destinationParentPath: string;
  sourceKind: 'file' | 'folder';
  sourcePath: string;
}

interface GetWorkspaceMoveDestinationsInput {
  fileTree: WorkspaceFileTreeNode[];
  sourceKind: 'file' | 'folder';
  sourcePath: string;
  workspaceRoot: string;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const separator = normalized.lastIndexOf('/');
  if (separator <= 0) return normalized.slice(0, Math.max(separator, 0)) || '/';
  return normalized.slice(0, separator);
}

function isSameOrDescendantPath(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalizedPath === normalizedParent
    || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function canMoveWorkspaceEntry({
  destinationParentPath,
  sourceKind,
  sourcePath,
}: MoveWorkspaceEntryPolicyInput): boolean {
  const normalizedDestination = normalizePath(destinationParentPath);
  const normalizedSource = normalizePath(sourcePath);
  if (parentPath(normalizedSource) === normalizedDestination) return false;
  if (sourceKind === 'folder' && isSameOrDescendantPath(normalizedDestination, normalizedSource)) {
    return false;
  }
  return true;
}

export function getWorkspaceMoveDestinations({
  fileTree,
  sourceKind,
  sourcePath,
  workspaceRoot,
}: GetWorkspaceMoveDestinationsInput): WorkspaceMoveDestination[] {
  const destinations: WorkspaceMoveDestination[] = [];

  const appendIfAllowed = (label: string, path: string) => {
    if (canMoveWorkspaceEntry({ destinationParentPath: path, sourceKind, sourcePath })) {
      destinations.push({ label, path });
    }
  };

  appendIfAllowed('Workspace Root', workspaceRoot);

  const visit = (nodes: WorkspaceFileTreeNode[], parents: string[]) => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      const labels = [...parents, node.name];
      appendIfAllowed(labels.join(' / '), node.absolutePath);
      visit(node.children, labels);
    }
  };

  visit(fileTree, []);
  return destinations;
}
