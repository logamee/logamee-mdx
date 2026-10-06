import { useRef } from 'react';
import type { PdfAssetManifest } from '../../lib/pdfAssetManifest';
import { PreviewZoomToolbar } from './PreviewZoomToolbar';
import { useI18n } from '../../lib/i18n';
import { usePdfPreviewController, usePdfPreviewFailureReport } from './pdfPreviewController';

export interface PdfPreviewFeedback {
  kind: 'error' | 'notice';
  message: string;
}

interface PdfPreviewProps {
  assetManifest?: PdfAssetManifest;
  bytesBase64: string | null;
  documentEpoch: number;
  documentId: string;
  enabled?: boolean;
  onFeedback: (feedback: PdfPreviewFeedback) => void;
}

export function PdfPreview({
  assetManifest,
  bytesBase64,
  documentEpoch,
  documentId,
  enabled = true,
  onFeedback,
}: PdfPreviewProps) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const identity = `${documentId}:${documentEpoch}`;
  const reportFailure = usePdfPreviewFailureReport(identity, onFeedback, t('pdfPreviewFailure'));
  const { status, zoomHandlers, zoomPercent } = usePdfPreviewController({
    assetManifest, bytesBase64, enabled, identity, reportFailure, viewportRef,
  });

  return (
    <section className="pdf-preview" aria-label={t('pdfPreview')}>
      <PreviewZoomToolbar percent={zoomPercent} onDecrease={zoomHandlers.onDecrease} onIncrease={zoomHandlers.onIncrease} onReset={zoomHandlers.onReset} />
      <div
        className="pdf-preview-viewport"
        ref={viewportRef}
        aria-busy={status === 'loading'}
      >
        {status === 'loading' && (
          <output className="pdf-preview-status">{t('loadingPdf')}</output>
        )}
      </div>
    </section>
  );
}
