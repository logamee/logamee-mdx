/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样，由 PdfPreview.test.tsx 回归约束 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPdfAssetManifest, type PdfAssetManifest } from '../../lib/pdfAssetManifest';
import { startPdfPreview } from '../../lib/pdfPreviewRuntime';
import { PREVIEW_ZOOM_POLICY, reducePreviewZoom, type PreviewZoomAction } from '../../lib/previewZoom';

interface ZoomState {
  identity: string;
  percent: number;
}

export type PdfPreviewStatus = 'idle' | 'loading' | 'ready' | 'failed';

// 缩放态：随文档身份重置为默认百分比。
function usePreviewZoomState(identity: string): {
  decrease: () => void;
  increase: () => void;
  reset: () => void;
  zoomPercent: number;
} {
  const [zoomState, setZoomState] = useState<ZoomState>({
    identity,
    percent: PREVIEW_ZOOM_POLICY.defaultPercent,
  });
  const updateZoom = useCallback((action: PreviewZoomAction) => {
    setZoomState((current) => ({
      identity,
      percent: reducePreviewZoom(
        current.identity === identity ? current.percent : PREVIEW_ZOOM_POLICY.defaultPercent,
        action,
      ),
    }));
  }, [identity]);
  const zoomPercent = zoomState.identity === identity
    ? zoomState.percent
    : PREVIEW_ZOOM_POLICY.defaultPercent;
  return {
    decrease: useCallback(() => updateZoom('decrease'), [updateZoom]),
    increase: useCallback(() => updateZoom('increase'), [updateZoom]),
    reset: useCallback(() => updateZoom('reset'), [updateZoom]),
    zoomPercent,
  };
}

// 清单懒加载：未内嵌清单且可预览时拉取，失败上报。
function usePdfManifestLoading(deps: {
  assetManifest?: PdfAssetManifest;
  canPreview: boolean;
  identity: string;
  loadedManifest: PdfAssetManifest | null;
  reportFailure: () => void;
  setLoadedManifest: (manifest: PdfAssetManifest) => void;
  setStatus: (status: PdfPreviewStatus) => void;
}): void {
  const { assetManifest, canPreview, loadedManifest, reportFailure } = deps;
  useEffect(() => {
    if (assetManifest || !canPreview || loadedManifest) return undefined;
    let current = true;
    deps.setStatus('loading');
    void loadPdfAssetManifest().then((manifest) => {
      if (current) deps.setLoadedManifest(manifest);
    }).catch(() => {
      if (!current) return;
      deps.setStatus('failed');
      reportFailure();
    });
    return () => {
      current = false;
    };
  }, [assetManifest, canPreview, deps.identity, loadedManifest, reportFailure]);
}

// PDF 预览控制器：清单加载、缩放态与渲染会话生命周期。
export function usePdfPreviewController(deps: {
  assetManifest?: PdfAssetManifest;
  bytesBase64: string | null;
  enabled: boolean;
  identity: string;
  reportFailure: () => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}): {
  status: PdfPreviewStatus;
  zoomHandlers: { onDecrease: () => void; onIncrease: () => void; onReset: () => void };
  zoomPercent: number;
} {
  const { assetManifest, bytesBase64, enabled, identity, reportFailure, viewportRef } = deps;
  const [loadedManifest, setLoadedManifest] = useState<PdfAssetManifest | null>(null);
  const [status, setStatus] = useState<PdfPreviewStatus>('idle');
  const { decrease, increase, reset, zoomPercent } = usePreviewZoomState(identity);
  const effectiveManifest = assetManifest ?? loadedManifest;
  const canPreview = enabled && Boolean(bytesBase64);

  usePdfManifestLoading({
    assetManifest, canPreview, identity, loadedManifest, reportFailure, setLoadedManifest, setStatus,
  });

  useEffect(() => {
    const container = viewportRef.current;
    if (!enabled || !bytesBase64 || !container) {
      setStatus('idle');
      return undefined;
    }
    if (!effectiveManifest) return undefined;

    let current = true;
    setStatus('loading');
    const run = startPdfPreview({ assetManifest: effectiveManifest, bytesBase64, container, zoomPercent });
    void run.done.then(() => {
      if (current) setStatus('ready');
    }).catch(() => {
      if (!current) return;
      setStatus('failed');
      reportFailure();
    });

    return () => {
      current = false;
      run.cancel();
    };
  }, [bytesBase64, canPreview, effectiveManifest, enabled, identity, reportFailure, zoomPercent]);

  return { status, zoomHandlers: { onDecrease: decrease, onIncrease: increase, onReset: reset }, zoomPercent };
}

// 失败上报：同一文档身份只上报一次。
export function usePdfPreviewFailureReport(
  identity: string,
  onFeedback: (feedback: { kind: 'error'; message: string }) => void,
  message: string,
): () => void {
  const reportedFailureIdentityRef = useRef<string | null>(null);
  return useCallback(() => {
    if (reportedFailureIdentityRef.current === identity) return;
    reportedFailureIdentityRef.current = identity;
    onFeedback({ kind: 'error', message });
  }, [identity, message, onFeedback]);
}
