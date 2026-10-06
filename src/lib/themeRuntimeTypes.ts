import type { EffectiveTheme, ThemePreference, ThemeRoot, ThemeStorage } from './theme';

export interface ThemeRuntimeSnapshot {
  readonly preference: ThemePreference;
  readonly effectiveTheme: EffectiveTheme;
  readonly revision: number;
}

export type ThemeRuntimeRole = 'main' | 'popout';
export type ThemeUnlisten = () => void;

export interface ThemeEventApi {
  emit(event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<ThemeUnlisten>;
}

export interface ThemeMediaQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

export interface ThemeStorageEventSource {
  addEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void,
  ): void;
  removeEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void,
  ): void;
}

export interface CreateThemeRuntimeOptions {
  readonly role: ThemeRuntimeRole;
  readonly root: ThemeRoot;
  readonly storage: ThemeStorage;
  readonly mediaQuery: ThemeMediaQuery;
  readonly storageEvents: ThemeStorageEventSource;
  readonly eventApi: ThemeEventApi;
  readonly initialPreference: ThemePreference;
  readonly revisionSeed?: number;
  readonly onError: (error: unknown) => void;
  readonly syncNativePreference?: (preference: ThemePreference) => Promise<void>;
}
