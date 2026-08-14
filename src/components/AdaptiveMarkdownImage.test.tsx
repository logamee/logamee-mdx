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
