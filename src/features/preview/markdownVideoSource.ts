/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：租约效果依赖保持提取前原样，由消费方测试回归约束 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { prepareMarkdownMediaPreview, releaseMediaPreview } from '../../lib/tauriCommands';

const REMOTE_OR_DATA_RE = /^(?:https?:)?\/\//i;

function isLoopbackHttpUrl(src: string): boolean {
  const normalizedSource = src.trim().toLowerCase();
  if (normalizedSource.includes('://[::1]')) return true;
  try {
    const url = new URL(normalizedSource);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === 'localhost'
        || hostname.startsWith('127.')
        || hostname === '[::1]'
        || hostname === '::1'
        || hostname === '0.0.0.0');
  } catch {
    return false;
  }
}

function shouldResolveLocally(src: string): boolean {
  const trimmed = src.trim();
  return !!trimmed && !REMOTE_OR_DATA_RE.test(trimmed) && !/^data:/i.test(trimmed) && !/^file:/i.test(trimmed) && !trimmed.startsWith('/');
}

// Markdown 视频源解析：回环地址直接失败、本地相对路径经预览服务租约解析。
export function useMarkdownVideoSource(deps: {
  currentFilePath: string | null;
  localAssetsEnabled: boolean;
  src: string;
  workspaceRoot: string | null;
}): { failed: boolean; handleError: () => void; handleLoaded: () => void; resolvedSrc: string | undefined } {
  const { currentFilePath, localAssetsEnabled, src, workspaceRoot } = deps;
  const loopbackSource = isLoopbackHttpUrl(src);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(() => (
    loopbackSource || (shouldResolveLocally(src) && currentFilePath && !localAssetsEnabled) ? undefined : src
  ));
  const [failed, setFailed] = useState(false);
  const ownerIdRef = useRef<number | null>(null);
  const handleError = useCallback(() => {
    setFailed(true);
    emitAppFeedbackError('Failed to play Markdown video');
  }, []);
  const handleLoaded = useCallback(() => setFailed(false), []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!src || !localAssetsEnabled) { setResolvedSrc(undefined); return undefined; }
    if (loopbackSource) { setResolvedSrc(undefined); setFailed(true); return undefined; }
    if (!currentFilePath || !shouldResolveLocally(src)) { setResolvedSrc(src); return undefined; }
    prepareMarkdownMediaPreview(currentFilePath, src, workspaceRoot)
      .then((lease) => {
        if (cancelled) {
          void releaseMediaPreview(lease.ownerId).catch(() => undefined);
          return;
        }
        ownerIdRef.current = lease.ownerId;
        setResolvedSrc(lease.url);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResolvedSrc(undefined);
        setFailed(true);
        emitAppFeedbackError(error);
      });
    return () => {
      cancelled = true;
      const ownerId = ownerIdRef.current;
      ownerIdRef.current = null;
      if (ownerId !== null) void releaseMediaPreview(ownerId).catch(() => undefined);
    };
  }, [currentFilePath, localAssetsEnabled, loopbackSource, src, workspaceRoot]);

  return { failed, handleError, handleLoaded, resolvedSrc };
}
