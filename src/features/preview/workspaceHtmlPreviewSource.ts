/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样，由 WorkspaceHtmlPreview.test.tsx 回归约束 */
import { useEffect, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { prepareHtmlPreview } from '../../lib/tauriCommands';

const PREVIEW_PREPARE_DEBOUNCE_MS = 200;

// 工作区 HTML 预览源：200ms 防抖后申请本地服务 URL，请求世代防陈旧。
export function useWorkspaceHtmlPreviewSource(deps: {
  content: string;
  enabled: boolean;
  path: string;
}): {
  failed: boolean;
  previewUrl: string | null;
} {
  const { content, enabled, path } = deps;
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    setFailed(false);
    if (!enabled) {
      setPreview(null);
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(() => {
      void prepareHtmlPreview(path, content)
        .then((url) => {
          if (!active || requestId !== requestIdRef.current) return;
          const separator = url.includes('?') ? '&' : '?';
          setPreview({ path, url: `${url}${separator}mmdPreview=${requestId}` });
        })
        .catch((error: unknown) => {
          if (!active || requestId !== requestIdRef.current) return;
          setPreview(null);
          setFailed(true);
          emitAppFeedbackError(error);
        });
    }, PREVIEW_PREPARE_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [content, enabled, path]);

  return {
    failed,
    previewUrl: preview?.path === path ? preview.url : null,
  };
}
