import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AdaptiveMarkdownImage, { getMarkdownImageErrorPlaceholder } from './AdaptiveMarkdownImage';

describe('AdaptiveMarkdownImage feedback helpers', () => {
  it('does not resolve or expose local assets before document authority is committed', () => {
    const html = renderToStaticMarkup(
      <AdaptiveMarkdownImage
        currentFilePath="/workspace/document.md"
        localAssetsEnabled={false}
        src="images/diagram.png"
        workspaceRoot="/workspace"
      />,
    );

    expect(html).toContain('<img');
    expect(html).not.toContain('src="images/diagram.png"');
  });

  it('uses a non-technical placeholder for failed image resolution', () => {
    const placeholder = getMarkdownImageErrorPlaceholder();
    const html = renderToStaticMarkup(<span className="image-error" aria-label={placeholder}>{placeholder}</span>);

    expect(placeholder).toBe('⚠ 图片暂时无法显示');
    expect(html).toContain('图片暂时无法显示');
    expect(html).not.toContain('Failed to read image');
    expect(html).not.toContain('Image file not found');
    expect(html).not.toContain('permission denied');
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach } from 'vitest';

describe('AdaptiveMarkdownImage failure placeholder', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the placeholder after local resolution fails', async () => {
    act(() => root.render(
      <AdaptiveMarkdownImage
        currentFilePath="/workspace/doc.md"
        src="images/missing.png"
        workspaceRoot="/workspace"
      />,
    ));
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    });
    const settled = container.querySelector('.image-error') ?? container.querySelector('img');
    expect(settled).not.toBeNull();
  });

  it('renders the remote image directly and applies lazy defaults', () => {
    act(() => root.render(
      <AdaptiveMarkdownImage
        currentFilePath={null}
        src="https://example.com/a.png"
        workspaceRoot={null}
        width={120}
        height={80}
      />,
    ));
    const img = container.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
    expect(img?.getAttribute('width')).toBe('120');
    expect(img?.getAttribute('data-jinxiu-reading-image')).toBe('true');
  });

  it('measures on load and marks failures through image handlers', () => {
    const events: string[] = [];
    act(() => root.render(
      <AdaptiveMarkdownImage
        currentFilePath={null}
        src="https://example.com/a.png"
        workspaceRoot={null}
        onLoad={() => events.push('load')}
        onError={() => events.push('error')}
      />,
    ));
    const img = container.querySelector('img');
    act(() => {
      img?.dispatchEvent(new Event('load'));
      img?.dispatchEvent(new Event('error'));
    });
    expect(events).toEqual(['load', 'error']);
  });
});
