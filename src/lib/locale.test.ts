import { describe, expect, it } from 'vitest';
import {
  applyEffectiveLocale,
  bootstrapLocale,
  decodeLocalePreference,
  DEFAULT_LOCALE_PREFERENCE,
  resolveEffectiveLocale,
} from './locale';

describe('locale preference', () => {
  it('uses Chinese for zh system locales and English for every other locale', () => {
    expect(resolveEffectiveLocale({ version: 1, mode: 'system' }, 'zh-CN')).toBe('zh-CN');
    expect(resolveEffectiveLocale({ version: 1, mode: 'system' }, 'zh-Hant-TW')).toBe('zh-CN');
    expect(resolveEffectiveLocale({ version: 1, mode: 'system' }, 'en-US')).toBe('en');
    expect(resolveEffectiveLocale({ version: 1, mode: 'system' }, 'ja-JP')).toBe('en');
    expect(resolveEffectiveLocale({ version: 1, mode: 'zh-CN' }, 'en-US')).toBe('zh-CN');
    expect(resolveEffectiveLocale({ version: 1, mode: 'en' }, 'zh-CN')).toBe('en');
  });

  it('accepts only the versioned three-state preference', () => {
    expect(decodeLocalePreference({ version: 1, mode: 'system' })).toEqual({ version: 1, mode: 'system' });
    expect(decodeLocalePreference({ version: 1, mode: 'zh-CN' })).toEqual({ version: 1, mode: 'zh-CN' });
    expect(decodeLocalePreference({ version: 1, mode: 'en' })).toEqual({ version: 1, mode: 'en' });
    expect(decodeLocalePreference({ version: 1, mode: 'fr' })).toBeNull();
    expect(decodeLocalePreference({ version: 2, mode: 'system' })).toBeNull();
  });

  it('repairs invalid storage and applies the effective document language', () => {
    const values = new Map<string, string>([['mmd-locale-preference', '{bad']]);
    const rootValues = new Map<string, string>();
    const result = bootstrapLocale({
      root: { setAttribute: (name, value) => rootValues.set(name, value) },
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      systemLanguage: 'zh-HK',
    });

    expect(result.preference).toEqual(DEFAULT_LOCALE_PREFERENCE);
    expect(result.effectiveLocale).toBe('zh-CN');
    expect(rootValues.get('lang')).toBe('zh-CN');
    expect(rootValues.get('data-locale')).toBe('zh-CN');
    expect(JSON.parse(values.get('mmd-locale-preference')!)).toEqual(DEFAULT_LOCALE_PREFERENCE);
  });

  it('applies both semantic and styling locale attributes', () => {
    const values = new Map<string, string>();
    applyEffectiveLocale({ setAttribute: (name, value) => values.set(name, value) }, 'en');
    expect(values).toEqual(new Map([['lang', 'en'], ['data-locale', 'en']]));
  });
});
