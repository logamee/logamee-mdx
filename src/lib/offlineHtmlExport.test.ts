// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { buildOfflineHtml } from './offlineHtmlExport';

describe('buildOfflineHtml', () => {
  it('uses the mdx product name for an untitled export', () => {
    const html = buildOfflineHtml({
      title: '',
      bodyHtml: '<p>Draft</p>',
      themeCss: '',
      theme: 'light',
      skin: 'original',
    });

    expect(html).toContain('<title>mdx export</title>');
  });

  it('inlines safe assets, removes scripts, and hardens external links', () => {
    const html = buildOfflineHtml({
      title: 'Report <x>',
      bodyHtml: '<h1>Hi</h1><img src="local.png"><script>alert(1)</script><a href="https://example.test">x</a>',
      themeCss: '.x { color: red }',
      theme: 'dark',
      skin: 'shanshui-yemo',
      assetDataUrls: { 'local.png': 'data:image/png;base64,AA==' },
    });
    expect(html).toContain('class="dark"');
    expect(html).toContain('data-skin="shanshui-yemo"');
    expect(html).toContain('data:image/png;base64,AA==');
    expect(html).not.toContain('<script');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('Report &lt;x&gt;');
  });
});
