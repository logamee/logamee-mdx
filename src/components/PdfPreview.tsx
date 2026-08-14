import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadPdfAssetManifest,
  type PdfAssetManifest,
} from '../lib/pdfAssetManifest';
import { startPdfPreview } from '../lib/pdfPreviewRuntime';
import {
  PREVIEW_ZOOM_POLICY,
  reducePreviewZoom,
  type PreviewZoomAction,
} from '../lib/previewZoom';
import { PreviewZoomToolbar } from './PreviewZoomToolbar';
import { useI18n } from '../lib/i18n';

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

interface ZoomState {
  identity: string;
  percent: number;
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
  const reportedFailureIdentityRef = useRef<string | null>(null);
  const [loadedManifest, setLoadedManifest] = useState<PdfAssetManifest | null>(null);
  const [zoomState, setZoomState] = useState<ZoomState>({
    identity,
    percent: PREVIEW_ZOOM_POLICY.defaultPercent,
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const zoomPercent = zoomState.identity === identity
    ? zoomState.percent
    : PREVIEW_ZOOM_POLICY.defaultPercent;
  const effectiveManifest = assetManifest ?? loadedManifest;
  const canPreview = enabled && Boolean(bytesBase64);

  const reportFailure = useCallback(() => {
    if (reportedFailureIdentityRef.current === identity) return;
    reportedFailureIdentityRef.current = identity;
    onFeedback({ kind: 'error', message: t('pdfPreviewFailure') });
  }, [identity, onFeedback, t]);

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
    if (assetManifest || !canPreview || loadedManifest) return undefined;
    let current = true;
    setStatus('loading');
    void loadPdfAssetManifest().then((manifest) => {
      if (current) setLoadedManifest(manifest);
    }).catch(() => {
      if (!current) return;
      setStatus('failed');
      reportFailure();
    });
    return () => {
      current = false;
    };
  }, [assetManifest, canPreview, identity, loadedManifest, reportFailure]);

  useEffect(() => {
    const container = viewportRef.current;
    if (!enabled || !bytesBase64 || !container) {
      setStatus('idle');
      return undefined;
    }
    if (!effectiveManifest) return undefined;

    let current = true;
    setStatus('loading');
    const run = startPdfPreview({
      assetManifest: effectiveManifest,
      bytesBase64,
      container,
      zoomPercent,
    });
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

  return (
    <section className="pdf-preview" aria-label={t('pdfPreview')}>
      <PreviewZoomToolbar
        percent={zoomPercent}
        onDecrease={() => updateZoom('decrease')}
        onIncrease={() => updateZoom('increase')}
        onReset={() => updateZoom('reset')}
      />
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
