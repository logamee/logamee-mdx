import { describe, expect, it } from 'vitest';
import { PREVIEW_ZOOM_POLICY, reducePreviewZoom } from './previewZoom';

describe('preview zoom policy', () => {
  it('defines one shared 50-200 percent policy with 10 percent steps and 100 percent reset', () => {
    expect(PREVIEW_ZOOM_POLICY).toEqual({
      defaultPercent: 100,
      maxPercent: 200,
      minPercent: 50,
      stepPercent: 10,
    });
  });

  it('increments, decrements, resets, and clamps deterministically', () => {
    expect(reducePreviewZoom(100, 'increase')).toBe(110);
    expect(reducePreviewZoom(100, 'decrease')).toBe(90);
    expect(reducePreviewZoom(170, 'reset')).toBe(100);
    expect(reducePreviewZoom(200, 'increase')).toBe(200);
    expect(reducePreviewZoom(50, 'decrease')).toBe(50);
    expect(reducePreviewZoom(195, 'increase')).toBe(200);
    expect(reducePreviewZoom(55, 'decrease')).toBe(50);
  });
});
