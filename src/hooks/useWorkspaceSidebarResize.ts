import {
  useCallback,
  useRef,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';
import {
  clampWorkspaceSidebarWidth,
  resizeWorkspaceSidebarWidth,
  resizeWorkspaceSidebarWidthFromKey,
} from '../lib/sidebarLayout';

interface UseWorkspaceSidebarResizeInput {
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  sidebarWidth: number;
}

interface WorkspaceSidebarDrag {
  pointerId: number;
  startWidth: number;
  startX: number;
}

export function useWorkspaceSidebarResize({
  setSidebarWidth,
  sidebarWidth,
}: UseWorkspaceSidebarResizeInput) {
  const dragRef = useRef<WorkspaceSidebarDrag | null>(null);

  const startWorkspaceSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startWidth: clampWorkspaceSidebarWidth(sidebarWidth),
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [sidebarWidth]);

  const moveWorkspaceSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSidebarWidth(resizeWorkspaceSidebarWidth({
      deltaX: event.clientX - drag.startX,
      startWidth: drag.startWidth,
    }));
  }, [setSidebarWidth]);

  const stopWorkspaceSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const resizeWorkspaceSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const nextWidth = resizeWorkspaceSidebarWidthFromKey(sidebarWidth, event.key);
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(nextWidth);
  }, [setSidebarWidth, sidebarWidth]);

  return {
    moveWorkspaceSidebarResize,
    resizeWorkspaceSidebarWithKeyboard,
    startWorkspaceSidebarResize,
    stopWorkspaceSidebarResize,
  };
}
