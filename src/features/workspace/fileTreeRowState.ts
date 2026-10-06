import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { WorkspaceTreeTarget } from './fileTreeRowInteractions';

// 树行派生状态：上下文目标、选中/激活/折叠/重命名标记。
export function buildTreeRowState(deps: {
  activePath: string | null;
  collapsedFolders: ReadonlySet<string>;
  node: WorkspaceFileTreeNode;
  renamingPath: string | null;
  selectedPath: string | null;
}) {
  const node = deps.node;
  const isFolder = node.kind === 'folder';
  const absolutePath = node.absolutePath;
  const contextTarget: WorkspaceTreeTarget = isFolder
    ? { kind: 'folder', name: node.name, path: absolutePath }
    : {
      fileKind: node.file.kind,
      kind: 'file',
      name: node.name,
      path: node.path,
    };
  return {
    absolutePath,
    active: !isFolder && node.path === deps.activePath,
    collapsed: isFolder && deps.collapsedFolders.has(node.path),
    contextTarget,
    isFolder,
    isRenaming: deps.renamingPath === contextTarget.path,
    selected: deps.selectedPath === contextTarget.path,
  };
}

export function treeRowClassNames(state: {
  absolutePath: string;
  active: boolean;
  contextTargetPath: string;
  disabled: boolean;
  draggingPath: string | null;
  dropTargetPath: string | null;
  isFolder: boolean;
  isRenaming: boolean;
  selected: boolean;
}): string {
  return [
    'tree-row',
    'tree-row-main',
    state.isFolder ? 'folder-row' : 'file-row',
    state.selected ? 'selected' : '',
    state.active ? 'active-document' : '',
    state.disabled ? 'disabled' : '',
    state.draggingPath === state.contextTargetPath ? 'dragging' : '',
    state.isFolder && state.dropTargetPath === state.absolutePath ? 'drop-target' : '',
    state.isRenaming ? 'renaming' : '',
  ].filter(Boolean).join(' ');
}
