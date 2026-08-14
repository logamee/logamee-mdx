import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  startDocxPreview,
  type DocxPreviewResult,
  type DocxPreviewRun,
} from '../lib/docxPreviewRuntime';
import {
  PREVIEW_ZOOM_POLICY,
  reducePreviewZoom,
  type PreviewZoomAction,
} from '../lib/previewZoom';
import { PreviewZoomToolbar } from './PreviewZoomToolbar';
import { useI18n } from '../lib/i18n';

export interface DocxPreviewFeedback {
  readonly kind: 'error' | 'notice';
  readonly message: string;
}

export interface DocxPreviewProps {
  readonly bytesBase64: string | null;
  readonly documentEpoch: number;
  readonly documentId: string;
  readonly enabled?: boolean;
  readonly onFeedback: (feedback: DocxPreviewFeedback) => void;
}

interface ZoomState {
  readonly identity: string;
  readonly percent: number;
}

interface PreviewState {
  readonly identity: string;
  readonly result: DocxPreviewResult | null;
  readonly status: 'failed' | 'idle' | 'loading' | 'ready';
}

export function DocxPreview({
  bytesBase64,
  documentEpoch,
  documentId,
  enabled = true,
  onFeedback,
}: DocxPreviewProps) {
  const { t } = useI18n();
  const identity = `${documentId}:${documentEpoch}`;
  const documentRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef(onFeedback);
  const emittedFeedback = useRef(new Set<string>());
  const [previewState, setPreviewState] = useState<PreviewState>({
    identity,
    result: null,
    status: 'idle',
  });
  const [zoomState, setZoomState] = useState<ZoomState>({
    identity,
    percent: PREVIEW_ZOOM_POLICY.defaultPercent,
  });
  feedbackRef.current = onFeedback;

  const currentPreview = previewState.identity === identity
    ? previewState
    : { identity, result: null, status: 'idle' as const };
  const zoomPercent = zoomState.identity === identity
    ? zoomState.percent
    : PREVIEW_ZOOM_POLICY.defaultPercent;

  const emitFeedbackOnce = useCallback((
    kind: DocxPreviewFeedback['kind'],
    message: string,
  ) => {
    const key = `${identity}:${kind}`;
    if (emittedFeedback.current.has(key)) return;
    emittedFeedback.current.add(key);
    feedbackRef.current({ kind, message });
  }, [identity]);

  const updateZoom = (action: PreviewZoomAction) => {
    setZoomState((current) => ({
      identity,
      percent: reducePreviewZoom(
        current.identity === identity
          ? current.percent
          : PREVIEW_ZOOM_POLICY.defaultPercent,
        action,
      ),
    }));
  };

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
      emitFeedbackOnce('error', t('docxPreviewFailure'));
      return undefined;
    }

    void run.done.then((result) => {
      if (!current) return;
      setPreviewState({ identity, result, status: 'ready' });
      if (result.detectedLoss) {
        emitFeedbackOnce('notice', t('docxPreviewDegraded'));
      }
    }).catch(() => {
      if (!current) return;
      setPreviewState({ identity, result: null, status: 'failed' });
      emitFeedbackOnce('error', t('docxPreviewFailure'));
    });

    return () => {
      current = false;
      run.cancel();
    };
  }, [bytesBase64, documentEpoch, documentId, emitFeedbackOnce, enabled, identity, t]);

  useEffect(() => {
    const container = documentRef.current;
    if (!container) return undefined;
    container.replaceChildren();
    if (currentPreview.result === null) return undefined;

    const template = document.createElement('template');
    template.innerHTML = currentPreview.result.html;
    container.replaceChildren(template.content.cloneNode(true));
    return () => container.replaceChildren();
  }, [currentPreview.result]);

  const preventAnchorNavigation = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Node;
    const targetElement = target instanceof Element ? target : target.parentElement;
    const anchor = targetElement?.closest('a');
    if (anchor && event.currentTarget.contains(anchor)) event.preventDefault();
  };

  return (
    <section className="docx-preview" aria-label={t('docxPreview')}>
      <PreviewZoomToolbar
        percent={zoomPercent}
        onDecrease={() => updateZoom('decrease')}
        onIncrease={() => updateZoom('increase')}
        onReset={() => updateZoom('reset')}
      />
      <div
        className="docx-preview-viewport"
        aria-busy={currentPreview.status === 'loading'}
        onClickCapture={preventAnchorNavigation}
      >
        {currentPreview.status === 'loading' && (
          <output className="docx-preview-status">{t('loadingDocx')}</output>
        )}
        <div
          className="docx-preview-document"
          ref={documentRef}
          style={{ '--docx-zoom': `${zoomPercent}%` } as CSSProperties}
        />
      </div>
    </section>
  );
}
