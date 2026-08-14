import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { translate, useI18n } from '../lib/i18n';
import type { EffectiveLocale } from '../lib/locale';
import { classifyReadingImageSize, hasAuthorReadingImageSize, toAuthorReadingImageCssSize, type ReadingImageLoadState } from '../lib/markdownImageSizing';
import { getMarkdownImagePreviewUrl } from '../lib/workspacePreviewSource';

const REMOTE_OR_DATA_RE = /^(?:https?:)?\/\//i;

function shouldResolveLocally(src: string): boolean {
  const trimmed = src.trim();
  return !!trimmed && !REMOTE_OR_DATA_RE.test(trimmed) && !/^data:/i.test(trimmed) && !/^file:/i.test(trimmed) && !trimmed.startsWith('/');
}

export function getMarkdownImageErrorPlaceholder(locale: EffectiveLocale = 'zh-CN'): string {
  return translate(locale, 'markdownImageLoadFailed');
}

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  currentFilePath: string | null;
  localAssetsEnabled?: boolean;
  workspaceRoot: string | null;
}

export default function AdaptiveMarkdownImage({ alt, currentFilePath, localAssetsEnabled = true, workspaceRoot, className, decoding, height, loading, onError, onLoad, src, style, width, ...props }: Props) {
  const { locale, t } = useI18n();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rawSrc = typeof src === 'string' ? src : '';
  const localAssetIsPending = !!currentFilePath && shouldResolveLocally(rawSrc) && !localAssetsEnabled;
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(localAssetIsPending ? undefined : (rawSrc || undefined));
  const [imageError, setImageError] = useState(false);
  const [measured, setMeasured] = useState<{ loadState: ReadingImageLoadState; naturalWidth: number | null; naturalHeight: number | null }>({ loadState: 'loading', naturalWidth: null, naturalHeight: null });

  useEffect(() => {
    let cancelled = false;
    setImageError(false);
    setMeasured({ loadState: 'loading', naturalWidth: null, naturalHeight: null });
    if (!rawSrc) {
      setResolvedSrc(undefined);
      return;
    }
    if (!currentFilePath || !shouldResolveLocally(rawSrc)) {
      setResolvedSrc(rawSrc);
      return;
    }
    if (!localAssetsEnabled) {
      setResolvedSrc(undefined);
      return;
    }
    getMarkdownImagePreviewUrl({ currentFilePath, workspaceRoot, imageSrc: rawSrc })
      .then((assetUrl) => {
        if (!cancelled) setResolvedSrc(assetUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResolvedSrc(undefined);
          setImageError(true);
          setMeasured({ loadState: 'error', naturalWidth: null, naturalHeight: null });
          emitAppFeedbackError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentFilePath, localAssetsEnabled, locale, rawSrc, workspaceRoot]);

  const syncMeasured = useCallback((img: HTMLImageElement, loadState: ReadingImageLoadState = 'loaded') => {
    setMeasured({ loadState, naturalWidth: img.naturalWidth || null, naturalHeight: img.naturalHeight || null });
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    syncMeasured(img, img.naturalWidth > 0 && img.naturalHeight > 0 ? 'loaded' : 'error');
  }, [resolvedSrc, syncMeasured]);

  const hasAuthorSize = useMemo(() => hasAuthorReadingImageSize({ width, height, style }), [height, style, width]);
  const authorWidthStyle = useMemo(() => toAuthorReadingImageCssSize(width), [width]);
  const authorHeightStyle = useMemo(() => toAuthorReadingImageCssSize(height), [height]);
  const sizing = useMemo(() => classifyReadingImageSize({ naturalWidth: measured.naturalWidth, naturalHeight: measured.naturalHeight, hasAuthorSize, loadState: measured.loadState }), [hasAuthorSize, measured]);
  const mergedStyle = useMemo(() => {
    const next: React.CSSProperties & Record<string, string | number | undefined> = { ...style };
    if (hasAuthorSize && authorWidthStyle !== undefined && next.width == null) next.width = authorWidthStyle;
    if (hasAuthorSize && authorHeightStyle !== undefined && next.height == null) next.height = authorHeightStyle;
    if (sizing.naturalWidth) next['--jinxiu-reading-image-natural-width'] = `${sizing.naturalWidth}px`;
    if (sizing.naturalHeight) next['--jinxiu-reading-image-natural-height'] = `${sizing.naturalHeight}px`;
    if (sizing.aspectRatio) next['--jinxiu-reading-image-aspect-ratio'] = String(sizing.aspectRatio);
    return next;
  }, [authorHeightStyle, authorWidthStyle, hasAuthorSize, sizing, style]);

  if (imageError) {
    const message = t('markdownImageLoadFailed');
    return <span className="image-error" aria-label={message}>{message}</span>;
  }

  return (
    <img
      {...props}
      ref={imgRef}
      src={resolvedSrc}
      alt={alt ?? ''}
      width={width}
      height={height}
      loading={loading ?? 'lazy'}
      decoding={decoding ?? 'async'}
      className={['jinxiu-adaptive-reading-image', className].filter(Boolean).join(' ')}
      data-jinxiu-reading-image="true"
      data-jinxiu-image-context="markdown"
      data-jinxiu-image-size={sizing.bucket}
      data-jinxiu-image-natural-width={sizing.naturalWidth ?? undefined}
      data-jinxiu-image-natural-height={sizing.naturalHeight ?? undefined}
      style={mergedStyle}
      onLoad={(event) => {
        syncMeasured(event.currentTarget);
        onLoad?.(event);
      }}
      onError={(event) => {
        setMeasured({ loadState: 'error', naturalWidth: null, naturalHeight: null });
        onError?.(event);
      }}
    />
  );
}
