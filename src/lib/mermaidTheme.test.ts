import { describe, expect, it } from 'vitest';
import { getMermaidThemeConfig } from './mermaidTheme';
import { SKIN_IDS } from './theme';

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe('getMermaidThemeConfig', () => {
  it('returns a complete deterministic Mermaid palette for every skin', () => {
    for (const skin of SKIN_IDS) {
      const appearance = skin === 'shanshui-yemo' ? 'dark' : 'light';
      const first = getMermaidThemeConfig(skin, appearance);
      const second = getMermaidThemeConfig(skin, appearance);

      expect(second).toEqual(first);
      expect(first).toMatchObject({
        darkMode: appearance === 'dark',
        theme: 'base',
        themeVariables: {
          background: expect.stringMatching(/^#[0-9A-F]{6}$/),
          lineColor: expect.stringMatching(/^#[0-9A-F]{6}$/),
          primaryColor: expect.stringMatching(/^#[0-9A-F]{6}$/),
          primaryTextColor: expect.stringMatching(/^#[0-9A-F]{6}$/),
          secondaryColor: expect.stringMatching(/^#[0-9A-F]{6}$/),
          tertiaryColor: expect.stringMatching(/^#[0-9A-F]{6}$/),
        },
      });
    }
  });

  it('keeps primary and secondary Mermaid node text above normal-text contrast', () => {
    for (const skin of SKIN_IDS) {
      const appearance = skin === 'shanshui-yemo' ? 'dark' : 'light';
      const variables = getMermaidThemeConfig(skin, appearance).themeVariables;

      expect(contrastRatio(String(variables.primaryTextColor), String(variables.primaryColor))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(String(variables.secondaryTextColor), String(variables.secondaryColor))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
