import { SKINS, isSkinId, type SkinId } from "./skinCatalog";

export { SKINS, SKIN_IDS, isSkinId, type SkinId } from "./skinCatalog";
export type { SkinPaletteTokens } from "./skinTypes";

const THEME_PREFERENCE_VERSION = 1 as const;
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

// 设置广播（mmd:settings-changed）到主题偏好的单向桥：设置对话框保存的
// selectedSkin/followSystemTheme 由此接入主题运行时；形状不符返回 null。
export function themePreferenceFromSettingsSnapshot(
  payload: unknown,
): ThemePreference | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const settings = (payload as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  const candidate = settings as {
    selectedSkin?: unknown;
    followSystemTheme?: unknown;
  };
  if (
    !isSkinId(candidate.selectedSkin) ||
    typeof candidate.followSystemTheme !== "boolean"
  ) {
    return null;
  }
  return {
    version: THEME_PREFERENCE_VERSION,
    selectedSkin: candidate.selectedSkin,
    followSystem: candidate.followSystemTheme,
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
