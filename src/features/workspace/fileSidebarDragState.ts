import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { canMoveWorkspaceEntry } from '../../lib/fileTreeOperations';
import type { WorkspaceFileEntry } from '../../types';
import { draggableTreeRow, mediaAssetAtPointer, pointerDropDestination } from './fileSidebarHelpers';
import { usePointerDragSession } from './fileSidebarPointerDrag';
import type { PointerDragSession, WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type {
  FileSidebarDrag,
  FileSidebarDragGestures,
  FileSidebarDragState,
  FileSidebarMenuState,
  FileSidebarProps,
  FileSidebarSelection,
} from './fileSidebarTypes';

// 拖拽状态宿主：指针会话引用、最新回调引用、抑制点击标志与禁用复位。
export function useFileSidebarDragState(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
): FileSidebarDragState {
  const { disabled, fileTree, onInsertWorkspaceAsset } = props;
  const { closeMenus } = menus;
  const { setRenamingPath } = selection;
  const [draggedTarget, setDraggedTarget] = useState<WorkspaceTreeTarget | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const pointerDragRef = useRef<PointerDragSession | null>(null);
  const suppressNextClickRef = useRef(false);
  const onInsertWorkspaceAssetRef = useRef(onInsertWorkspaceAsset);
  onInsertWorkspaceAssetRef.current = onInsertWorkspaceAsset;
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  useEffect(() => {
    if (!disabled) return;
    closeMenus();
    setRenamingPath(null);
    pointerDragRef.current = null;
    setDraggedTarget(null);
    setDropTargetPath(null);
  }, [closeMenus, disabled, setRenamingPath]);

  const handleSidebarClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!suppressNextClickRef.current) return;
    suppressNextClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, [suppressNextClickRef]);

  return {
    draggedTarget,
    dropTargetPath,
    fileTreeRef,
    handleSidebarClickCapture,
    onInsertWorkspaceAssetRef,
    pointerDragRef,
    setDraggedTarget,
    setDropTargetPath,
    suppressNextClickRef,
  };
}

// 拖拽手势判定：落点解析、可投放判定、媒体资产解析与按下启动。
function useFileSidebarDragGestures(
  props: FileSidebarProps,
  dragState: FileSidebarDragState,
): FileSidebarDragGestures {
  const { disabled = false, fileTree, workspaceRoot } = props;
  const { fileTreeRef, onInsertWorkspaceAssetRef, pointerDragRef } = dragState;

  const getPointerDropDestination = useCallback((clientX: number, clientY: number) => (
    workspaceRoot ? pointerDropDestination(clientX, clientY, workspaceRoot) : null
  ), [workspaceRoot]);

  const canPointerDropOn = useCallback((
    source: WorkspaceTreeTarget,
    destinationParentPath: string | null,
  ) => (
    !disabled && destinationParentPath !== null && canMoveWorkspaceEntry({
      destinationParentPath,
      sourceKind: source.kind,
      sourcePath: source.path,
    })
  ), [disabled]);

  const getPointerMediaAsset = useCallback((
    source: WorkspaceTreeTarget,
    clientX: number,
    clientY: number,
  ): WorkspaceFileEntry | null => mediaAssetAtPointer(
    source, clientX, clientY, {
      canInsert: Boolean(onInsertWorkspaceAssetRef.current),
      fileTree: fileTreeRef.current,
    }
  ), [fileTreeRef, onInsertWorkspaceAssetRef]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const row = draggableTreeRow(event, disabled, fileTree);
    if (!row) return;
    pointerDragRef.current = {
      active: false,
      pointerId: event.pointerId,
      source: row.source,
      sourceElement: row.element,
      startX: event.clientX,
      startY: event.clientY,
    };
    row.element.setPointerCapture?.(event.pointerId);
  }, [disabled, fileTree, pointerDragRef]);

  return { canPointerDropOn, getPointerDropDestination, getPointerMediaAsset, handlePointerDown };
}

// 指针拖拽会话接线：手势判定 + 指针事件监听与松开分发。
export function useFileSidebarDrag(
  props: FileSidebarProps,
  selection: FileSidebarSelection,
  menus: FileSidebarMenuState,
  dragState: FileSidebarDragState,
): FileSidebarDrag {
  const { onInsertWorkspaceAsset, onMoveEntry } = props;
  const { setRenamingPath, setSelectedTarget } = selection;
  const { closeMenus } = menus;
  const gestures = useFileSidebarDragGestures(props, dragState);
  usePointerDragSession({
    canPointerDropOn: gestures.canPointerDropOn,
    closeMenus,
    disabled: props.disabled ?? false,
    getPointerDropDestination: gestures.getPointerDropDestination,
    getPointerMediaAsset: gestures.getPointerMediaAsset,
    onInsertWorkspaceAsset,
    onMoveEntry,
    pointerDragRef: dragState.pointerDragRef,
    setDraggedTarget: dragState.setDraggedTarget,
    setDropTargetPath: dragState.setDropTargetPath,
    setRenamingPath,
    setSelectedTarget,
    suppressNextClickRef: dragState.suppressNextClickRef,
  });
  return {
    draggedTarget: dragState.draggedTarget,
    dropTargetPath: dragState.dropTargetPath,
    fileTreeRef: dragState.fileTreeRef,
    handlePointerDown: gestures.handlePointerDown,
    handleSidebarClickCapture: dragState.handleSidebarClickCapture,
    onInsertWorkspaceAssetRef: dragState.onInsertWorkspaceAssetRef,
  };
}
