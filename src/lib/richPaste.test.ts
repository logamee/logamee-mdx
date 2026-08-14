// @vitest-environment jsdom

import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import {
  RICH_PASTE_LIMITS,
  RichPasteConversionError,
  convertRichClipboardPayload,
  convertRichClipboardToMarkdown,
} from './richPaste';

describe('rich clipboard paste conversion', () => {
  it('converts Word-ish HTML to deterministic Markdown', () => {
    const markdown = convertRichClipboardToMarkdown({
      html: `
        <!--StartFragment-->
        <h1 style="mso-style-name:Title" onclick="alert(1)"> Report&nbsp;Title </h1>
        <p class="MsoNormal"><b>Bold</b>, <i>italic</i>, <span style="mso-bidi-font-weight:bold">plain</span><br>next line</p>
        <blockquote><p>quoted <s>old</s></p></blockquote>
        <!--EndFragment-->
      `,
    });

    expect(markdown).toBe([
      '# Report Title',
      '',
      '**Bold**, *italic*, plain  ',
      'next line',
      '',
      '> quoted ~~old~~',
    ].join('\n'));
  });

  it('supports tables, lists, task items, code, and safe links', () => {
    const markdown = convertRichClipboardToMarkdown({
      html: `
        <p><a href="https://example.test/a b?q=1">safe</a> <a href="mailto:me@example.test">mail</a> <a href="docs/page.md">relative</a> <a href="javascript:alert(1)">bad</a></p>
        <ul><li>one</li><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul>
        <ol start="3"><li>third</li><li>fourth</li></ol>
        <pre><code>const value = ` + '`tick`' + `;\nconsole.log(value);</code></pre>
        <p>Use <code>a|b</code> inline.</p>
        <table><thead><tr><th>Name</th><th>Value|Pipe</th></tr></thead><tbody><tr><td>A</td><td><strong>B</strong></td></tr></tbody></table>
      `,
    });

    expect(markdown).toBe([
      '[safe](https://example.test/a%20b?q=1) [mail](mailto:me@example.test) [relative](docs/page.md) bad',
      '',
      '- one',
      '- [x] done',
      '- [ ] todo',
      '',
      '3. third',
      '4. fourth',
      '',
      '```',
      'const value = `tick`;',
      'console.log(value);',
      '```',
      '',
      'Use `a|b` inline.',
      '',
      '| Name | Value\\|Pipe |',
      '| --- | --- |',
      '| A | **B** |',
    ].join('\n'));
  });

  it('strips malicious HTML, remote images, temp-file images, and unsafe links', () => {
    const markdown = convertRichClipboardToMarkdown({
      html: `
        <script>alert(1)</script><style>body{display:none}</style>
        <p><img src="https://tracker.example/pixel.png" onerror="alert(1)">Hello
        <img src="file:///tmp/screenshot.png"><img src="blob:https://example.test/id"><img src="data:image/png;base64,AAAA"></p>
        <p><a href="http://tracker.example">http</a> <a href="//tracker.example">protocol</a> <a href="/safe/path">root</a></p>
      `,
    });

    expect(markdown).toBe('Hello\n\nhttp protocol [root](/safe/path)');
    expect(markdown).not.toContain('script');
    expect(markdown).not.toContain('tracker.example');
    expect(markdown).not.toContain('file:///tmp');
    expect(markdown).not.toContain('blob:');
    expect(markdown).not.toContain('data:image');
  });

  it('falls back to plain clipboard text, including RTF/PDF extracted text', () => {
    expect(convertRichClipboardToMarkdown({ text: '  copied PDF line 1\r\nline 2  ' }))
      .toBe('copied PDF line 1\nline 2');
    expect(convertRichClipboardToMarkdown({ rtf: String.raw`{\rtf1\ansi\b Bold\b0\par Plain}` }))
      .toBe('Bold\nPlain');
  });


  it('falls back from unusable rich HTML to RTF and then cleaned plain text with formatting-loss metadata', () => {
    expect(convertRichClipboardPayload({
      html: '<script>alert(1)</script>',
      rtf: String.raw`{\rtf1 Rich\par Text}`,
      text: 'plain fallback',
    })).toEqual(expect.objectContaining({
      markdown: 'Rich\nText',
      source: 'rtf',
      formattingLoss: false,
    }));

    expect(convertRichClipboardPayload({
      html: '<script>alert(1)</script>',
      rtf: String.raw`{\rtf1{\fonttbl{\f0 Arial;}}}`, 
      text: ' cleaned plain ',
    })).toEqual(expect.objectContaining({
      markdown: 'cleaned plain',
      source: 'text',
      formattingLoss: true,
    }));
  });

  it('parses realistic bounded RTF destinations, CP1252 hex, unicode fallbacks, and paragraphs', () => {
    const markdown = convertRichClipboardToMarkdown({
      rtf: String.raw`{\rtf1\ansi\uc1{\fonttbl{\f0 Arial;}}{\colortbl;\red255\green0\blue0;}Plain \'93quote\'94\par Unicode \u20320? text{\*\htmltag <b>ignored</b>}\par End}`,
    });

    expect(markdown).toBe('Plain “quote”\nUnicode 你 text\nEnd');
    expect(markdown).not.toContain('Arial');
    expect(markdown).not.toContain('ignored');
  });

  it('normalizes PDF-origin plain text conservatively without inventing structure', () => {
    expect(convertRichClipboardToMarkdown({
      plainTextKind: 'pdf',
      text: 'hyphen-\nated text\nleft column    right column\n\nnext paragraph',
    })).toBe('hyphenated text\nleft column    right column\n\nnext paragraph');
  });

  it('fails closed for empty, unsupported, oversized, or overly complex input', () => {
    expect(() => convertRichClipboardToMarkdown({ html: '<script>alert(1)</script>' }))
      .toThrow(RichPasteConversionError);
    expect(() => convertRichClipboardToMarkdown({}))
      .toThrow(RichPasteConversionError);
    expect(() => convertRichClipboardToMarkdown({ html: 'x'.repeat(RICH_PASTE_LIMITS.maxInputBytes + 1) }))
      .toThrow('too large');
    expect(() => convertRichClipboardToMarkdown({ html: '<br>'.repeat(5) }, { maxSanitizedNodes: 4 }))
      .toThrow('too complex');
  });

  it('fails closed when DOMPurify support is unavailable', () => {
    const originalSupport = DOMPurify.isSupported;
    DOMPurify.isSupported = false;
    try {
      expect(() => convertRichClipboardToMarkdown({ html: '<p>Safe</p>' }))
        .toThrow(RichPasteConversionError);
    } finally {
      DOMPurify.isSupported = originalSupport;
    }
  });
});
