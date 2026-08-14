import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { PREVIEW_ZOOM_POLICY } from '../lib/previewZoom';
import { useI18n } from '../lib/i18n';

interface PreviewZoomToolbarProps {
  onDecrease: () => void;
  onIncrease: () => void;
  onReset: () => void;
  percent: number;
}

export function PreviewZoomToolbar({
  onDecrease,
  onIncrease,
  onReset,
  percent,
}: PreviewZoomToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="preview-zoom-toolbar" role="toolbar" aria-label={t('previewZoom')}>
      <button
        type="button"
        aria-label={t('zoomOut')}
        title={t('zoomOut')}
        disabled={percent <= PREVIEW_ZOOM_POLICY.minPercent}
        onClick={onDecrease}
      >
        <ZoomOut size={16} />
      </button>
      <output className="preview-zoom-value" aria-live="polite">{percent}%</output>
      <button type="button" aria-label={t('resetZoom')} title={t('resetZoom')} onClick={onReset}>
        <RotateCcw size={15} />
      </button>
      <button
        type="button"
        aria-label={t('zoomIn')}
        title={t('zoomIn')}
        disabled={percent >= PREVIEW_ZOOM_POLICY.maxPercent}
        onClick={onIncrease}
      >
        <ZoomIn size={16} />
      </button>
    </div>
  );
}
