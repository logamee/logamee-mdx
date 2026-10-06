/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样，由 DocxPreview.test.tsx 回归约束 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { startDocxPreview, type DocxPreviewResult, type DocxPreviewRun } from '../../lib/docxPreviewRuntime';
import { PREVIEW_ZOOM_POLICY, reducePreviewZoom, type PreviewZoomAction } from '../../lib/previewZoom';

interface ZoomState {
  readonly identity: string;
  readonly percent: number;
}

interface PreviewState {
  readonly identity: string;
  readonly result: DocxPreviewResult | null;
  readonly status: 'failed' | 'idle' | 'loading' | 'ready';
}

// 会话落定：就绪时挂结果并按需报降级；失败时报错误。
function settleDocxRun(run: DocxPreviewRun, deps: {
  degradedMessage: string;
  emitFeedbackOnce: (kind: 'error' | 'notice', message: string) => void;
  failureMessage: string;
  identity: string;
  isCurrent: () => boolean;
  setPreviewState: (state: PreviewState) => void;
}): void {
  void run.done.then((result) => {
    if (!deps.isCurrent()) return;
    deps.setPreviewState({ identity: deps.identity, result, status: 'ready' });
    if (result.detectedLoss) {
      deps.emitFeedbackOnce('notice', deps.degradedMessage);
    }
  }).catch(() => {
    if (!deps.isCurrent()) return;
    deps.setPreviewState({ identity: deps.identity, result: null, status: 'failed' });
    deps.emitFeedbackOnce('error', deps.failureMessage);
  });
}

// 渲染会话：启停 DOCX 转换、就绪/失败/降级上报（同一身份同类只报一次）。
function useDocxPreviewRun(deps: {
  bytesBase64: string | null;
  documentEpoch: number;
  documentId: string;
  emitFeedbackOnce: (kind: 'error' | 'notice', message: string) => void;
  enabled: boolean;
  failureMessage: string;
  identity: string;
  degradedMessage: string;
}): [PreviewState, (state: PreviewState) => void] {
  const { bytesBase64, documentEpoch, documentId, emitFeedbackOnce, enabled, failureMessage, degradedMessage, identity } = deps;
  const [previewState, setPreviewState] = useState<PreviewState>({
    identity,
    result: null,
    status: 'idle',
  });

  useEffect(() => {
    if (!enabled || !bytesBase64) {
      setPreviewState({ identity, result: null, status: 'idle' });
      return undefined;
    }

    let current = true;
    let run: DocxPreviewRun;
    setPreviewState({ identity, result: null, status: 'loading' });
    try {
      run = startDocxPreview({ bytesBase64, documentEpoch, documentId });
    } catch {
      setPreviewState({ identity, result: null, status: 'failed' });
      emitFeedbackOnce('error', failureMessage);
      return undefined;
    }

    void settleDocxRun(run, {
      degradedMessage, emitFeedbackOnce, failureMessage, identity, isCurrent: () => current,
      setPreviewState,
    });

    return () => {
      current = false;
      run.cancel();
    };
  }, [bytesBase64, documentEpoch, documentId, emitFeedbackOnce, enabled, failureMessage, degradedMessage, identity]);

  return [previewState, setPreviewState];
}

// DOCX 预览控制器：渲染会话、缩放态与一次性反馈。
export function useDocxPreviewController(deps: {
  bytesBase64: string | null;
  documentEpoch: number;
  documentId: string;
  enabled: boolean;
  failureMessage: string;
  degradedMessage: string;
  onFeedback: (feedback: { kind: 'error' | 'notice'; message: string }) => void;
}): {
  previewState: PreviewState;
  zoomHandlers: { onDecrease: () => void; onIncrease: () => void; onReset: () => void };
  zoomPercent: number;
} {
  const { documentEpoch, documentId, onFeedback } = deps;
  const identity = `${documentId}:${documentEpoch}`;
  const feedbackRef = useRef(onFeedback);
  const emittedFeedback = useRef(new Set<string>());
  feedbackRef.current = onFeedback;

  const emitFeedbackOnce = useCallback((kind: 'error' | 'notice', message: string) => {
    const key = `${identity}:${kind}`;
    if (emittedFeedback.current.has(key)) return;
    emittedFeedback.current.add(key);
    feedbackRef.current({ kind, message });
  }, [identity]);

  const [previewState] = useDocxPreviewRun({
    bytesBase64: deps.bytesBase64,
    degradedMessage: deps.degradedMessage,
    documentEpoch,
    documentId,
    emitFeedbackOnce,
    enabled: deps.enabled,
    failureMessage: deps.failureMessage,
    identity,
  });

  const zoomHandlers = useDocxZoomState(identity);

  return { previewState, zoomHandlers, zoomPercent: zoomHandlers.zoomPercent };
}

// 缩放态：随文档身份重置为默认百分比，处理器以 useCallback 绑定。
function useDocxZoomState(identity: string): {
  onDecrease: () => void;
  onIncrease: () => void;
  onReset: () => void;
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
    onDecrease: useCallback(() => updateZoom('decrease'), [updateZoom]),
    onIncrease: useCallback(() => updateZoom('increase'), [updateZoom]),
    onReset: useCallback(() => updateZoom('reset'), [updateZoom]),
    zoomPercent,
  };
}
