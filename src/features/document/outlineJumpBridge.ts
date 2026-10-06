import { useCallback, useEffect, useMemo, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import {
  decodeMarkdownOutlineJump,
  OUTLINE_JUMP_EVENT,
  type MarkdownOutlineItem,
  type MarkdownOutlineJump } from '../../lib/markdownOutline';

// 大纲跳转桥：主窗侧发出跳转（EditorPane + PreviewPane 共享 requestId 单调递增），
// 弹出预览窗监听同一事件并按文档身份过滤。
export function useOutlineJumpBridge(deps: {
  documentEpoch: number | null;
  documentId: string | null;
  isPopout: boolean;
  locale: EffectiveLocale;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}) {
  const [outlineJump, setOutlineJump] = useState<MarkdownOutlineJump | null>(null);
  const outlineJumpRequestIdRef = useMemo(() => ({ current: 0 }), []);

  const handleOutlineItemSelect = useCallback((item: MarkdownOutlineItem) => {
    outlineJumpRequestIdRef.current += 1;
    const jump: MarkdownOutlineJump = {
      documentId: deps.documentId as string,
      documentEpoch: deps.documentEpoch as number,
      item,
      requestId: outlineJumpRequestIdRef.current };
    setOutlineJump(jump);
    void emit(OUTLINE_JUMP_EVENT, jump).catch((err: unknown) => {
      deps.setError(normalizeAppError(err, deps.locale));
      deps.setNotice(null);
    });
  }, [deps, outlineJumpRequestIdRef]);

  useEffect(() => {
    if (!deps.isPopout) return undefined;
    let disposed = false;
    let unlistenOutlineJump: (() => void) | undefined;
    listen<unknown>(OUTLINE_JUMP_EVENT, (event) => {
      const jump = decodeMarkdownOutlineJump(event.payload);
      if (
        !jump
        || jump.documentId !== deps.documentId
        || jump.documentEpoch !== deps.documentEpoch
      ) return;
      setOutlineJump(jump);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutlineJump = fn;
    }).catch((err: unknown) => deps.setError(normalizeAppError(err, deps.locale)));
    return () => {
      disposed = true;
      unlistenOutlineJump?.();
    };
  }, [deps]);

  return { handleOutlineItemSelect, outlineJump };
}
