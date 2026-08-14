// @ts-expect-error Vitest executes this contract in Node; the app tsconfig excludes Node globals.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest provides jsdom at runtime; the app does not ship its test-only types.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { SKIN_IDS, type SkinId } from '../lib/theme';
import { CANONICAL_THEME_TOKENS } from './themeTokens';

const baseCss = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const typoraCss = readFileSync(
  new URL('../../public/styles/typora-theme/typora-jinxiu.css', import.meta.url),
  'utf8',
);
const markdownPreviewCss = readFileSync(new URL('./markdown-preview.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const jinxiuMarkdownSource = readFileSync(
  new URL('../components/JinxiuMarkdown.tsx', import.meta.url),
  'utf8',
);
const applicationCss = [
  baseCss,
  readFileSync(new URL('./app-shell.css', import.meta.url), 'utf8'),
  markdownPreviewCss,
  readFileSync(new URL('./responsive.css', import.meta.url), 'utf8'),
].join('\n');

function declarationsFor(selector: string): Set<string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = baseCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `missing selector ${selector}`).not.toBeNull();
  return new Set([...match![1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((item) => item[1]));
}

interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const REPRESENTATIVE_ROOT_STYLES: Record<SkinId, {
  readonly appearance: 'light' | 'dark';
  readonly editor: string;
  readonly preview: string;
  readonly selection: string;
  readonly toolbar: string;
}> = {
  original: {
    appearance: 'light', editor: '#ffffff', preview: '#ffffff', selection: '#264783', toolbar: '#f8fafc',
  },
  'jinxiu-zhusha': {
    appearance: 'light', editor: '#ffffff', preview: '#ffffff', selection: '#a13d32', toolbar: '#f7f7f5',
  },
  'ruyao-tianqing': {
    appearance: 'light', editor: '#fcfdfc', preview: '#fcfdfc', selection: '#3f6f73', toolbar: '#f3f6f3',
  },
  'qinghua-jilan': {
    appearance: 'light', editor: '#ffffff', preview: '#ffffff', selection: '#235ba8', toolbar: '#f7f8fa',
  },
  'songke-zhuying': {
    appearance: 'light', editor: '#fefefc', preview: '#fefefc', selection: '#526b3f', toolbar: '#f5f6f2',
  },
  'gujuan-nuanxing': {
    appearance: 'light', editor: '#fff7e8', preview: '#fff7e8', selection: '#8b4b08', toolbar: '#f2dfba',
  },
  'zhuying-qingci': {
    appearance: 'light', editor: '#f3faf4', preview: '#f3faf4', selection: '#257432', toolbar: '#d3ebd8',
  },
  'jiushu-huangzhi': {
    appearance: 'light', editor: '#fdfae6', preview: '#fdfae6', selection: '#544a3b', toolbar: '#e9dfc1',
  },
  'shanshui-yemo': {
    appearance: 'dark', editor: '#202421', preview: '#202421', selection: '#72a18f', toolbar: '#1c201e',
  },
};

const NORMAL_TEXT_PAIRS = [
  ['chrome text on toolbar', '--chrome-text', '--toolbar'],
  ['body text on panel', '--text-main', '--panel'],
  ['muted text on panel', '--text-muted', '--panel'],
  ['editor text on editor', '--editor-text', '--editor-bg'],
  ['editor gutter text on gutter', '--editor-gutter-text', '--editor-gutter-bg'],
  ['preview text on preview', '--text-reading', '--preview-bg'],
  ['code text on code block', '--code-text', '--code-bg'],
  ['selected text on selected row', '--selection-foreground', '--selection-strong'],
  ['button text on accent', '--accent-foreground', '--accent'],
  ['Mermaid primary text on node', '--mermaid-primary-text', '--mermaid-primary'],
  ['Mermaid secondary text on node', '--mermaid-secondary-text', '--mermaid-secondary'],
] as const;

const LARGE_TEXT_PAIRS = [
  ['preview heading on preview', '--preview-heading', '--preview-bg'],
  ['secondary heading text on heading tag', '--theme-emphasis-foreground', '--theme-emphasis'],
] as const;

function parseColor(value: string): RgbaColor {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    return {
      red: Number.parseInt(hex[1].slice(0, 2), 16),
      green: Number.parseInt(hex[1].slice(2, 4), 16),
      blue: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }
  const functional = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/);
  if (functional) {
    return {
      red: Number(functional[1]),
      green: Number(functional[2]),
      blue: Number(functional[3]),
      alpha: functional[4] === undefined ? 1 : Number(functional[4]),
    };
  }
  throw new Error(`Unsupported CSS color: ${value}`);
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  const channel = (foregroundChannel: number, backgroundChannel: number) => (
    (foregroundChannel * foreground.alpha
      + backgroundChannel * background.alpha * (1 - foreground.alpha)) / alpha
  );
  return {
    red: channel(foreground.red, background.red),
    green: channel(foreground.green, background.green),
    blue: channel(foreground.blue, background.blue),
    alpha,
  };
}

function relativeLuminance(color: RgbaColor): number {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const opaqueBackground = composite(parseColor(background), parseColor('#ffffff'));
  const renderedForeground = composite(parseColor(foreground), opaqueBackground);
  const foregroundLuminance = relativeLuminance(renderedForeground);
  const backgroundLuminance = relativeLuminance(opaqueBackground);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function renderedRoot(skin: SkinId, appearance = REPRESENTATIVE_ROOT_STYLES[skin].appearance) {
  const dom = new JSDOM(
    `<!doctype html><html data-skin="${skin}" data-appearance="${appearance}"><head><style>${baseCss}</style></head></html>`,
  );
  const computed = dom.window.getComputedStyle(dom.window.document.documentElement);
  return {
    colorScheme: computed.colorScheme,
    token: (name: string) => computed.getPropertyValue(name).trim().toLowerCase(),
  };
}

describe('application skin CSS contract', () => {
  it('loads the shipped Typora stylesheet from the Vite public root', () => {
    expect(indexHtml).toContain('href="/styles/typora-theme/typora-jinxiu.css"');
    expect(jinxiuMarkdownSource).not.toContain("../../public/styles/typora-theme/typora-jinxiu.css");
  });

  it.each(SKIN_IDS)('defines the complete canonical token contract for %s', (skin) => {
    const selectors = skin === 'original'
      ? [':root[data-skin="original"][data-appearance="light"]', ':root[data-skin="original"][data-appearance="dark"]']
      : [`:root[data-skin="${skin}"]`];
    for (const selector of selectors) {
      const declarations = declarationsFor(selector);
      expect([...CANONICAL_THEME_TOKENS].filter((token) => !declarations.has(token))).toEqual([]);
      expect(declarations.size).toBe(CANONICAL_THEME_TOKENS.length);
    }
  });

  it('uses root appearance attributes in newly authored application CSS', () => {
    expect(applicationCss).toContain(':root[data-appearance="dark"]');
    expect(applicationCss).not.toMatch(/(^|[\s,])\.dark\s/);
  });

  it('tolerates shipped Typora dark aliases only behind the root dark code-card override', () => {
    expect(typoraCss).toMatch(/\.dark \.typora-jinxiu/);
    expect(typoraCss).toMatch(/blockquote \.markdown-code-block-copy-wrap\.jinxiu-code-surface/);
    expect(markdownPreviewCss).toMatch(
      /:root\[data-appearance="dark"\] \.typora-jinxiu blockquote \.markdown-code-block-copy-wrap\.jinxiu-code-surface\s*\{[^}]*--jinxiu-code-surface:\s*var\(--code-bg\)\s*!important;/,
    );
  });

  it('does not introduce gradients, network fonts, or content filters', () => {
    expect(applicationCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(applicationCss).not.toMatch(/@import\s+url|@font-face[\s\S]*?https?:\/\//i);
    expect(applicationCss).not.toMatch(/\.(?:workspace-image|workspace-video|workspace-audio|pdf-preview-viewport\s+canvas|docx-preview-document|excalidraw-viewport\s*>\s*\.excalidraw)[^{]*\{[^}]*\bfilter\s*:/i);
  });

  it('routes representative shell, editor, preview, dialog and status surfaces through tokens', () => {
    expect(applicationCss).toMatch(/\.toolbar\s*\{[\s\S]*?background:\s*var\(--toolbar\)/);
    expect(applicationCss).toMatch(/\.app-dialog,[\s\S]*?background:\s*var\(--panel-strong\)/);
    expect(applicationCss).toMatch(/\.editor-host\s*\{[\s\S]*?background:\s*var\(--editor-bg\)/);
    expect(applicationCss).toMatch(/\.editor-status\s*\{[\s\S]*?background:\s*var\(--panel-muted\)/);
    expect(applicationCss).toMatch(/\.preview-scroll\s*\{[^}]*background:\s*var\(--preview-bg\)/);
    expect(applicationCss).toMatch(/\.typora-jinxiu\s*\{[\s\S]*?color:\s*var\(--text-reading\)/);
  });

  it('overrides the shipped Typora blockquote code-card surface in dark appearance', () => {
    const dom = new JSDOM(
      '<!doctype html><html data-skin="shanshui-yemo" data-appearance="dark"><head></head><body>'
      + '<main class="typora-jinxiu"><blockquote>'
      + '<div class="markdown-code-block-copy-wrap jinxiu-code-surface"></div>'
      + '</blockquote></main></body></html>',
    );
    const style = dom.window.document.createElement('style');
    style.textContent = `${baseCss}\n${typoraCss}\n${markdownPreviewCss}`;
    dom.window.document.head.append(style);
    const wrapper = dom.window.document.querySelector('.markdown-code-block-copy-wrap')!;
    const computed = dom.window.getComputedStyle(wrapper);

    expect(computed.getPropertyValue('--jinxiu-code-surface').trim()).toBe('var(--code-bg)');
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--code-bg').trim()).toBe('#181c1a');
  });

  it('wraps highlighted and fallback fenced-code lines inside the preview width', () => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body>'
      + '<main class="typora-jinxiu"><div class="markdown-code-block-copy-wrap jinxiu-code-surface">'
      + '<pre class="jinxiu-code-block-pre"><code class="jinxiu-fenced-code-inner">'
      + '<span class="jinxiu-code-line">a-very-long-unbroken-code-line</span>'
      + '</code></pre></div>'
      + '<div class="markdown-code-block-copy-wrap jinxiu-code-surface">'
      + '<pre class="jinxiu-code-block-pre" aria-busy="true"><code class="jinxiu-fenced-code-inner">'
      + 'another-very-long-unbroken-code-line'
      + '</code></pre></div></main></body></html>',
    );
    const style = dom.window.document.createElement('style');
    style.textContent = `${baseCss}\n${typoraCss}\n${markdownPreviewCss}`;
    dom.window.document.head.append(style);

    const pre = dom.window.document.querySelector('.jinxiu-code-block-pre')!;
    const code = dom.window.document.querySelector('.jinxiu-fenced-code-inner')!;
    const line = dom.window.document.querySelector('.jinxiu-code-line')!;
    const fallbackPre = dom.window.document.querySelector('[aria-busy="true"]')!;
    const fallbackCode = fallbackPre.querySelector('.jinxiu-fenced-code-inner')!;
    const preStyle = dom.window.getComputedStyle(pre);
    const codeStyle = dom.window.getComputedStyle(code);
    const lineStyle = dom.window.getComputedStyle(line);
    const fallbackPreStyle = dom.window.getComputedStyle(fallbackPre);
    const fallbackCodeStyle = dom.window.getComputedStyle(fallbackCode);

    expect(preStyle.overflowX).toBe('hidden');
    expect(codeStyle.whiteSpace).toBe('pre-wrap');
    const lineNumber = dom.window.document.createElement('span');
    lineNumber.className = 'react-syntax-highlighter-line-number';
    line.append(lineNumber);

    expect(codeStyle.overflowWrap).toBe('break-word');
    expect(codeStyle.wordBreak).toBe('normal');
    expect(lineStyle.display).toBe('block');
    expect(lineStyle.paddingLeft).toBe('var(--jinxiu-code-gutter, 4.9rem)');
    expect(dom.window.getComputedStyle(lineNumber).position).toBe('absolute');
    expect(fallbackPreStyle.overflowX).toBe('hidden');
    expect(fallbackCodeStyle.whiteSpace).toBe('pre-wrap');
    expect(fallbackCodeStyle.overflowWrap).toBe('break-word');
  });

  it.each(SKIN_IDS)('computes representative root styles for %s', (skin) => {
    const expected = REPRESENTATIVE_ROOT_STYLES[skin];
    const rendered = renderedRoot(skin);

    expect(rendered.token('--toolbar')).toBe(expected.toolbar);
    expect(rendered.token('--editor-bg')).toBe(expected.editor);
    expect(rendered.token('--preview-bg')).toBe(expected.preview);
    expect(rendered.token('--selection-strong')).toBe(expected.selection);
    expect(rendered.colorScheme).toBe(expected.appearance);
  });

  it.each(SKIN_IDS)('meets rendered text contrast thresholds for %s', (skin) => {
    const rendered = renderedRoot(skin);

    for (const [label, foregroundToken, backgroundToken] of NORMAL_TEXT_PAIRS) {
      expect(
        contrastRatio(rendered.token(foregroundToken), rendered.token(backgroundToken)),
        `${skin}: ${label}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const [label, foregroundToken, backgroundToken] of LARGE_TEXT_PAIRS) {
      expect(
        contrastRatio(rendered.token(foregroundToken), rendered.token(backgroundToken)),
        `${skin}: ${label}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('matches the LogicFrame adaptive original dark tokens and preserves key contrast thresholds', () => {
    const rendered = renderedRoot('original', 'dark');
    expect(rendered.token('--bg')).toBe('#0f172a');
    expect(rendered.token('--text-muted')).toBe('#64748b');
    expect(rendered.token('--text-reading')).toBe('#a1a1aa');
    expect(rendered.token('--accent')).toBe('#8eb0e0');
    expect(rendered.token('--accent-hover')).toBe('#7a9ccb');
    expect(rendered.colorScheme).toBe('dark');
    for (const [label, foregroundToken, backgroundToken] of NORMAL_TEXT_PAIRS.filter(
      ([pairLabel]) => pairLabel !== 'muted text on panel',
    )) {
      expect(
        contrastRatio(rendered.token(foregroundToken), rendered.token(backgroundToken)),
        `original dark: ${label}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
