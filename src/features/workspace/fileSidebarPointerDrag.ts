/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 FileSidebar.interactions.test.tsx 回归约束 */
import { useEffect, useRef } from 'react';
import { POINTER_DRAG_THRESHOLD, type PointerDragSession, type WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import type { MarkdownMediaInsertionTarget } from '../../lib/markdownMedia';
import type { WorkspaceFileEntry } from '../../types';

// 文件树指针拖拽会话：按住超过阈值判定为拖动，松开时按落点分发移动或媒体插入，
// 失焦/取消路径统一走抑制下一次点击的清理。状态由 FileSidebar 传入。
export function usePointerDragSession(deps: {
  canPointerDropOn: (source: WorkspaceTreeTarget, destinationParentPath: string | null) => boolean;
  closeMenus: () => void;
  disabled: boolean;
  getPointerDropDestination: (clientX: number, clientY: number) => string | null;
  getPointerMediaAsset: (
    source: WorkspaceTreeTarget,
    clientX: number,
    clientY: number,
  ) => WorkspaceFileEntry | null;
  onInsertWorkspaceAsset: ((asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void) | undefined;
  onMoveEntry: (path: string, destinationParentPath: string) => void;
  pointerDragRef: { current: PointerDragSession | null };
  setDraggedTarget: (target: WorkspaceTreeTarget | null) => void;
  setDropTargetPath: (path: string | null) => void;
  setRenamingPath: (path: string | null) => void;
  setSelectedTarget: (target: WorkspaceTreeTarget | null) => void;
  suppressNextClickRef: { current: boolean };
}) {
  const {
    canPointerDropOn, closeMenus, getPointerDropDestination, getPointerMediaAsset,
    pointerDragRef, setDraggedTarget, setDropTargetPath, setRenamingPath,
    setSelectedTarget, suppressNextClickRef } = deps;
  const onMoveEntryRef = useRef(deps.onMoveEntry);
  onMoveEntryRef.current = deps.onMoveEntry;
  const onInsertWorkspaceAssetRef = useRef(deps.onInsertWorkspaceAsset);
  onInsertWorkspaceAssetRef.current = deps.onInsertWorkspaceAsset;

  useEffect(() => createPointerDragListeners({
    canPointerDropOn, closeMenus, getPointerDropDestination, getPointerMediaAsset,
    onInsertWorkspaceAssetRef, onMoveEntryRef, pointerDragRef, setDraggedTarget,
    setDropTargetPath, setRenamingPath, setSelectedTarget, suppressNextClickRef,
  }), [canPointerDropOn, closeMenus, getPointerDropDestination, getPointerMediaAsset]);
}

interface PointerDragListenerDeps {
  canPointerDropOn: (source: WorkspaceTreeTarget, destinationParentPath: string | null) => boolean;
  closeMenus: () => void;
  getPointerDropDestination: (clientX: number, clientY: number) => string | null;
  getPointerMediaAsset: (source: WorkspaceTreeTarget, clientX: number, clientY: number) => WorkspaceFileEntry | null;
  onInsertWorkspaceAssetRef: React.RefObject<((asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget) => void) | undefined>;
  onMoveEntryRef: React.RefObject<(path: string, destinationParentPath: string) => void>;
  pointerDragRef: React.RefObject<PointerDragSession | null>;
  setDraggedTarget: (target: WorkspaceTreeTarget | null) => void;
  setDropTargetPath: (path: string | null) => void;
  setRenamingPath: (path: string | null) => void;
  setSelectedTarget: (target: WorkspaceTreeTarget | null) => void;
  suppressNextClickRef: React.RefObject<boolean>;
}

// 注册指针拖拽窗口监听；返回的清理函数会取消未决会话。
function createPointerDragListeners(deps: PointerDragListenerDeps): () => void {
  const armClickSuppression = () => {
    deps.suppressNextClickRef.current = true;
    window.setTimeout(() => {
      deps.suppressNextClickRef.current = false;
    }, 0);
  };

  const reset = (session: PointerDragSession | null) => {
    deps.pointerDragRef.current = null;
    deps.setDraggedTarget(null);
    deps.setDropTargetPath(null);
    if (session?.sourceElement.hasPointerCapture?.(session.pointerId)) {
      session.sourceElement.releasePointerCapture(session.pointerId);
    }
  };

  const move = pointerDragMoveHandler(deps);

  const finish = (event: PointerEvent, commit: boolean) => pointerDragFinish({ deps, event, commit, reset, armClickSuppression });
  const cancelSession = (session: PointerDragSession | null) => {
    if (session?.active) armClickSuppression();
    reset(session);
  };

  const cancel = (event: PointerEvent) => finish(event, false);
  const drop = (event: PointerEvent) => finish(event, true);
  const cancelOnLostCapture = (event: PointerEvent) => {
    const session = deps.pointerDragRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    cancelSession(session);
  };
  const cancelOnBlur = () => cancelSession(deps.pointerDragRef.current);
  return registerPointerDragListeners({
    cancel, cancelOnBlur, cancelOnLostCapture, cancelSession, deps, drop, move,
  });
}

// 注册/注销窗口监听；注销时取消未决会话。
function registerPointerDragListeners(handlers: {
  cancel: (event: PointerEvent) => void;
  cancelOnBlur: () => void;
  cancelOnLostCapture: (event: PointerEvent) => void;
  cancelSession: (session: PointerDragSession | null) => void;
  deps: PointerDragListenerDeps;
  drop: (event: PointerEvent) => void;
  move: (event: PointerEvent) => void;
}): () => void {
  window.addEventListener('pointermove', handlers.move, { capture: true, passive: false });
  window.addEventListener('pointerup', handlers.drop, true);
  window.addEventListener('pointercancel', handlers.cancel, true);
  window.addEventListener('lostpointercapture', handlers.cancelOnLostCapture, true);
  window.addEventListener('blur', handlers.cancelOnBlur);
  return () => {
    window.removeEventListener('pointermove', handlers.move, true);
    window.removeEventListener('pointerup', handlers.drop, true);
    window.removeEventListener('pointercancel', handlers.cancel, true);
    window.removeEventListener('lostpointercapture', handlers.cancelOnLostCapture, true);
    window.removeEventListener('blur', handlers.cancelOnBlur);
    handlers.cancelSession(handlers.deps.pointerDragRef.current);
  };
}

// 松开收尾：激活会话按落点分发媒体插入或移动条目，并抑制后续点击。
function pointerDragFinish(args: {
  armClickSuppression: () => void;
  commit: boolean;
  deps: PointerDragListenerDeps;
  event: PointerEvent;
  reset: (session: PointerDragSession | null) => void;
}): void {
  const { commit, deps, event, reset, armClickSuppression } = args;
  const session = deps.pointerDragRef.current;
  if (!session || event.pointerId !== session.pointerId) return;
  if (session.active) {
    event.preventDefault();
    armClickSuppression();
    if (commit) {
      const mediaAsset = deps.getPointerMediaAsset(session.source, event.clientX, event.clientY);
      if (mediaAsset) {
        deps.onInsertWorkspaceAssetRef.current?.(mediaAsset, {
          kind: 'coordinates',
          clientX: event.clientX,
          clientY: event.clientY,
        });
        reset(session);
        return;
      }
      const destination = deps.getPointerDropDestination(event.clientX, event.clientY);
      if (deps.canPointerDropOn(session.source, destination)) {
        deps.onMoveEntryRef.current(session.source.path, destination!);
      }
    }
  }
  reset(session);
}

// 移动处理：超阈值激活会话并持续按落点更新投放目标。
function pointerDragMoveHandler(deps: PointerDragListenerDeps): (event: PointerEvent) => void {
  return (event: PointerEvent) => {
    const session = deps.pointerDragRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!session.active) {
      const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (distance < POINTER_DRAG_THRESHOLD) return;
      session.active = true;
      deps.setSelectedTarget(session.source);
      deps.setRenamingPath(null);
      deps.closeMenus();
      deps.setDraggedTarget(session.source);
    }
    event.preventDefault();
    const mediaAsset = deps.getPointerMediaAsset(session.source, event.clientX, event.clientY);
    const destination = deps.getPointerDropDestination(event.clientX, event.clientY);
    deps.setDropTargetPath(!mediaAsset && deps.canPointerDropOn(session.source, destination) ? destination : null);
  };
}
