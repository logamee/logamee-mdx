import React from 'react';
import { translate, useI18n } from '../../lib/i18n';
import type { EffectiveLocale } from '../../lib/locale';
import { useAdaptiveImageSource, useReadingImageStyle } from './adaptiveImageSource';

export function getMarkdownImageErrorPlaceholder(locale: EffectiveLocale = 'zh-CN'): string {
  return translate(locale, 'markdownImageLoadFailed');
}

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  currentFilePath: string | null;
  localAssetsEnabled?: boolean;
  workspaceRoot: string | null;
}

export default function AdaptiveMarkdownImage({ alt, currentFilePath, localAssetsEnabled = true, workspaceRoot, className, decoding, height, loading, onError, onLoad, src, style, width, ...props }: Props) {
  const { t } = useI18n();
  const rawSrc = typeof src === 'string' ? src : '';
  const { imageError, imgRef, markImageError, measured, resolvedSrc, syncMeasured } = useAdaptiveImageSource({
    currentFilePath, localAssetsEnabled, rawSrc, workspaceRoot,
  });

  const { sizing, mergedStyle } = useReadingImageStyle({ height, measured, style, width });

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
        markImageError();
        onError?.(event);
      }}
    />
  );
}
