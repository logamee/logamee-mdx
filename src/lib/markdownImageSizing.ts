export type ReadingImageLoadState = 'loading' | 'loaded' | 'error';
export type ReadingImageBucket = 'loading' | 'author' | 'fallback' | 'icon' | 'formula' | 'portrait' | 'tall' | 'wide' | 'standard';

function toPositive(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasMeaningfulCssSize(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || ['auto', 'inherit', 'initial', 'unset'].includes(trimmed)) return false;
  return /^(?:\d+(?:\.\d+)?(?:px|r?em|ch|vw|vh|vmin|vmax|%)?|calc\(|clamp\(|min\(|max\()/i.test(trimmed);
}

export function hasAuthorReadingImageSize(input: { width?: unknown; height?: unknown; style?: { width?: unknown; height?: unknown; maxWidth?: unknown; maxHeight?: unknown } }): boolean {
  return hasMeaningfulCssSize(input.width) || hasMeaningfulCssSize(input.height) || hasMeaningfulCssSize(input.style?.width) || hasMeaningfulCssSize(input.style?.height) || hasMeaningfulCssSize(input.style?.maxWidth) || hasMeaningfulCssSize(input.style?.maxHeight);
}

export function toAuthorReadingImageCssSize(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return hasMeaningfulCssSize(trimmed) ? trimmed : undefined;
}

export function classifyReadingImageSize(input: { naturalWidth?: number | null; naturalHeight?: number | null; hasAuthorSize?: boolean; loadState?: ReadingImageLoadState }): { bucket: ReadingImageBucket; naturalWidth: number | null; naturalHeight: number | null; aspectRatio: number | null } {
  const naturalWidth = toPositive(input.naturalWidth);
  const naturalHeight = toPositive(input.naturalHeight);
  const aspectRatio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : null;
  if (input.hasAuthorSize) return { bucket: 'author', naturalWidth, naturalHeight, aspectRatio };
  if (input.loadState === 'loading') return { bucket: 'loading', naturalWidth, naturalHeight, aspectRatio };
  if (!naturalWidth || !naturalHeight || input.loadState === 'error') return { bucket: 'fallback', naturalWidth, naturalHeight, aspectRatio };
  if (naturalWidth <= 240 && naturalHeight <= 240) return { bucket: 'icon', naturalWidth, naturalHeight, aspectRatio };
  if (aspectRatio !== null && naturalHeight <= 180 && aspectRatio >= 2.8) return { bucket: 'formula', naturalWidth, naturalHeight, aspectRatio };
  if (aspectRatio !== null && (aspectRatio <= 0.55 || (naturalHeight >= 1600 && aspectRatio <= 0.72))) return { bucket: 'tall', naturalWidth, naturalHeight, aspectRatio };
  if (aspectRatio !== null && aspectRatio <= 0.78 && naturalHeight >= 900) return { bucket: 'portrait', naturalWidth, naturalHeight, aspectRatio };
  if (aspectRatio !== null && aspectRatio >= 2.35) return { bucket: 'wide', naturalWidth, naturalHeight, aspectRatio };
  return { bucket: 'standard', naturalWidth, naturalHeight, aspectRatio };
}
