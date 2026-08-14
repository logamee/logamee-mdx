import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PreviewZoomToolbar } from './PreviewZoomToolbar';

describe('PreviewZoomToolbar', () => {
  it('uses stable accessible icon controls and reports the current percentage', () => {
    const html = renderToStaticMarkup(
      <PreviewZoomToolbar
        percent={100}
        onDecrease={vi.fn<() => void>()}
        onIncrease={vi.fn<() => void>()}
        onReset={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Reset zoom"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('100%');
  });

  it('disables only the control at each zoom boundary', () => {
    const minimum = renderToStaticMarkup(
      <PreviewZoomToolbar
        percent={50}
        onDecrease={vi.fn<() => void>()}
        onIncrease={vi.fn<() => void>()}
        onReset={vi.fn<() => void>()}
      />,
    );
    const maximum = renderToStaticMarkup(
      <PreviewZoomToolbar
        percent={200}
        onDecrease={vi.fn<() => void>()}
        onIncrease={vi.fn<() => void>()}
        onReset={vi.fn<() => void>()}
      />,
    );

    expect(minimum).toMatch(/aria-label="Zoom out"[^>]*disabled/);
    expect(minimum).not.toMatch(/aria-label="Zoom in"[^>]*disabled/);
    expect(maximum).toMatch(/aria-label="Zoom in"[^>]*disabled/);
    expect(maximum).not.toMatch(/aria-label="Zoom out"[^>]*disabled/);
  });
});
