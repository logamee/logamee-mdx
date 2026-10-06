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

interface ReadingImageFacts {
  aspectRatio: number | null;
  hasAuthorSize: boolean;
  loadState: ReadingImageLoadState;
  naturalHeight: number | null;
  naturalWidth: number | null;
}

// 各桶判定按优先级排列；首条命中即返回。
const READING_IMAGE_BUCKETS: ReadonlyArray<{
  bucket: ReadingImageBucket;
  when: (facts: ReadingImageFacts) => boolean;
}> = [
  { bucket: 'author', when: (f) => f.hasAuthorSize },
  { bucket: 'loading', when: (f) => f.loadState === 'loading' },
  { bucket: 'fallback', when: (f) => !f.naturalWidth || !f.naturalHeight || f.loadState === 'error' },
  { bucket: 'icon', when: (f) => (f.naturalWidth ?? 0) <= 240 && (f.naturalHeight ?? 0) <= 240 },
  { bucket: 'formula', when: (f) => f.aspectRatio !== null && (f.naturalHeight ?? 0) <= 180 && f.aspectRatio >= 2.8 },
  {
    bucket: 'tall',
    when: (f) => f.aspectRatio !== null
      && (f.aspectRatio <= 0.55 || ((f.naturalHeight ?? 0) >= 1600 && f.aspectRatio <= 0.72)),
  },
  {
    bucket: 'portrait',
    when: (f) => f.aspectRatio !== null && f.aspectRatio <= 0.78 && (f.naturalHeight ?? 0) >= 900,
  },
  { bucket: 'wide', when: (f) => f.aspectRatio !== null && f.aspectRatio >= 2.35 },
];

export function classifyReadingImageSize(input: { naturalWidth?: number | null; naturalHeight?: number | null; hasAuthorSize?: boolean; loadState?: ReadingImageLoadState }): { bucket: ReadingImageBucket; naturalWidth: number | null; naturalHeight: number | null; aspectRatio: number | null } {
  const naturalWidth = toPositive(input.naturalWidth);
  const naturalHeight = toPositive(input.naturalHeight);
  const aspectRatio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : null;
  const facts: ReadingImageFacts = {
    aspectRatio,
    hasAuthorSize: Boolean(input.hasAuthorSize),
    loadState: input.loadState ?? 'loaded',
    naturalHeight,
    naturalWidth,
  };
  const matched = READING_IMAGE_BUCKETS.find(({ when }) => when(facts));
  const bucket = matched ? matched.bucket : 'standard';
  return { bucket, naturalWidth, naturalHeight, aspectRatio };
}
