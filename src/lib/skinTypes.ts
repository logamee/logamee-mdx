type SkinAppearance = "light" | "dark" | "adaptive";

export interface SkinPaletteTokens {
  readonly background: string;
  readonly toolbar: string;
  readonly sidebar: string;
  readonly panel: string;
  readonly panelMuted: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly chromeText: string;
  readonly textReading: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly accent: string;
  readonly accentHover: string;
  readonly accentForeground: string;
  readonly themeEmphasis: string;
  readonly themeEmphasisForeground: string;
  readonly focusRing: string;
  readonly selectionMuted: string;
  readonly selectionStrong: string;
  readonly selectionForeground: string;
  readonly scrollbarThumb: string;
  readonly motif: string;
  readonly shadow: string;
  readonly previewBg: string;
  readonly previewHeading: string;
  readonly previewHeadingSecondary: string;
  readonly previewQuoteBg: string;
  readonly previewQuoteText: string;
  readonly previewTableHead: string;
  readonly previewTableCell: string;
  readonly codeBg: string;
  readonly codeBorder: string;
  readonly codeText: string;
  readonly codeGutterText: string;
  readonly syntaxHeading: string;
  readonly syntaxStrong: string;
  readonly syntaxEmphasis: string;
  readonly syntaxLink: string;
  readonly syntaxCode: string;
  readonly syntaxCodeBg: string;
  readonly syntaxQuote: string;
  readonly syntaxList: string;
  readonly syntaxMeta: string;
  readonly syntaxComment: string;
}

export interface SkinDefinition {
  readonly id: string;
  readonly nameZh: string;
  readonly nameEn: string;
  readonly appearance: SkinAppearance;
  readonly tokens: SkinPaletteTokens | null;
  readonly swatches?: {
    readonly light: readonly [string, string, string, string];
    readonly dark: readonly [string, string, string, string];
  };
}
