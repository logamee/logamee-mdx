import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { resizeEditorPaneRatio, resizeEditorPaneRatioFromKey } from '../lib/paneLayout';

interface UsePaneResizeInput {
  editorPaneRatio: number;
  setEditorPaneRatio: (updater: (ratio: number) => number) => void;
}

export function usePaneResize({ editorPaneRatio, setEditorPaneRatio }: UsePaneResizeInput) {
  const editorPaneRef = useRef<HTMLElement | null>(null);
  const previewPaneRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startRatio: number; containerWidth: number; pointerId: number } | null>(null);

  const startPaneResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const editorWidth = editorPaneRef.current?.getBoundingClientRect().width ?? 0;
    const previewWidth = previewPaneRef.current?.getBoundingClientRect().width ?? 0;
    const containerWidth = editorWidth + previewWidth;
    if (containerWidth <= 0) return;
    dragRef.current = { startX: event.clientX, startRatio: editorPaneRatio, containerWidth, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [editorPaneRatio]);

  const movePaneResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setEditorPaneRatio(() => resizeEditorPaneRatio({ startRatio: drag.startRatio, deltaX: event.clientX - drag.startX, containerWidth: drag.containerWidth }));
  }, [setEditorPaneRatio]);

  const stopPaneResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const resizePaneWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const nextRatio = resizeEditorPaneRatioFromKey(editorPaneRatio, event.key, event.shiftKey);
    if (nextRatio === null) return;
    event.preventDefault();
    setEditorPaneRatio(() => nextRatio);
  }, [editorPaneRatio, setEditorPaneRatio]);

  return {
    editorPaneRef,
    movePaneResize,
    previewPaneRef,
    resizePaneWithKeyboard,
    startPaneResize,
    stopPaneResize,
  };
}
