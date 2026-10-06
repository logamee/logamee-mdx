import { useCallback, useEffect, useRef } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import {
  collectAncestorFolderPaths,
  collectWorkspaceFolderPaths,
  workspaceTreeHasFile,
  type WorkspaceFileTreeNode } from '../../lib/fileTree';
import { revealWorkspaceEntry } from '../../lib/tauriCommands';
import type { WorkspaceUiStates } from './workspaceDialogStates';
import type { WorkspaceEntryOperation } from './WorkspaceEntryDialog';
import type { WorkspaceMoveOperation } from './WorkspaceMoveDialog';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { WorkspaceFileKind } from '../../types';

export interface WorkspaceTreeOperationCommands {
  copyWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>;
  createFileInWorkspace: (
    parentPath: string,
    name: string,
    fileKind?: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'>,
  ) => Promise<void>;
  createFolderInWorkspace: (parentPath: string, name: string) => Promise<void>;
  deleteWorkspaceEntryPath: (path: string) => Promise<void>;
  moveWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>;
  renameWorkspaceEntryPath: (path: string, newName: string) => Promise<void>;
  setError: (message: string | null) => void;
}

// 工作区文件树的操作态：新建/重命名/删除确认、移动对话框、剪贴板与折叠集合。
// 折叠语义见下方两个效果的注释（回滚恢复与 reveal 展开祖先）。
export function useWorkspaceTreeOperations(deps: {
  activePath: string | null;
  fileTree: WorkspaceFileTreeNode[];
  locale: EffectiveLocale;
  session: WorkspaceTreeOperationCommands;
  states: Pick<
    WorkspaceUiStates,
    'collapsedFolders' | 'fileTreeClipboard' | 'setCollapsedFolders' | 'setFileTreeClipboard'
    | 'setWorkspaceEntryOperation' | 'setWorkspaceMoveOperation' | 'workspaceEntryOperation'
    | 'workspaceMoveOperation'
  >;
  workspaceRollback: { id: number; root: string | null } | null;
  workspaceRoot: string | null;
}) {
  const {
    collapsedFolders, fileTreeClipboard, setCollapsedFolders, setFileTreeClipboard,
    setWorkspaceEntryOperation, setWorkspaceMoveOperation, workspaceEntryOperation,
    workspaceMoveOperation } = deps.states;
  const { session } = deps;


  const handleWorkspaceEntryConfirm = useWorkspaceEntryConfirm(
    session, workspaceEntryOperation, setWorkspaceEntryOperation);
  const handleWorkspaceMoveConfirm = useWorkspaceMoveConfirm(
    session.moveWorkspaceEntryPath, workspaceMoveOperation, setWorkspaceMoveOperation);
  const handleFileTreePaste = useFileTreePaste(
    session.moveWorkspaceEntryPath, session.copyWorkspaceEntryPath, fileTreeClipboard, setFileTreeClipboard);

  const treeUi = useWorkspaceTreeUiActions(deps, session, setCollapsedFolders);
  const handleFileTreeReveal = treeUi.handleFileTreeReveal;
  const toggleFolder = treeUi.toggleFolder;
  useWorkspaceFolderDefaults({
    collapsedFolders,
    fileTree: deps.fileTree,
    setCollapsedFolders,
    workspaceRollback: deps.workspaceRollback,
    workspaceRoot: deps.workspaceRoot });
  useWorkspaceActivePathReveal(deps.activePath, deps.fileTree, setCollapsedFolders);

  return {
    collapsedFolders, fileTreeClipboard, handleFileTreePaste, handleFileTreeReveal,
    handleWorkspaceEntryConfirm, handleWorkspaceMoveConfirm, setFileTreeClipboard,
    setWorkspaceEntryOperation, setWorkspaceMoveOperation, toggleFolder,
    workspaceEntryOperation, workspaceMoveOperation };
}

// 工作区根目录变化时回到“只显示第一层”的默认状态；刷新保留手动展开状态。
// 离开某工作区时记下它的手动展开集合；失败回滚（workspaceRollback 标记）返回该工作区时原样恢复，
// 与“用户重新打开同一文件夹时重置默认”区分开。集合内容不变时返回原引用，避免多余渲染。
function useWorkspaceTreeUiActions(
  deps: Parameters<typeof useWorkspaceTreeOperations>[0],
  session: WorkspaceTreeOperationCommands,
  setCollapsedFolders: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const handleFileTreeReveal = useCallback((target: { path: string }) => {
    void revealWorkspaceEntry(target.path).catch((revealError) => {
      session.setError(normalizeAppError(revealError, deps.locale));
    });
  }, [deps.locale, session]);

  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [setCollapsedFolders]);

  return { handleFileTreeReveal, toggleFolder };
}

function useWorkspaceEntryConfirm(
  session: WorkspaceTreeOperationCommands,
  workspaceEntryOperation: WorkspaceEntryOperation | null,
  setWorkspaceEntryOperation: (operation: WorkspaceEntryOperation | null) => void,
) {
  return useCallback((name?: string) => {
    const operation = workspaceEntryOperation;
    if (!operation) return;
    setWorkspaceEntryOperation(null);
    if (operation.kind === 'create-file') {
      void session.createFileInWorkspace(operation.parentPath, name ?? '', operation.fileKind);
    } else if (operation.kind === 'create-folder') {
      void session.createFolderInWorkspace(operation.parentPath, name ?? '');
    } else if (operation.kind === 'rename') {
      void session.renameWorkspaceEntryPath(operation.path, name ?? '');
    } else {
      void session.deleteWorkspaceEntryPath(operation.path);
    }
  }, [session, setWorkspaceEntryOperation, workspaceEntryOperation]);
}

function useWorkspaceMoveConfirm(
  moveWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>,
  workspaceMoveOperation: WorkspaceMoveOperation | null,
  setWorkspaceMoveOperation: (operation: WorkspaceMoveOperation | null) => void,
) {
  return useCallback((destinationParentPath: string) => {
    const operation = workspaceMoveOperation;
    if (!operation) return;
    setWorkspaceMoveOperation(null);
    void moveWorkspaceEntryPath(operation.path, destinationParentPath);
  }, [moveWorkspaceEntryPath, setWorkspaceMoveOperation, workspaceMoveOperation]);
}

function useFileTreePaste(
  moveWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>,
  copyWorkspaceEntryPath: (path: string, destinationParentPath: string) => Promise<void>,
  fileTreeClipboard: FileTreeClipboardItem | null,
  setFileTreeClipboard: (clipboard: FileTreeClipboardItem | null) => void,
) {
  return useCallback((destinationParentPath: string) => {
    const clipboard = fileTreeClipboard;
    if (!clipboard) return;
    if (clipboard.mode === 'cut') {
      setFileTreeClipboard(null);
      void moveWorkspaceEntryPath(clipboard.path, destinationParentPath);
      return;
    }
    void copyWorkspaceEntryPath(clipboard.path, destinationParentPath);
  }, [copyWorkspaceEntryPath, fileTreeClipboard, moveWorkspaceEntryPath, setFileTreeClipboard]);
}

function useWorkspaceFolderDefaults(deps: {
  collapsedFolders: Set<string>;
  fileTree: WorkspaceFileTreeNode[];
  setCollapsedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  workspaceRollback: { id: number; root: string | null } | null;
  workspaceRoot: string | null;
}): void {
  const { collapsedFolders, fileTree, setCollapsedFolders, workspaceRollback, workspaceRoot } = deps;
  const collapsedDefaultRootRef = useRef<string | null>(null);
  const leftWorkspaceExpansionRef = useRef<{ root: string | null; collapsed: Set<string> } | null>(null);
  const handledRollbackIdRef = useRef(0);
  useEffect(() => {
    if (workspaceRoot === collapsedDefaultRootRef.current) return;
    const previousRoot = collapsedDefaultRootRef.current;
    collapsedDefaultRootRef.current = workspaceRoot;
    const rollback = workspaceRollback?.id !== handledRollbackIdRef.current
      && workspaceRollback?.root === workspaceRoot
      ? workspaceRollback
      : null;
    if (rollback) handledRollbackIdRef.current = rollback.id;
    const leftExpansion = leftWorkspaceExpansionRef.current;
    if (rollback && leftExpansion?.root === workspaceRoot) {
      setCollapsedFolders(leftExpansion.collapsed);
      return;
    }
    leftWorkspaceExpansionRef.current = { root: previousRoot, collapsed: collapsedFolders };
    setCollapsedFolders((current) => {
      const next = collectWorkspaceFolderPaths(fileTree);
      if (next.size !== current.size) return next;
      for (const path of next) {
        if (!current.has(path)) return next;
      }
      return current;
    });
  }, [collapsedFolders, fileTree, setCollapsedFolders, workspaceRollback, workspaceRoot]);
}

// 打开新文档时展开其祖先文件夹，保证当前文档在树中可见。仅当文件树确实包含该文档时
// 才标记完成（树晚到的场景靠后续渲染重试）；关闭文档后清空标记，重开同一文档仍会 reveal。
function useWorkspaceActivePathReveal(
  activePath: string | null,
  fileTree: WorkspaceFileTreeNode[],
  setCollapsedFolders: React.Dispatch<React.SetStateAction<Set<string>>>,
): void {
  const revealedActivePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePath) {
      revealedActivePathRef.current = null;
      return;
    }
    if (revealedActivePathRef.current === activePath) return;
    if (!workspaceTreeHasFile(fileTree, activePath)) return;
    revealedActivePathRef.current = activePath;
    setCollapsedFolders((current) => {
      const ancestors = collectAncestorFolderPaths(fileTree, activePath);
      if (ancestors.size === 0) return current;
      let changed = false;
      const next = new Set(current);
      for (const path of ancestors) {
        if (next.delete(path)) changed = true;
      }
      return changed ? next : current;
    });
  }, [activePath, fileTree, setCollapsedFolders]);
}
