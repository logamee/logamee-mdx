import { useCallback, useMemo } from 'react';
import type { FileTreeContextAction, FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import { canPasteFileTreeClipboard, workspaceParentPath } from '../../lib/fileTreeClipboard';
import { contextActionHandlers } from './fileSidebarContextMenu';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type {
  FileSidebarActions,
  FileSidebarContextActions,
  FileSidebarCreateEntry,
  FileSidebarDrag,
  FileSidebarMenuState,
  FileSidebarProps,
  FileSidebarSelection,
  FileSidebarTargetActions,
} from './fileSidebarTypes';

// 创建入口：默认落在选中文件夹或工作区根上。
function useFileSidebarCreateEntry(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
): FileSidebarCreateEntry {
  const { disabled, onCreateFile, onCreateFolder } = props;
  const { closeMenus } = menus;
  const { rootTarget, selectedTarget } = selection;

  const creationTarget = useMemo(() => (
    selectedTarget?.kind === 'folder' ? selectedTarget : rootTarget
  ), [rootTarget, selectedTarget]);

  const beginCreate = useCallback((
    kind: 'file' | 'excalidraw' | 'folder',
    target = creationTarget,
  ) => {
    if (disabled || !target) return;
    closeMenus();
    if (kind === 'folder') {
      onCreateFolder(target.path, target.name);
      return;
    }
    onCreateFile(target.path, target.name, kind === 'excalidraw' ? 'excalidraw' : 'markdown');
  }, [closeMenus, creationTarget, disabled, onCreateFile, onCreateFolder]);

  return { beginCreate };
}

// 目标动作：重命名、删除与移动请求，统一先收起菜单并更新选中目标。
function useFileSidebarTargetActions(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
): FileSidebarTargetActions {
  const { disabled, onDeleteEntry, onRequestMove } = props;
  const { closeMenus } = menus;
  const { setRenamingPath, setSelectedTarget } = selection;

  const beginRename = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(target.path);
    closeMenus();
  }, [closeMenus, disabled, setRenamingPath, setSelectedTarget]);

  const requestDelete = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(null);
    closeMenus();
    onDeleteEntry(target.path, target.name, target.kind);
  }, [closeMenus, disabled, onDeleteEntry, setRenamingPath, setSelectedTarget]);

  const requestMove = useCallback((target: WorkspaceTreeTarget) => {
    if (disabled) return;
    setSelectedTarget(target);
    setRenamingPath(null);
    closeMenus();
    onRequestMove(target);
  }, [closeMenus, disabled, onRequestMove, setRenamingPath, setSelectedTarget]);

  return { beginRename, requestDelete, requestMove };
}

// 粘贴可行性：剪贴板存在且目标目录可接收时才允许粘贴。
function useFileSidebarContextActions(props: FileSidebarProps): FileSidebarContextActions {
  const { clipboard = null, onPasteEntry } = props;

  const contextMenuPasteDestination = useCallback((target: FileTreeContextTarget): string => (
    target.kind === 'file' ? workspaceParentPath(target.path) ?? '' : target.path
  ), []);

  const contextMenuCanPaste = useCallback((target: FileTreeContextTarget): boolean => (
    clipboard !== null
    && onPasteEntry !== undefined
    && canPasteFileTreeClipboard(clipboard, contextMenuPasteDestination(target))
  ), [clipboard, contextMenuPasteDestination, onPasteEntry]);

  return { contextMenuCanPaste, contextMenuPasteDestination };
}

function useFileSidebarContextMenuRunner(deps: {
  props: FileSidebarProps;
  menus: FileSidebarMenuState;
  drag: FileSidebarDrag;
  createEntry: FileSidebarCreateEntry;
  targetActions: FileSidebarTargetActions;
  contextActions: FileSidebarContextActions;
}): { runContextAction: (action: FileTreeContextAction) => void } {
  const { contextMenu, closeMenus } = deps.menus;
  const { fileTreeRef, onInsertWorkspaceAssetRef } = deps.drag;
  const { onCopyEntry, onCutEntry, onOpenFile, onPasteEntry, onRefreshWorkspace, onRevealEntry } = deps.props;
  const { beginCreate } = deps.createEntry;
  const { beginRename, requestDelete, requestMove } = deps.targetActions;
  const { contextMenuPasteDestination } = deps.contextActions;

  const runContextAction = useCallback((action: FileTreeContextAction) => {
    const target = contextMenu?.target;
    if (!target) return;
    contextActionHandlers({
      beginCreate,
      beginRename,
      closeMenus,
      contextMenuPasteDestination,
      fileTreeRef,
      onCopyEntry,
      onCutEntry,
      onInsertWorkspaceAssetRef,
      onOpenFile,
      onPasteEntry,
      onRefreshWorkspace,
      onRevealEntry,
      requestDelete,
      requestMove,
    })[action]?.(target);
  }, [
    beginCreate, beginRename, closeMenus, contextMenu, contextMenuPasteDestination,
    fileTreeRef, onCopyEntry, onCutEntry, onInsertWorkspaceAssetRef, onOpenFile,
    onPasteEntry, onRefreshWorkspace, onRevealEntry, requestDelete, requestMove,
  ]);

  return { runContextAction };
}

// 侧栏动作聚合：创建/目标动作/粘贴判定与右键菜单动作分发。
export function useFileSidebarActions(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
  drag: FileSidebarDrag,
): FileSidebarActions {
  const createEntry = useFileSidebarCreateEntry(props, selection, menus);
  const targetActions = useFileSidebarTargetActions(props, selection, menus);
  const contextActions = useFileSidebarContextActions(props);
  const { runContextAction } = useFileSidebarContextMenuRunner({
    contextActions,
    createEntry,
    drag,
    menus,
    props,
    targetActions,
  });
  return { ...createEntry, ...targetActions, ...contextActions, runContextAction };
}
