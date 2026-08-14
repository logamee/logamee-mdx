// @vitest-environment jsdom

import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { DocxImageRegistry, DOCX_PREVIEW_LIMITS } from './docxResources';
import {
  DOCX_ALLOWED_ATTRIBUTES,
  DOCX_ALLOWED_TAGS,
  DocxSanitizationError,
  sanitizeDocxHtml,
} from './docxSanitizer';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('DOCX HTML sanitization', () => {
  it('uses an exact HTML-only tag and attribute allowlist', () => {
    expect(DOCX_ALLOWED_TAGS).toEqual([
      'a', 'b', 'blockquote', 'br', 'caption', 'code', 'em', 'h1', 'h2', 'h3',
      'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's',
      'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
      'tr', 'u', 'ul',
    ]);
    expect(DOCX_ALLOWED_ATTRIBUTES).toEqual([
      'alt', 'colspan', 'height', 'href', 'rowspan', 'scope', 'src', 'start',
      'title', 'width',
    ]);
  });

  it('keeps only absolute HTTPS/mailto links and exact registered image placeholders', () => {
    const registry = new DocxImageRegistry(() => 'abcdefabcdefabcdefabcdefabcdefab');
    const image = registry.register('image/png', pngBytes(3, 2));
    const rawHtml = [
      '<svg><script>alert(1)</script><circle /></svg>',
      '<math><mi>x</mi></math>',
      '<p id="named" href="https://leak.example" title="leak" style="color:red" onclick="alert(1)">Safe text</p>',
      '<a href="https://safe.example/path">HTTPS</a>',
      '<a href="mailto:person@example.com">Mail</a>',
      '<a href="http://unsafe.example">HTTP</a>',
      '<a href="/relative">Relative</a>',
      '<a href="javascript:alert(1)">Script</a>',
      '<ol start=" +0002 "><li>Item</li></ol>',
      '<table><tbody><tr>',
      '<th colspan="0002" scope="ROW">Head</th>',
      '<td rowspan="0" scope="auto">Cell</td>',
      '<td rowspan="0003" scope="COLGROUP">Span</td>',
      '</tr></tbody></table>',
      `<img src="${image.placeholder}" alt="embedded" width="0003" height="+2" onerror="alert(1)">`,
      '<img src="https://remote.example/image.png" alt="remote">',
      '<img src="data:image/png;base64,AAAA" alt="raw-data">',
      '<img src="blob:https://safe.example/id" alt="blob">',
      '<img src="https://ffffffffffffffffffffffffffffffff.invalid/image/1" alt="fake">',
    ].join('');

    const result = sanitizeDocxHtml(rawHtml, registry.images);
    const document = new DOMParser().parseFromString(result.html, 'text/html');
    const links = [...document.querySelectorAll('a')];
    const images = [...document.querySelectorAll('img')];

    expect(result.nodeCount).toBeGreaterThan(0);
    expect(document.querySelector('svg, math, script, style')).toBeNull();
    expect(document.querySelector('[onclick], [onerror], [style], [id]')).toBeNull();
    expect(document.querySelector('p')?.attributes).toHaveLength(0);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://safe.example/path',
      'mailto:person@example.com',
      null,
      null,
      null,
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(images[0]?.getAttribute('alt')).toBe('embedded');
    expect(images[0]?.getAttribute('width')).toBe('3');
    expect(images[0]?.getAttribute('height')).toBe('2');
    expect(document.querySelector('ol')?.getAttribute('start')).toBe('2');
    expect(document.querySelector('th')?.getAttribute('colspan')).toBe('2');
    expect(document.querySelector('th')?.getAttribute('scope')).toBe('row');
    expect(document.querySelector('td')?.hasAttribute('rowspan')).toBe(false);
    expect(document.querySelector('td')?.hasAttribute('scope')).toBe(false);
    expect(document.querySelectorAll('td')[1]?.getAttribute('rowspan')).toBe('3');
    expect(document.querySelectorAll('td')[1]?.getAttribute('scope')).toBe('colgroup');
    expect(result.html).not.toContain(image.placeholder);
    expect(result.html).not.toContain('remote.example');
    expect(result.html).not.toContain('blob:');
    expect(result.html).not.toContain('raw-data');
    expect(result.html).not.toContain('fake');
  });

  it('rejects raw conversion HTML over four MiB before sanitization', () => {
    expect(() => sanitizeDocxHtml(
      'x'.repeat(DOCX_PREVIEW_LIMITS.maxHtmlBytes + 1),
      [],
    )).toThrow(DocxSanitizationError);
  });

  it('rejects sanitized output over fifty thousand nodes', () => {
    expect(DOCX_PREVIEW_LIMITS.maxSanitizedNodes).toBe(50_000);
    expect(() => sanitizeDocxHtml(
      '<br>'.repeat(5),
      [],
      { maxSanitizedNodes: 4 },
    )).toThrow('too complex');
    expect(() => sanitizeDocxHtml(
      '<p>Safe</p>',
      [],
      { maxSanitizedNodes: DOCX_PREVIEW_LIMITS.maxSanitizedNodes + 1 },
    )).toThrow(DocxSanitizationError);
  });

  it('removes malformed and out-of-range layout attributes', () => {
    const registry = new DocxImageRegistry(() => '1234567890abcdef1234567890abcdef');
    const image = registry.register('image/png', pngBytes(3, 2));
    const result = sanitizeDocxHtml([
      '<ol start="50001"><li>Item</li></ol>',
      '<table><tbody><tr><td colspan="1001" rowspan="Infinity" scope="auto">Cell</td></tr></tbody></table>',
      `<img src="${image.placeholder}" width="0" height="24.5" alt="image">`,
    ].join(''), registry.images);
    const document = new DOMParser().parseFromString(result.html, 'text/html');

    expect(document.querySelector('ol')?.hasAttribute('start')).toBe(false);
    expect(document.querySelector('td')?.hasAttribute('colspan')).toBe(false);
    expect(document.querySelector('td')?.hasAttribute('rowspan')).toBe(false);
    expect(document.querySelector('td')?.hasAttribute('scope')).toBe(false);
    expect(document.querySelector('img')?.hasAttribute('width')).toBe(false);
    expect(document.querySelector('img')?.hasAttribute('height')).toBe(false);
  });

  it('fails closed when DOMPurify support is unavailable', () => {
    const originalSupport = DOMPurify.isSupported;
    DOMPurify.isSupported = false;
    try {
      expect(() => sanitizeDocxHtml('<p>Safe</p>', []))
        .toThrow(DocxSanitizationError);
    } finally {
      DOMPurify.isSupported = originalSupport;
    }
  });

  it('treats empty usable output as a total conversion failure', () => {
    expect(() => sanitizeDocxHtml('<script>alert(1)</script><p> </p>', []))
      .toThrow(DocxSanitizationError);
  });
});
