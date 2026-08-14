import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  SKINS,
  SKIN_IDS,
  THEME_STORAGE_KEY,
  applyEffectiveTheme,
  bootstrapTheme,
  decodeThemePreference,
  resolveEffectiveTheme,
  resolveThemeForAppearance,
  type ThemeRoot,
  type ThemeStorage,
} from './theme';

class MemoryThemeStorage implements ThemeStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createRoot(): ThemeRoot & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setAttribute(name, value) {
      values.set(name, value);
    },
  };
}

describe('theme preference domain', () => {
  it('mirrors the complete ordered LogicFrame palette catalog', () => {
    expect(SKIN_IDS).toEqual([
      'original',
      'jinxiu-zhusha',
      'ruyao-tianqing',
      'qinghua-jilan',
      'songke-zhuying',
      'gujuan-nuanxing',
      'zhuying-qingci',
      'jiushu-huangzhi',
      'shanshui-yemo',
    ]);
    expect(SKINS.map(({ id, nameZh, nameEn, appearance }) => ({ id, nameZh, nameEn, appearance }))).toEqual([
      { id: 'original', nameZh: '素笺·青黛', nameEn: 'Plain Paper · Indigo', appearance: 'adaptive' },
      { id: 'jinxiu-zhusha', nameZh: '朱批·丹砂', nameEn: 'Vermilion Notes · Cinnabar', appearance: 'light' },
      { id: 'ruyao-tianqing', nameZh: '汝瓷·天青', nameEn: 'Ru Ware · Sky Blue', appearance: 'light' },
      { id: 'qinghua-jilan', nameZh: '青花·苏青', nameEn: 'Blue-and-White · Cobalt', appearance: 'light' },
      { id: 'songke-zhuying', nameZh: '宋版·竹青', nameEn: 'Song Edition · Bamboo Green', appearance: 'light' },
      { id: 'gujuan-nuanxing', nameZh: '杏笺·赭石', nameEn: 'Apricot Paper · Red Ochre', appearance: 'light' },
      { id: 'zhuying-qingci', nameZh: '春笺·豆青', nameEn: 'Spring Paper · Pea Green', appearance: 'light' },
      { id: 'jiushu-huangzhi', nameZh: '烟岚·缃素', nameEn: 'Misty Landscape · Antique Silk', appearance: 'light' },
      { id: 'shanshui-yemo', nameZh: '玄卷·松烟', nameEn: 'Night Tome · Pine Soot Ink', appearance: 'dark' },
    ]);
    expect(DEFAULT_THEME_PREFERENCE.selectedSkin).toBe('original');

    for (const selectedSkin of SKIN_IDS) {
      expect(decodeThemePreference({ version: 1, selectedSkin, followSystem: true })).toEqual({
        version: 1,
        selectedSkin,
        followSystem: true,
      });
    }
  });

  it('preserves exact LogicFrame direct palette token values', () => {
    expect(SKINS.find(({ id }) => id === 'jinxiu-zhusha')?.tokens).toMatchObject({
      accent: '#a13d32', themeEmphasis: '#8f302b', syntaxCode: '#973a32', background: '#e8e9e7',
    });
    expect(SKINS.find(({ id }) => id === 'gujuan-nuanxing')?.tokens).toMatchObject({
      background: '#f7e8c9', accent: '#8b4b08', previewBg: '#fff7e8', codeBg: '#e8d7b8',
    });
    expect(SKINS.find(({ id }) => id === 'zhuying-qingci')?.tokens).toMatchObject({
      background: '#e1f3e6', accent: '#257432', previewBg: '#f3faf4', codeBg: '#c9e2cf',
    });
    expect(SKINS.find(({ id }) => id === 'jiushu-huangzhi')?.tokens).toMatchObject({
      background: '#ede3c9', accent: '#544a3b', previewBg: '#fdfae6', codeBg: '#eedfb8',
    });
    expect(SKINS.find(({ id }) => id === 'shanshui-yemo')?.tokens).toMatchObject({
      accent: '#72a18f', themeEmphasis: '#72a18f', textReading: '#d2d2ca', background: '#151817',
    });
  });

  it.each([
    null,
    undefined,
    {},
    { version: 2, selectedSkin: 'jinxiu-zhusha', followSystem: false },
    { version: 1, selectedSkin: 'unknown', followSystem: false },
    { version: 1, selectedSkin: 'jinxiu-zhusha', followSystem: 'yes' },
  ])('rejects malformed and unsupported preferences: %j', (input) => {
    expect(decodeThemePreference(input)).toBeNull();
  });

  it('uses adaptive original when a fixed palette is unavailable for system appearance', () => {
    const preference = { version: 1, selectedSkin: 'ruyao-tianqing', followSystem: true } as const;

    expect(resolveEffectiveTheme(preference, false)).toEqual({
      skin: 'ruyao-tianqing',
      appearance: 'light',
    });
    expect(resolveEffectiveTheme(preference, true)).toEqual({
      skin: 'original',
      appearance: 'dark',
    });
    expect(resolveEffectiveTheme(preference, false).skin).toBe('ruyao-tianqing');
  });

  it('adapts the original palette to system appearance', () => {
    const preference = { version: 1, selectedSkin: 'original', followSystem: true } as const;
    expect(resolveEffectiveTheme(preference, false)).toEqual({ skin: 'original', appearance: 'light' });
    expect(resolveEffectiveTheme(preference, true)).toEqual({ skin: 'original', appearance: 'dark' });
  });

  it('keeps a directly selected night skin dark regardless of OS appearance', () => {
    const preference = { version: 1, selectedSkin: 'shanshui-yemo', followSystem: false } as const;
    expect(resolveEffectiveTheme(preference, false).appearance).toBe('dark');
    expect(resolveEffectiveTheme(preference, true).appearance).toBe('dark');
  });

  it('uses adaptive original when an explicit appearance is unavailable in the current palette', () => {
    expect(resolveThemeForAppearance(
      { skin: 'ruyao-tianqing', appearance: 'light' },
      'dark',
    )).toEqual({ skin: 'original', appearance: 'dark' });
    expect(resolveThemeForAppearance(
      { skin: 'shanshui-yemo', appearance: 'dark' },
      'light',
    )).toEqual({ skin: 'original', appearance: 'light' });
    expect(resolveThemeForAppearance(
      { skin: 'qinghua-jilan', appearance: 'light' },
      'light',
    )).toEqual({ skin: 'qinghua-jilan', appearance: 'light' });
  });

  it('applies both root attributes atomically through one pure boundary', () => {
    const root = createRoot();
    applyEffectiveTheme(root, { skin: 'qinghua-jilan', appearance: 'light' });
    expect(root.values).toEqual(new Map([
      ['data-skin', 'qinghua-jilan'],
      ['data-appearance', 'light'],
    ]));
  });

  it('bootstraps valid storage synchronously before React and repairs corrupt storage', () => {
    const storage = new MemoryThemeStorage();
    const root = createRoot();
    storage.values.set(THEME_STORAGE_KEY, JSON.stringify({
      version: 1,
      selectedSkin: 'songke-zhuying',
      followSystem: false,
    }));

    expect(bootstrapTheme({ root, storage, systemDark: false }).preference.selectedSkin)
      .toBe('songke-zhuying');
    expect(root.values.get('data-skin')).toBe('songke-zhuying');

    storage.values.set(THEME_STORAGE_KEY, '{not json');
    const repaired = bootstrapTheme({ root, storage, systemDark: true });
    expect(repaired.preference).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(root.values.get('data-skin')).toBe('original');
    expect(root.values.get('data-appearance')).toBe('light');
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe(JSON.stringify(DEFAULT_THEME_PREFERENCE));
  });
});
