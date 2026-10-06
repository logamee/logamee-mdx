/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：租约效果依赖保持提取前原样，由 WorkspaceMediaPreview.test.tsx 回归约束 */
import { useEffect, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { prepareWorkspaceMediaPreview, releaseMediaPreview } from '../../lib/tauriCommands';

// 媒体预览租约：按路径+修订申请本地预览地址，换键或卸载时释放。
export function useMediaPreviewLease(deps: {
  enabled: boolean;
  path: string;
  previewRevision: number;
}): { failed: boolean; loaded: boolean; markFailed: () => void; markLoaded: () => void; setFailed: (failed: boolean) => void; setLoaded: (loaded: boolean) => void; sourceUrl: string | null } {
  const { enabled, path, previewRevision } = deps;
  const ownerIdRef = useRef<number | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setSourceUrl(null);
    if (!enabled) return undefined;
    let cancelled = false;
    prepareWorkspaceMediaPreview(path)
      .then((lease) => {
        if (cancelled) {
          void releaseMediaPreview(lease.ownerId).catch(() => undefined);
          return;
        }
        ownerIdRef.current = lease.ownerId;
        setSourceUrl(`${lease.url}${lease.url.includes('?') ? '&' : '?'}mmdRevision=${previewRevision}`);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        emitAppFeedbackError(error);
      });
    return () => {
      cancelled = true;
      const ownerId = ownerIdRef.current;
      ownerIdRef.current = null;
      if (ownerId !== null) void releaseMediaPreview(ownerId).catch(() => undefined);
    };
  }, [enabled, path, previewRevision]);

  const markFailed = () => {
    setFailed(true);
    emitAppFeedbackError('Failed to play media');
  };

  return { failed, loaded, markFailed, markLoaded: () => setLoaded(true), setFailed, setLoaded, sourceUrl };
}
