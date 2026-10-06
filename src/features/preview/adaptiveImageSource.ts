/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：解析效果依赖保持提取前原样，由 AdaptiveMarkdownImage.test.tsx 回归约束 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { classifyReadingImageSize, hasAuthorReadingImageSize, toAuthorReadingImageCssSize, type ReadingImageLoadState } from '../../lib/markdownImageSizing';
import { getMarkdownImagePreviewUrl } from '../../lib/workspacePreviewSource';

const REMOTE_OR_DATA_RE = /^(?:https?:)?\/\//i;

function shouldResolveLocally(src: string): boolean {
  const trimmed = src.trim();
  return !!trimmed && !REMOTE_OR_DATA_RE.test(trimmed) && !/^data:/i.test(trimmed) && !/^file:/i.test(trimmed) && !trimmed.startsWith('/');
}

export interface AdaptiveImageMeasurement {
  loadState: ReadingImageLoadState;
  naturalHeight: number | null;
  naturalWidth: number | null;
}

// 解析本地相对图片地址；任何一步失败都进入错误态并反馈。
function resolveImageSource(deps: {
  currentFilePath: string;
  imageSrc: string;
  localAssetsEnabled: boolean;
  workspaceRoot: string | null;
}, apply: (resolved: string | undefined) => void, fail: () => void): () => void {
  void getMarkdownImagePreviewUrl({
    currentFilePath: deps.currentFilePath,
    workspaceRoot: deps.workspaceRoot,
    imageSrc: deps.imageSrc,
  })
    .then((assetUrl) => apply(assetUrl))
    .catch((err: unknown) => {
      apply(undefined);
      fail();
      emitAppFeedbackError(err);
    });
  return () => undefined;
}

// 自适应图片源状态：地址解析、加载测量与错误标记。
export function useAdaptiveImageSource(deps: {
  currentFilePath: string | null;
  localAssetsEnabled: boolean;
  rawSrc: string;
  workspaceRoot: string | null;
}) {
  const { currentFilePath, localAssetsEnabled, rawSrc, workspaceRoot } = deps;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const localAssetIsPending = !!currentFilePath && shouldResolveLocally(rawSrc) && !localAssetsEnabled;
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(localAssetIsPending ? undefined : (rawSrc || undefined));
  const [imageError, setImageError] = useState(false);
  const [measured, setMeasured] = useState<AdaptiveImageMeasurement>({ loadState: 'loading', naturalWidth: null, naturalHeight: null });

  useEffect(() => {
    let cancelled = false;
    const apply = (resolved: string | undefined) => { if (!cancelled) setResolvedSrc(resolved); };
    const fail = () => { setImageError(true); setMeasured({ loadState: 'error', naturalWidth: null, naturalHeight: null }); };
    setImageError(false);
    setMeasured({ loadState: 'loading', naturalWidth: null, naturalHeight: null });
    if (!rawSrc) { setResolvedSrc(undefined); return undefined; }
    if (!currentFilePath || !shouldResolveLocally(rawSrc)) { setResolvedSrc(rawSrc); return undefined; }
    if (!localAssetsEnabled) { setResolvedSrc(undefined); return undefined; }
    const release = resolveImageSource({ currentFilePath, imageSrc: rawSrc, localAssetsEnabled, workspaceRoot }, apply, fail);
    return () => {
      cancelled = true;
      release();
    };
  }, [currentFilePath, localAssetsEnabled, rawSrc, workspaceRoot]);

  const syncMeasured = useCallback((img: HTMLImageElement, loadState: ReadingImageLoadState = 'loaded') => {
    setMeasured({ loadState, naturalWidth: img.naturalWidth || null, naturalHeight: img.naturalHeight || null });
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    syncMeasured(img, img.naturalWidth > 0 && img.naturalHeight > 0 ? 'loaded' : 'error');
  }, [resolvedSrc, syncMeasured]);

  const markImageError = useCallback(() => {
    setMeasured({ loadState: 'error', naturalWidth: null, naturalHeight: null });
  }, []);

  return { imageError, imgRef, markImageError, measured, resolvedSrc, syncMeasured };
}

// 阅读尺寸样式：作者声明尺寸优先补齐，测量结果写入 CSS 变量供主题消费。
export function useReadingImageStyle(deps: {
  height: React.ImgHTMLAttributes<HTMLImageElement>['height'];
  measured: AdaptiveImageMeasurement;
  style: React.ImgHTMLAttributes<HTMLImageElement>['style'];
  width: React.ImgHTMLAttributes<HTMLImageElement>['width'];
}) {
  const { height, measured, style, width } = deps;
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
  return { hasAuthorSize, mergedStyle, sizing };
}
