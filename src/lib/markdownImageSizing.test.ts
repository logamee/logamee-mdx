import { describe, expect, it } from 'vitest';
import { classifyReadingImageSize, hasAuthorReadingImageSize, toAuthorReadingImageCssSize } from './markdownImageSizing';

describe('markdown image sizing', () => {
  it('detects explicit author image dimensions from attributes and styles', () => {
    expect(hasAuthorReadingImageSize({ width: 320 })).toBe(true);
    expect(hasAuthorReadingImageSize({ height: ' 24rem ' })).toBe(true);
    expect(hasAuthorReadingImageSize({ style: { maxWidth: 'min(100%, 720px)' } })).toBe(true);
  });

  it('ignores empty, non-positive, and automatic author dimensions', () => {
    expect(hasAuthorReadingImageSize({ width: 0, height: -4 })).toBe(false);
    expect(hasAuthorReadingImageSize({ width: 'auto', style: { maxWidth: ' unset ' } })).toBe(false);
    expect(toAuthorReadingImageCssSize('inherit')).toBeUndefined();
  });

  it('preserves meaningful author CSS dimension values', () => {
    expect(toAuthorReadingImageCssSize(480)).toBe(480);
    expect(toAuthorReadingImageCssSize(' 75% ')).toBe('75%');
    expect(toAuthorReadingImageCssSize('clamp(240px, 50vw, 720px)')).toBe('clamp(240px, 50vw, 720px)');
  });

  it.each([
    [{ loadState: 'loading' as const }, 'loading'],
    [{ loadState: 'error' as const, naturalWidth: 100, naturalHeight: 100 }, 'fallback'],
    [{ naturalWidth: 96, naturalHeight: 96 }, 'icon'],
    [{ naturalWidth: 640, naturalHeight: 120 }, 'formula'],
    [{ naturalWidth: 500, naturalHeight: 1200 }, 'tall'],
    [{ naturalWidth: 650, naturalHeight: 1000 }, 'portrait'],
    [{ naturalWidth: 1800, naturalHeight: 600 }, 'wide'],
    [{ naturalWidth: 900, naturalHeight: 600 }, 'standard'],
  ])('classifies loaded images into the %s bucket', (input, bucket) => {
    expect(classifyReadingImageSize(input).bucket).toBe(bucket);
  });

  it('lets author sizing override measured image buckets', () => {
    const sizing = classifyReadingImageSize({ naturalWidth: 96, naturalHeight: 96, hasAuthorSize: true });

    expect(sizing.bucket).toBe('author');
    expect(sizing.aspectRatio).toBe(1);
  });
});
