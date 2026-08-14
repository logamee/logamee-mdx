// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { collectOfflineExportAssets, inlineCssResourceUrls } from './exportAssetInlining';

describe('export asset inlining', () => {
  it('replaces CSS URLs with data URLs', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'font/woff2' } }));
    await expect(inlineCssResourceUrls('@font-face{src:url("./font.woff2")}', 'https://app.local/css/main.css', fetcher)).resolves.toContain('data:font/woff2;base64,AQI=');
    expect(fetcher).toHaveBeenCalledWith('https://app.local/css/font.woff2');
  });

  it('collects rendered image bytes using the DOM source key', async () => {
    const root = document.createElement('main');
    root.innerHTML = '<img src="asset.png">';
    const result = await collectOfflineExportAssets(root, async () => new Response(new Uint8Array([137, 80]), { headers: { 'content-type': 'image/png' } }));
    expect(result.assetDataUrls['asset.png']).toBe('data:image/png;base64,iVA=');
  });

  it('fails closed when a stylesheet is unreadable', async () => {
    const sheet = Object.create(CSSStyleSheet.prototype) as CSSStyleSheet;
    Object.defineProperty(sheet, 'cssRules', { get: () => { throw new Error('cross-origin'); } });
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([sheet] as unknown as StyleSheetList);
    await expect(collectOfflineExportAssets(document.createElement('main'))).rejects.toThrow('Export stylesheet could not be read');
  });
});
