import type { WorkspaceDirectoryEntry, WorkspaceFileEntry } from '../types';

export type WorkspaceFileTreeNode = WorkspaceFileTreeFolder | WorkspaceFileTreeFile;

export interface WorkspaceFileTreeFolder {
  absolutePath: string;
  kind: 'folder';
  name: string;
  path: string;
  children: WorkspaceFileTreeNode[];
}

export interface WorkspaceFileTreeFile {
  absolutePath: string;
  kind: 'file';
  name: string;
  path: string;
  relativePath: string;
  file: WorkspaceFileEntry;
}

function sortTree(nodes: WorkspaceFileTreeNode[]): WorkspaceFileTreeNode[] {
  return nodes
    .map((node) => (node.kind === 'folder' ? { ...node, children: sortTree(node.children) } : node))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
}

function parentAbsolutePath(file: WorkspaceFileEntry, folderRelativePath: string): string {
  const normalizedFilePath = file.path.replace(/\\/g, '/');
  const normalizedRelativePath = file.relative_path.replace(/\\/g, '/');
  if (!normalizedFilePath.endsWith(normalizedRelativePath)) return folderRelativePath;
  const root = normalizedFilePath.slice(0, normalizedFilePath.length - normalizedRelativePath.length).replace(/\/$/, '');
  return `${root}/${folderRelativePath}`;
}

export function buildWorkspaceFileTree(files: WorkspaceFileEntry[], directories: WorkspaceDirectoryEntry[] = []): WorkspaceFileTreeNode[] {
  const root: WorkspaceFileTreeNode[] = [];
  const folders = new Map<string, WorkspaceFileTreeFolder>();

  function ensureFolder(relativePath: string, absolutePath: string): WorkspaceFileTreeFolder | null {
    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    let siblings = root;
    let prefix = '';
    let folder: WorkspaceFileTreeFolder | undefined;

    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      folder = folders.get(prefix);
      if (!folder) {
        folder = { absolutePath: prefix === relativePath ? absolutePath : absolutePathForPrefix(absolutePath, relativePath, prefix), kind: 'folder', name: part, path: prefix, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    return folder ?? null;
  }

  for (const directory of directories) {
    ensureFolder(directory.relative_path, directory.path);
  }

  for (const file of files) {
    const parts = file.relative_path.split('/').filter(Boolean);
    const fileName = parts.pop() || file.name;
    let siblings = root;
    let prefix = '';

    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const folder = ensureFolder(prefix, parentAbsolutePath(file, prefix));
      if (!folder) continue;
      siblings = folder.children;
    }

    siblings.push({ absolutePath: file.path, kind: 'file', name: fileName, path: file.path, relativePath: file.relative_path, file });
  }

  return sortTree(root);
}

function absolutePathForPrefix(absolutePath: string, relativePath: string, prefix: string): string {
  const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (!normalizedAbsolute.endsWith(normalizedRelative)) return prefix;
  const root = normalizedAbsolute.slice(0, normalizedAbsolute.length - normalizedRelative.length).replace(/\/$/, '');
  return `${root}/${prefix}`;
}
