import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HtmlPreviewFrame, HtmlPreviewSurface, WorkspaceHtmlPreview } from './WorkspaceHtmlPreview';

describe('WorkspaceHtmlPreview', () => {
  it('shows a loading state while the loopback preview is prepared', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHtmlPreview content="<h1>Hello</h1><script>alert(1)</script>" path="/workspace/site/index.html" />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Starting HTML preview service');
    expect(html).not.toContain('srcDoc=');
  });

  it('does not expose a preview frame before document authority is committed', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHtmlPreview
        content="<h1>Pending</h1>"
        enabled={false}
        path="/workspace/site/index.html"
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<iframe');
  });

  it('renders the loopback page with scripts and same-origin behavior enabled', () => {
    const html = renderToStaticMarkup(
      <HtmlPreviewFrame
        name="index.html"
        url="http://127.0.0.1:43127/site/index.html?mmdPreview=2"
      />,
    );

    expect(html).toContain('title="HTML Preview: index.html"');
    expect(html).toContain('src="http://127.0.0.1:43127/site/index.html?mmdPreview=2"');
    expect(html).toContain('allow-scripts');
    expect(html).toContain('allow-same-origin');
    expect(html).not.toContain('srcDoc=');
  });

  it('covers the frame with an animated status until external resources finish loading', () => {
    const loadingHtml = renderToStaticMarkup(
      <HtmlPreviewSurface
        loaded={false}
        name="index.html"
        onLoad={() => undefined}
        url="http://127.0.0.1:43127/site/index.html"
      />,
    );
    const loadedHtml = renderToStaticMarkup(
      <HtmlPreviewSurface
        loaded
        name="index.html"
        onLoad={() => undefined}
        url="http://127.0.0.1:43127/site/index.html"
      />,
    );

    expect(loadingHtml).toContain('workspace-html-spinner');
    expect(loadingHtml).toContain('Loading page and external resources');
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain('workspace-html-frame');
    expect(loadedHtml).not.toContain('Loading page and external resources');
    expect(loadedHtml).not.toContain('workspace-html-spinner');
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe as describeDom, it as itDom, vi } from 'vitest';
import { useWorkspaceHtmlPreviewSource } from './workspaceHtmlPreviewSource';

const prepareHtmlPreviewMock = vi.fn<() => Promise<string>>();

vi.mock('../../lib/tauriCommands', () => ({
  prepareHtmlPreview: (...args: unknown[]) => prepareHtmlPreviewMock(...(args as [])),
}));

describeDom('workspace html preview source', () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: { failed: boolean; previewUrl: string | null };

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    prepareHtmlPreviewMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderSource(enabled: boolean, path = '/workspace/site/index.html'): void {
    function Probe(): null {
      state = useWorkspaceHtmlPreviewSource({ content: '<h1>hi</h1>', enabled, path });
      return null;
    }
    act(() => root.render(<Probe />));
  }

  itDom('prepares a versioned preview url after the debounce', async () => {
    prepareHtmlPreviewMock.mockResolvedValue('http://127.0.0.1:1/site/index.html');
    renderSource(true);
    expect(state.previewUrl).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.previewUrl).toContain('mmdPreview=');
    expect(state.failed).toBe(false);
  });

  itDom('clears state and reports failure through the debounced rejection', async () => {
    prepareHtmlPreviewMock.mockRejectedValue(new Error('nope'));
    renderSource(true);
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.failed).toBe(true);
    expect(state.previewUrl).toBeNull();
  });

  itDom('ignores resolutions that arrive after a path change', async () => {
    let resolveFirst!: (url: string) => void;
    prepareHtmlPreviewMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    prepareHtmlPreviewMock.mockResolvedValueOnce('http://127.0.0.1:2/other.html');
    renderSource(true, '/workspace/site/a.html');
    await act(async () => { vi.advanceTimersByTime(200); });
    renderSource(true, '/workspace/site/b.html');
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      resolveFirst('http://127.0.0.1:1/stale.html');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.previewUrl).toContain('other.html');
  });

  itDom('keeps the preview null while disabled', () => {
    renderSource(false);
    expect(state.previewUrl).toBeNull();
    expect(prepareHtmlPreviewMock).not.toHaveBeenCalled();
  });
});
