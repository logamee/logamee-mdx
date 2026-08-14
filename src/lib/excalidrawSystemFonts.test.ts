import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXCALIDRAW_SYSTEM_FONT_SOURCES,
  installExcalidrawSystemFonts,
} from './excalidrawSystemFonts';

const EXCALIDRAW_FAMILIES = [
  'Cascadia',
  'Comic Shanns',
  'Excalifont',
  'Helvetica',
  'Liberation Sans',
  'Lilita One',
  'Nunito',
  'Virgil',
  'Xiaolai',
  'Segoe UI Emoji',
] as const;

type FontFaceCall = {
  descriptors?: FontFaceDescriptors;
  family: string;
  source: string | BufferSource;
};

function fakeFontFaceEnvironment() {
  const calls: FontFaceCall[] = [];

  class FakeFontFace {
    static readonly kind = 'native-font-face';

    readonly descriptors?: FontFaceDescriptors;
    readonly family: string;
    readonly source: string | BufferSource;

    constructor(
      family: string,
      source: string | BufferSource,
      descriptors?: FontFaceDescriptors,
    ) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      calls.push({ descriptors, family, source });
    }

    load() {
      return Promise.resolve(this);
    }
  }

  return {
    calls,
    environment: {
      FontFace: FakeFontFace as unknown as typeof FontFace,
    },
    FakeFontFace,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Excalidraw system font adapter', () => {
  it('defines the exact known Excalidraw family allowlist', () => {
    expect(Object.keys(EXCALIDRAW_SYSTEM_FONT_SOURCES)).toEqual(EXCALIDRAW_FAMILIES);
  });

  it.each(EXCALIDRAW_FAMILIES)('maps %s URL sources to local-only system fonts', (family) => {
    const { calls, environment } = fakeFontFaceEnvironment();
    installExcalidrawSystemFonts(environment);

    new environment.FontFace!(family, 'url(https://esm.sh/font.woff2) format("woff2")');

    const source = calls[0]?.source;
    expect(source).toBe(EXCALIDRAW_SYSTEM_FONT_SOURCES[family]);
    expect(source).toMatch(/^local\("[^"]+"\)(?:, local\("[^"]+"\))+$/u);
    expect(source).not.toMatch(/url\(|https?:/iu);
  });

  it('provides ordered Windows, macOS, and Linux candidates for every family', () => {
    for (const source of Object.values(EXCALIDRAW_SYSTEM_FONT_SOURCES)) {
      expect(source.match(/local\(/gu)).toHaveLength(3);
    }

    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Cascadia).toContain('local("Consolas")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Cascadia).toContain('local("Menlo")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Cascadia).toContain('local("DejaVu Sans Mono")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Xiaolai).toContain('local("Microsoft YaHei")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Xiaolai).toContain('local("PingFang SC")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES.Xiaolai).toContain('local("Noto Sans CJK SC")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES['Segoe UI Emoji']).toContain('local("Segoe UI Emoji")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES['Segoe UI Emoji']).toContain('local("Apple Color Emoji")');
    expect(EXCALIDRAW_SYSTEM_FONT_SOURCES['Segoe UI Emoji']).toContain('local("Noto Color Emoji")');
  });

  it('maps the empty source used by Excalidraw local font registrations', () => {
    const { calls, environment } = fakeFontFaceEnvironment();
    installExcalidrawSystemFonts(environment);

    new environment.FontFace!('Helvetica', '');

    expect(calls[0]?.source).toBe(EXCALIDRAW_SYSTEM_FONT_SOURCES.Helvetica);
  });

  it('preserves the original descriptor object exactly', () => {
    const { calls, environment } = fakeFontFaceEnvironment();
    const descriptors: FontFaceDescriptors = {
      display: 'swap',
      style: 'normal',
      unicodeRange: 'U+0000-00FF',
      weight: '500',
    };
    installExcalidrawSystemFonts(environment);

    new environment.FontFace!('Nunito', 'url(/font.woff2)', descriptors);

    expect(calls[0]?.descriptors).toBe(descriptors);
  });

  it('passes unknown families and sources through unchanged', () => {
    const { calls, environment } = fakeFontFaceEnvironment();
    const descriptors: FontFaceDescriptors = { weight: '700' };
    installExcalidrawSystemFonts(environment);

    new environment.FontFace!('mdx Custom Font', 'url(/custom.woff2)', descriptors);

    expect(calls[0]).toEqual({
      descriptors,
      family: 'mdx Custom Font',
      source: 'url(/custom.woff2)',
    });
  });

  it('passes through non-URL sources even for allowlisted family names', () => {
    const { calls, environment } = fakeFontFaceEnvironment();
    const bytes = new Uint8Array([0, 1, 2]);
    installExcalidrawSystemFonts(environment);

    new environment.FontFace!('Virgil', bytes);
    new environment.FontFace!('Virgil', 'local("Existing Virgil")');

    expect(calls.map(({ source }) => source)).toEqual([bytes, 'local("Existing Virgil")']);
  });

  it('is idempotent and retains original constructor behavior', async () => {
    const { environment, FakeFontFace } = fakeFontFaceEnvironment();
    installExcalidrawSystemFonts(environment);
    const installed = environment.FontFace;

    installExcalidrawSystemFonts(environment);
    const face = new environment.FontFace!('Excalifont', 'url(/font.woff2)');

    expect(environment.FontFace).toBe(installed);
    expect((environment.FontFace as unknown as { kind: string }).kind).toBe('native-font-face');
    expect(face).toBeInstanceOf(FakeFontFace);
    expect(Object.getPrototypeOf(face)).toBe(FakeFontFace.prototype);
    await expect(face.load()).resolves.toBe(face);
  });

  it('does nothing when FontFace is unavailable', () => {
    const environment: { FontFace?: typeof FontFace } = {};

    expect(() => installExcalidrawSystemFonts(environment)).not.toThrow();
    expect(environment).not.toHaveProperty('FontFace');
  });

  it('degrades safely when the host exposes a read-only FontFace constructor', () => {
    const { FakeFontFace } = fakeFontFaceEnvironment();
    const environment = {} as { FontFace?: typeof FontFace };
    Object.defineProperty(environment, 'FontFace', {
      configurable: false,
      value: FakeFontFace,
      writable: false,
    });

    expect(() => installExcalidrawSystemFonts(environment)).not.toThrow();
    expect(environment.FontFace).toBe(FakeFontFace);
  });
});
