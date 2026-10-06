import { useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { PreviewZoomToolbar } from './PreviewZoomToolbar';
import { useI18n } from '../../lib/i18n';
import { useDocxPreviewController } from './docxPreviewController';

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
  const { previewState, zoomHandlers, zoomPercent } = useDocxPreviewController({
    bytesBase64, degradedMessage: t('docxPreviewDegraded'), documentEpoch, documentId,
    enabled, failureMessage: t('docxPreviewFailure'), onFeedback,
  });

  const currentPreview = previewState.identity === identity
    ? previewState
    : { identity, result: null, status: 'idle' as const };

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
      <PreviewZoomToolbar percent={zoomPercent} onDecrease={zoomHandlers.onDecrease} onIncrease={zoomHandlers.onIncrease} onReset={zoomHandlers.onReset} />
      <DocxPreviewViewport documentRef={documentRef} loading={currentPreview.status === 'loading'} loadingLabel={t('loadingDocx')} onAnchorClick={preventAnchorNavigation} zoomPercent={zoomPercent} />
    </section>
  );
}

// 文档视口：加载占位、锚点导航拦截与 CSS 缩放变量。
function DocxPreviewViewport(props: {
  documentRef: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  loadingLabel: string;
  onAnchorClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  zoomPercent: number;
}) {
  return (
    <div
      className="docx-preview-viewport"
      aria-busy={props.loading}
      onClickCapture={props.onAnchorClick}
    >
      {props.loading && (
        <output className="docx-preview-status">{props.loadingLabel}</output>
      )}
      <div
        className="docx-preview-document"
        ref={props.documentRef}
        style={{ '--docx-zoom': `${props.zoomPercent}%` } as CSSProperties}
      />
    </div>
  );
}
