export type SkinAppearance = "light" | "dark" | "adaptive";

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

export const SKINS = [
  {
    id: "original",
    nameZh: "素笺·青黛",
    nameEn: "Plain Paper · Indigo",
    appearance: "adaptive",
    tokens: null,
    swatches: {
      light: ["#ffffff", "#333333", "#264783", "#e5e5e5"],
      dark: ["#0f172a", "#a1a1aa", "#8eb0e0", "#1e293b"],
    },
  },
  {
    id: "jinxiu-zhusha",
    nameZh: "朱批·丹砂",
    nameEn: "Vermilion Notes · Cinnabar",
    appearance: "light",
    tokens: {
      background: "#e8e9e7",
      toolbar: "#f7f7f5",
      sidebar: "#f0f1ee",
      panel: "#ffffff",
      panelMuted: "#f7f6f3",
      border: "#c9ccc7",
      borderStrong: "#a9aea8",
      chromeText: "#202421",
      textReading: "#302d2a",
      textMuted: "#626a64",
      textFaint: "#777f79",
      accent: "#a13d32",
      accentHover: "#7f2e28",
      accentForeground: "#fff9f3",
      themeEmphasis: "#8f302b",
      themeEmphasisForeground: "#fff9f3",
      focusRing: "#bd6a61",
      selectionMuted: "#f1dfdc",
      selectionStrong: "#a13d32",
      selectionForeground: "#fff9f3",
      scrollbarThumb: "#9da39d",
      motif: "#2f6f78",
      shadow: "rgba(31, 36, 32, 0.2)",
      previewBg: "#ffffff",
      previewHeading: "#8f302b",
      previewHeadingSecondary: "#8f302b",
      previewQuoteBg: "#f1f6f5",
      previewQuoteText: "#344b46",
      previewTableHead: "#f5eeed",
      previewTableCell: "#fbfbfa",
      codeBg: "#f7f7f5",
      codeBorder: "#d4d8d2",
      codeText: "#252b27",
      codeGutterText: "#397283",
      syntaxHeading: "#91372f",
      syntaxStrong: "#805516",
      syntaxEmphasis: "#76517c",
      syntaxLink: "#2f6675",
      syntaxCode: "#973a32",
      syntaxCodeBg: "#faefed",
      syntaxQuote: "#3d6e5a",
      syntaxList: "#765719",
      syntaxMeta: "#686f78",
      syntaxComment: "#66716a",
    },
  },
  {
    id: "ruyao-tianqing",
    nameZh: "汝瓷·天青",
    nameEn: "Ru Ware · Sky Blue",
    appearance: "light",
    tokens: {
      background: "#e4ebe7",
      toolbar: "#f3f6f3",
      sidebar: "#eaf0ec",
      panel: "#fcfdfc",
      panelMuted: "#f1f5f2",
      border: "#c0cbc4",
      borderStrong: "#9eafa4",
      chromeText: "#1f2a24",
      textReading: "#303733",
      textMuted: "#58665e",
      textFaint: "#748079",
      accent: "#3f6f73",
      accentHover: "#31585b",
      accentForeground: "#ffffff",
      themeEmphasis: "#3f6f73",
      themeEmphasisForeground: "#ffffff",
      focusRing: "#527f82",
      selectionMuted: "#dce9e8",
      selectionStrong: "#3f6f73",
      selectionForeground: "#ffffff",
      scrollbarThumb: "#92a198",
      motif: "#668586",
      shadow: "rgba(31, 46, 38, 0.19)",
      previewBg: "#fcfdfc",
      previewHeading: "#3f6f73",
      previewHeadingSecondary: "#3f6f73",
      previewQuoteBg: "#edf4f0",
      previewQuoteText: "#344d43",
      previewTableHead: "#eaf2ed",
      previewTableCell: "#f9fbfa",
      codeBg: "#f3f6f4",
      codeBorder: "#ccd6d0",
      codeText: "#26312b",
      codeGutterText: "#4b7376",
      syntaxHeading: "#3f6f73",
      syntaxStrong: "#7d5b23",
      syntaxEmphasis: "#6d5b78",
      syntaxLink: "#315f63",
      syntaxCode: "#8b3642",
      syntaxCodeBg: "#f7ebec",
      syntaxQuote: "#496d60",
      syntaxList: "#755a24",
      syntaxMeta: "#6a7370",
      syntaxComment: "#64736b",
    },
  },
  {
    id: "qinghua-jilan",
    nameZh: "青花·苏青",
    nameEn: "Blue-and-White · Cobalt",
    appearance: "light",
    tokens: {
      background: "#e7ecf3",
      toolbar: "#f7f8fa",
      sidebar: "#eef1f5",
      panel: "#ffffff",
      panelMuted: "#f4f6f9",
      border: "#c6ccd5",
      borderStrong: "#a7b0bd",
      chromeText: "#1d2530",
      textReading: "#2a313a",
      textMuted: "#596779",
      textFaint: "#788392",
      accent: "#235ba8",
      accentHover: "#18467f",
      accentForeground: "#ffffff",
      themeEmphasis: "#235ba8",
      themeEmphasisForeground: "#ffffff",
      focusRing: "#4e7fbd",
      selectionMuted: "#dce6f4",
      selectionStrong: "#235ba8",
      selectionForeground: "#ffffff",
      scrollbarThumb: "#98a3b1",
      motif: "#52719b",
      shadow: "rgba(27, 38, 52, 0.2)",
      previewBg: "#ffffff",
      previewHeading: "#235ba8",
      previewHeadingSecondary: "#235ba8",
      previewQuoteBg: "#eef3f8",
      previewQuoteText: "#34485f",
      previewTableHead: "#eaf0f8",
      previewTableCell: "#fafbfd",
      codeBg: "#f4f6f9",
      codeBorder: "#d2d8e1",
      codeText: "#232b36",
      codeGutterText: "#2d648f",
      syntaxHeading: "#235ba8",
      syntaxStrong: "#875d18",
      syntaxEmphasis: "#73538a",
      syntaxLink: "#1f5da6",
      syntaxCode: "#9a2f38",
      syntaxCodeBg: "#faedef",
      syntaxQuote: "#3f705b",
      syntaxList: "#87631d",
      syntaxMeta: "#6d7482",
      syntaxComment: "#66717c",
    },
  },
  {
    id: "songke-zhuying",
    nameZh: "宋版·竹青",
    nameEn: "Song Edition · Bamboo Green",
    appearance: "light",
    tokens: {
      background: "#e6eadf",
      toolbar: "#f5f6f2",
      sidebar: "#edf0e9",
      panel: "#fefefc",
      panelMuted: "#f3f5f0",
      border: "#c5cbbf",
      borderStrong: "#a5aea0",
      chromeText: "#1f2721",
      textReading: "#2d322e",
      textMuted: "#5b655a",
      textFaint: "#788179",
      accent: "#526b3f",
      accentHover: "#3d542f",
      accentForeground: "#ffffff",
      themeEmphasis: "#526b3f",
      themeEmphasisForeground: "#ffffff",
      focusRing: "#71835b",
      selectionMuted: "#e0e8d8",
      selectionStrong: "#526b3f",
      selectionForeground: "#ffffff",
      scrollbarThumb: "#98a095",
      motif: "#6f8050",
      shadow: "rgba(31, 38, 32, 0.18)",
      previewBg: "#fefefc",
      previewHeading: "#526b3f",
      previewHeadingSecondary: "#526b3f",
      previewQuoteBg: "#eef2eb",
      previewQuoteText: "#38483c",
      previewTableHead: "#edf2ea",
      previewTableCell: "#fafbf8",
      codeBg: "#f4f5f1",
      codeBorder: "#d0d5cc",
      codeText: "#262b27",
      codeGutterText: "#61734d",
      syntaxHeading: "#526b3f",
      syntaxStrong: "#7b5b20",
      syntaxEmphasis: "#6f5577",
      syntaxLink: "#496238",
      syntaxCode: "#893730",
      syntaxCodeBg: "#f6ecea",
      syntaxQuote: "#596f49",
      syntaxList: "#73581e",
      syntaxMeta: "#696f69",
      syntaxComment: "#5b655a",
    },
  },
  {
    id: "gujuan-nuanxing",
    nameZh: "杏笺·赭石",
    nameEn: "Apricot Paper · Red Ochre",
    appearance: "light",
    tokens: {
      background: "#f7e8c9",
      toolbar: "#f2dfba",
      sidebar: "#f4e4c4",
      panel: "#fff7e8",
      panelMuted: "#f0e0c2",
      border: "#d8c6a5",
      borderStrong: "#b69b70",
      chromeText: "#211a12",
      textReading: "#171411",
      textMuted: "#665b4e",
      textFaint: "#6c6152",
      accent: "#8b4b08",
      accentHover: "#6f3905",
      accentForeground: "#fff7e8",
      themeEmphasis: "#8b4b08",
      themeEmphasisForeground: "#fff7e8",
      focusRing: "#9a5a0a",
      selectionMuted: "#edd4a7",
      selectionStrong: "#8b4b08",
      selectionForeground: "#fff7e8",
      scrollbarThumb: "#a9916d",
      motif: "#8a6540",
      shadow: "rgba(73, 47, 18, 0.2)",
      previewBg: "#fff7e8",
      previewHeading: "#7b4208",
      previewHeadingSecondary: "#8b4b08",
      previewQuoteBg: "#efe0c1",
      previewQuoteText: "#453725",
      previewTableHead: "#ead4aa",
      previewTableCell: "#fbefd9",
      codeBg: "#e8d7b8",
      codeBorder: "#cdb58d",
      codeText: "#2c241b",
      codeGutterText: "#745936",
      syntaxHeading: "#7b4208",
      syntaxStrong: "#76500d",
      syntaxEmphasis: "#76506f",
      syntaxLink: "#79500f",
      syntaxCode: "#8e302a",
      syntaxCodeBg: "#f1d7ce",
      syntaxQuote: "#4f6b49",
      syntaxList: "#745410",
      syntaxMeta: "#675d50",
      syntaxComment: "#645a4f",
    },
  },
  {
    id: "zhuying-qingci",
    nameZh: "春笺·豆青",
    nameEn: "Spring Paper · Pea Green",
    appearance: "light",
    tokens: {
      background: "#e1f3e6",
      toolbar: "#d3ebd8",
      sidebar: "#d9efe0",
      panel: "#f3faf4",
      panelMuted: "#d8eddd",
      border: "#b5d5bd",
      borderStrong: "#8fba99",
      chromeText: "#152019",
      textReading: "#101713",
      textMuted: "#526358",
      textFaint: "#5a6b60",
      accent: "#257432",
      accentHover: "#1d6429",
      accentForeground: "#ffffff",
      themeEmphasis: "#257432",
      themeEmphasisForeground: "#ffffff",
      focusRing: "#257432",
      selectionMuted: "#cfeccf",
      selectionStrong: "#257432",
      selectionForeground: "#ffffff",
      scrollbarThumb: "#86aa8e",
      motif: "#4f8a5c",
      shadow: "rgba(26, 73, 37, 0.18)",
      previewBg: "#f3faf4",
      previewHeading: "#236f31",
      previewHeadingSecondary: "#257432",
      previewQuoteBg: "#d4ebd8",
      previewQuoteText: "#294d32",
      previewTableHead: "#cfe8d4",
      previewTableCell: "#edf7ef",
      codeBg: "#c9e2cf",
      codeBorder: "#a7c9af",
      codeText: "#17281c",
      codeGutterText: "#336a40",
      syntaxHeading: "#236f31",
      syntaxStrong: "#78550f",
      syntaxEmphasis: "#6d4d78",
      syntaxLink: "#236f31",
      syntaxCode: "#8b3037",
      syntaxCodeBg: "#f2dedf",
      syntaxQuote: "#3d7048",
      syntaxList: "#6f5512",
      syntaxMeta: "#546459",
      syntaxComment: "#516358",
    },
  },
  {
    id: "jiushu-huangzhi",
    nameZh: "烟岚·缃素",
    nameEn: "Misty Landscape · Antique Silk",
    appearance: "light",
    tokens: {
      background: "#ede3c9",
      toolbar: "#e9dfc1",
      sidebar: "#efe1c3",
      panel: "#fdfae6",
      panelMuted: "#e9dfc1",
      border: "#b2a27f",
      borderStrong: "#988866",
      chromeText: "#453b33",
      textReading: "#332d27",
      textMuted: "#4b4337",
      textFaint: "#544a3b",
      accent: "#544a3b",
      accentHover: "#453b33",
      accentForeground: "#f5ead0",
      themeEmphasis: "#544a3b",
      themeEmphasisForeground: "#f5ead0",
      focusRing: "#6f624e",
      selectionMuted: "#f4e7c5",
      selectionStrong: "#544a3b",
      selectionForeground: "#f5ead0",
      scrollbarThumb: "#988866",
      motif: "#6f624e",
      shadow: "rgba(69, 59, 51, 0.1)",
      previewBg: "#fdfae6",
      previewHeading: "#453b33",
      previewHeadingSecondary: "#544a3b",
      previewQuoteBg: "#e9dfc1",
      previewQuoteText: "#40392f",
      previewTableHead: "#f8e6b3",
      previewTableCell: "#faeec5",
      codeBg: "#eedfb8",
      codeBorder: "#ad9b76",
      codeText: "#332d27",
      codeGutterText: "#4b4337",
      syntaxHeading: "#453b33",
      syntaxStrong: "#66551f",
      syntaxEmphasis: "#6b4d67",
      syntaxLink: "#51483a",
      syntaxCode: "#6f3025",
      syntaxCodeBg: "#f8e6ce",
      syntaxQuote: "#405a43",
      syntaxList: "#66551f",
      syntaxMeta: "#453b33",
      syntaxComment: "#4b4337",
    },
  },
  {
    id: "shanshui-yemo",
    nameZh: "玄卷·松烟",
    nameEn: "Night Tome · Pine Soot Ink",
    appearance: "dark",
    tokens: {
      background: "#151817",
      toolbar: "#1c201e",
      sidebar: "#191d1b",
      panel: "#202421",
      panelMuted: "#262b28",
      border: "#3b443e",
      borderStrong: "#566159",
      chromeText: "#f0f2ee",
      textReading: "#d2d2ca",
      textMuted: "#a7b0a9",
      textFaint: "#89928b",
      accent: "#72a18f",
      accentHover: "#87b5a3",
      accentForeground: "#101513",
      themeEmphasis: "#72a18f",
      themeEmphasisForeground: "#101513",
      focusRing: "#87b5a3",
      selectionMuted: "#24312c",
      selectionStrong: "#72a18f",
      selectionForeground: "#101513",
      scrollbarThumb: "#68736b",
      motif: "#6fa897",
      shadow: "rgba(0, 0, 0, 0.46)",
      previewBg: "#202421",
      previewHeading: "#87b5a3",
      previewHeadingSecondary: "#72a18f",
      previewQuoteBg: "#29312d",
      previewQuoteText: "#d1d8d2",
      previewTableHead: "#2c3530",
      previewTableCell: "#242a27",
      codeBg: "#181c1a",
      codeBorder: "#465049",
      codeText: "#dce2dc",
      codeGutterText: "#83b7a6",
      syntaxHeading: "#8fc7b4",
      syntaxStrong: "#e1b96f",
      syntaxEmphasis: "#c9a7d4",
      syntaxLink: "#8fc7dc",
      syntaxCode: "#ff9b91",
      syntaxCodeBg: "#3d2928",
      syntaxQuote: "#91b9a1",
      syntaxList: "#d5b56e",
      syntaxMeta: "#a6aea8",
      syntaxComment: "#9aa59d",
    },
  },
] as const satisfies readonly SkinDefinition[];

export type SkinId = (typeof SKINS)[number]["id"];
export const SKIN_IDS: readonly SkinId[] = SKINS.map(({ id }) => id);

export const THEME_PREFERENCE_VERSION = 1 as const;
export const THEME_PROTOCOL_VERSION = 1 as const;
export const THEME_STORAGE_KEY = "mmd-theme-preference";
export const THEME_SNAPSHOT_EVENT = "mmd-theme-preference";

export type ThemeAppearance = "light" | "dark";

export interface ThemePreference {
  readonly version: typeof THEME_PREFERENCE_VERSION;
  readonly selectedSkin: SkinId;
  readonly followSystem: boolean;
}

export interface EffectiveTheme {
  readonly skin: SkinId;
  readonly appearance: ThemeAppearance;
}

export interface ThemeSnapshotEnvelope {
  readonly protocolVersion: typeof THEME_PROTOCOL_VERSION;
  readonly revision: number;
  readonly preference: ThemePreference;
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = Object.freeze({
  version: THEME_PREFERENCE_VERSION,
  selectedSkin: "original",
  followSystem: false,
});

export function isSkinId(value: unknown): value is SkinId {
  return (
    typeof value === "string" && (SKIN_IDS as readonly string[]).includes(value)
  );
}

export function decodeThemePreference(value: unknown): ThemePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== THEME_PREFERENCE_VERSION ||
    !isSkinId(candidate.selectedSkin) ||
    typeof candidate.followSystem !== "boolean"
  )
    return null;

  return {
    version: THEME_PREFERENCE_VERSION,
    selectedSkin: candidate.selectedSkin,
    followSystem: candidate.followSystem,
  };
}

export function decodeSerializedThemePreference(
  value: string | null,
): ThemePreference | null {
  if (value === null) return null;
  try {
    return decodeThemePreference(JSON.parse(value));
  } catch {
    return null;
  }
}

export function decodeThemeSnapshotEnvelope(
  value: unknown,
): ThemeSnapshotEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const preference = decodeThemePreference(candidate.preference);
  if (
    candidate.protocolVersion !== THEME_PROTOCOL_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 1 ||
    !preference
  )
    return null;

  return {
    protocolVersion: THEME_PROTOCOL_VERSION,
    revision: candidate.revision as number,
    preference,
  };
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): EffectiveTheme {
  const selected = SKINS.find(({ id }) => id === preference.selectedSkin)!;
  const selectedAppearance =
    selected.appearance === "adaptive" ? "light" : selected.appearance;
  const appearance = preference.followSystem
    ? systemDark
      ? "dark"
      : "light"
    : selectedAppearance;
  const skin =
    selected.appearance === "adaptive" || selected.appearance === appearance
      ? preference.selectedSkin
      : "original";
  return {
    skin,
    appearance,
  };
}

export function resolveThemeForAppearance(
  current: EffectiveTheme,
  appearance: ThemeAppearance,
): EffectiveTheme {
  return current.appearance === appearance
    ? current
    : { skin: "original", appearance };
}

export function applyEffectiveTheme(
  root: ThemeRoot,
  theme: EffectiveTheme,
): void {
  root.setAttribute("data-skin", theme.skin);
  root.setAttribute("data-appearance", theme.appearance);
}

interface BootstrapThemeOptions {
  readonly root: ThemeRoot;
  readonly storage: ThemeStorage;
  readonly systemDark: boolean;
  readonly repairStorage?: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface ThemeBootstrapResult {
  readonly preference: ThemePreference;
  readonly effectiveTheme: EffectiveTheme;
}

export function bootstrapTheme({
  root,
  storage,
  systemDark,
  repairStorage = true,
  onError = () => undefined,
}: BootstrapThemeOptions): ThemeBootstrapResult {
  let serialized: string | null = null;
  try {
    serialized = storage.getItem(THEME_STORAGE_KEY);
  } catch (error) {
    onError(error);
  }

  const decoded = decodeSerializedThemePreference(serialized);
  const preference = decoded ?? DEFAULT_THEME_PREFERENCE;
  const effectiveTheme = resolveEffectiveTheme(preference, systemDark);
  applyEffectiveTheme(root, effectiveTheme);

  if (!decoded && repairStorage) {
    try {
      storage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify(DEFAULT_THEME_PREFERENCE),
      );
    } catch (error) {
      onError(error);
    }
  }

  return { preference, effectiveTheme };
}
