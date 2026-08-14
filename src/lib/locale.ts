export const LOCALE_MODES = ['system', 'zh-CN', 'en'] as const;
export const LOCALE_PREFERENCE_VERSION = 1 as const;
export const LOCALE_PROTOCOL_VERSION = 1 as const;
export const LOCALE_STORAGE_KEY = 'mmd-locale-preference';
export const LOCALE_SNAPSHOT_EVENT = 'mmd-locale-preference';

export type LocaleMode = (typeof LOCALE_MODES)[number];
export type EffectiveLocale = Exclude<LocaleMode, 'system'>;

export interface LocalePreference {
  readonly version: typeof LOCALE_PREFERENCE_VERSION;
  readonly mode: LocaleMode;
}

export interface LocaleSnapshotEnvelope {
  readonly protocolVersion: typeof LOCALE_PROTOCOL_VERSION;
  readonly revision: number;
  readonly preference: LocalePreference;
}

export interface LocaleRoot {
  setAttribute(name: string, value: string): void;
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = Object.freeze({
  version: LOCALE_PREFERENCE_VERSION,
  mode: 'system',
});

export function isLocaleMode(value: unknown): value is LocaleMode {
  return typeof value === 'string' && (LOCALE_MODES as readonly string[]).includes(value);
}

export function decodeLocalePreference(value: unknown): LocalePreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== LOCALE_PREFERENCE_VERSION || !isLocaleMode(candidate.mode)) return null;
  return { version: LOCALE_PREFERENCE_VERSION, mode: candidate.mode };
}

export function decodeSerializedLocalePreference(value: string | null): LocalePreference | null {
  if (value === null) return null;
  try {
    return decodeLocalePreference(JSON.parse(value));
  } catch {
    return null;
  }
}

export function decodeLocaleSnapshotEnvelope(value: unknown): LocaleSnapshotEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const preference = decodeLocalePreference(candidate.preference);
  if (
    candidate.protocolVersion !== LOCALE_PROTOCOL_VERSION
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 1
    || !preference
  ) return null;
  return {
    protocolVersion: LOCALE_PROTOCOL_VERSION,
    revision: candidate.revision as number,
    preference,
  };
}

export function resolveEffectiveLocale(
  preference: LocalePreference,
  systemLanguage: string,
): EffectiveLocale {
  if (preference.mode !== 'system') return preference.mode;
  return systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function applyEffectiveLocale(root: LocaleRoot, locale: EffectiveLocale): void {
  root.setAttribute('lang', locale);
  root.setAttribute('data-locale', locale);
}

interface BootstrapLocaleOptions {
  readonly root: LocaleRoot;
  readonly storage: LocaleStorage;
  readonly systemLanguage: string;
  readonly repairStorage?: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface LocaleBootstrapResult {
  readonly preference: LocalePreference;
  readonly effectiveLocale: EffectiveLocale;
}

export function bootstrapLocale({
  root,
  storage,
  systemLanguage,
  repairStorage = true,
  onError = () => undefined,
}: BootstrapLocaleOptions): LocaleBootstrapResult {
  let serialized: string | null = null;
  try {
    serialized = storage.getItem(LOCALE_STORAGE_KEY);
  } catch (error) {
    onError(error);
  }
  const decoded = decodeSerializedLocalePreference(serialized);
  const preference = decoded ?? DEFAULT_LOCALE_PREFERENCE;
  const effectiveLocale = resolveEffectiveLocale(preference, systemLanguage);
  applyEffectiveLocale(root, effectiveLocale);

  if (!decoded && repairStorage) {
    try {
      storage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(DEFAULT_LOCALE_PREFERENCE));
    } catch (error) {
      onError(error);
    }
  }
  return { preference, effectiveLocale };
}
