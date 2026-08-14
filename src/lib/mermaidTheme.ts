import type { MermaidConfig } from 'mermaid';
import { SKINS, type SkinId, type SkinPaletteTokens, type ThemeAppearance } from './theme';

interface MermaidPalette {
  readonly background: string;
  readonly border: string;
  readonly line: string;
  readonly primary: string;
  readonly primaryText: string;
  readonly secondary: string;
  readonly secondaryText: string;
  readonly surface: string;
  readonly text: string;
}

const ORIGINAL_MERMAID_PALETTES: Readonly<Record<ThemeAppearance, MermaidPalette>> = {
  light: {
    background: '#FFFFFF', border: '#E5E5E5', line: '#666666', primary: '#264783',
    primaryText: '#FFFFFF', secondary: '#F3F4F6', secondaryText: '#333333', surface: '#F8FAFC', text: '#2D2D2D',
  },
  dark: {
    background: '#0F172A', border: '#334155', line: '#A1A1AA', primary: '#8EB0E0',
    primaryText: '#0F172A', secondary: '#1E293B', secondaryText: '#CBD5E1', surface: '#172033', text: '#CBD5E1',
  },
};

function uppercaseHex(value: string): string {
  return value.startsWith('#') ? value.toUpperCase() : value;
}

function paletteFromTokens(tokens: SkinPaletteTokens): MermaidPalette {
  return {
    background: uppercaseHex(tokens.previewBg),
    border: uppercaseHex(tokens.borderStrong),
    line: uppercaseHex(tokens.textMuted),
    primary: uppercaseHex(tokens.accent),
    primaryText: uppercaseHex(tokens.accentForeground),
    secondary: uppercaseHex(tokens.panelMuted),
    secondaryText: uppercaseHex(tokens.textReading),
    surface: uppercaseHex(tokens.panel),
    text: uppercaseHex(tokens.chromeText),
  };
}

export interface MermaidThemeConfig {
  readonly darkMode: boolean;
  readonly theme: 'base';
  readonly themeVariables: NonNullable<MermaidConfig['themeVariables']>;
}

export function getMermaidThemeConfig(
  skin: SkinId,
  appearance: ThemeAppearance,
): MermaidThemeConfig {
  const definition = SKINS.find(({ id }) => id === skin)!;
  const palette = definition.tokens
    ? paletteFromTokens(definition.tokens)
    : ORIGINAL_MERMAID_PALETTES[appearance];
  return {
    darkMode: appearance === 'dark',
    theme: 'base',
    themeVariables: {
      background: palette.background,
      clusterBkg: palette.surface,
      clusterBorder: palette.border,
      edgeLabelBackground: palette.background,
      lineColor: palette.line,
      mainBkg: palette.primary,
      nodeBorder: palette.border,
      primaryBorderColor: palette.border,
      primaryColor: palette.primary,
      primaryTextColor: palette.primaryText,
      secondaryBorderColor: palette.border,
      secondaryColor: palette.secondary,
      secondaryTextColor: palette.secondaryText,
      tertiaryBorderColor: palette.border,
      tertiaryColor: palette.surface,
      tertiaryTextColor: palette.text,
      textColor: palette.text,
    },
  };
}
