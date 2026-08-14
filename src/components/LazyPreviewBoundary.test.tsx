// @vitest-environment jsdom

import { act, lazy, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LazyPreviewBoundary } from './LazyPreviewBoundary';
import { APP_FEEDBACK_ERROR_EVENT } from '../lib/appFeedback';
import { translate } from '../lib/i18n';
import { loadLazyModuleWithRetry } from '../lib/lazyModule';

describe('LazyPreviewBoundary', () => {
  const containers: HTMLDivElement[] = [];

  afterEach(() => {
    containers.splice(0).forEach((container) => container.remove());
  });

  it('keeps an accessible full-size status visible while the preview module loads', async () => {
    const NeverLoadedPreview = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    const container = document.createElement('div');
    const loadingLabel = translate('zh-CN', 'loadingPdf');
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <LazyPreviewBoundary loadingLabel={loadingLabel} locale="zh-CN">
          <NeverLoadedPreview />
        </LazyPreviewBoundary>,
      );
    });

    const loadingRegion = container.querySelector<HTMLElement>('.lazy-preview-loading');
    expect(loadingRegion?.getAttribute('aria-busy')).toBe('true');
    expect(loadingRegion?.tagName).toBe('OUTPUT');
    expect(loadingRegion?.textContent).toBe('正在加载 PDF 预览…');

    act(() => root.unmount());
  });

  it('renders without feedback when a transient module failure succeeds on retry', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const load = vi.fn<() => Promise<{ default: () => ReactElement }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ default: () => <div data-testid="recovered-preview" /> });
    const RecoveredPreview = lazy(() => loadLazyModuleWithRetry(load));
    const feedback = vi.fn<(event: Event) => void>();
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <LazyPreviewBoundary loadingLabel="Loading Excalidraw preview..." locale="en">
            <RecoveredPreview />
          </LazyPreviewBoundary>,
        );
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

      expect(load).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-testid="recovered-preview"]')).not.toBeNull();
      expect(feedback).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    }
  });

  it('keeps the React root mounted and emits shared modal feedback when the module rejects', async () => {
    const FailedPreview = lazy(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const feedback = vi.fn<(event: Event) => void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    const root = createRoot(container);

    try {
      await expect(act(async () => {
        root.render(
          <LazyPreviewBoundary loadingLabel="Loading PDF preview..." locale="en">
            <FailedPreview />
          </LazyPreviewBoundary>,
        );
      })).resolves.toBeUndefined();

      expect(feedback).toHaveBeenCalledOnce();
      expect((feedback.mock.calls[0][0] as CustomEvent<string>).detail)
        .toBe('Failed to fetch dynamically imported module');
      expect(container.querySelector('.lazy-preview-loading.is-failed')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
      consoleError.mockRestore();
    }
  });
});
