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
