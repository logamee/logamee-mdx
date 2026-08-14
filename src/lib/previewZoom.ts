export const PREVIEW_ZOOM_POLICY = {
  defaultPercent: 100,
  maxPercent: 200,
  minPercent: 50,
  stepPercent: 10,
} as const;

export type PreviewZoomAction = 'increase' | 'decrease' | 'reset';

export function reducePreviewZoom(currentPercent: number, action: PreviewZoomAction): number {
  if (action === 'reset') return PREVIEW_ZOOM_POLICY.defaultPercent;
  const delta = action === 'increase'
    ? PREVIEW_ZOOM_POLICY.stepPercent
    : -PREVIEW_ZOOM_POLICY.stepPercent;
  return Math.min(
    PREVIEW_ZOOM_POLICY.maxPercent,
    Math.max(PREVIEW_ZOOM_POLICY.minPercent, currentPercent + delta),
  );
}
