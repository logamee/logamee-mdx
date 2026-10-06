import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, SettingsEnvelope } from '../../types';
import type { ThemePreference } from '../theme';
import type { EffectiveLocale, LocalePreference } from '../locale';
import { decodeSettingsEnvelope } from '../settings';

// 设置与原生偏好命令。

export async function getSettings(): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('get_settings'));
}

export async function updateSettings(settings: AppSettings, expectedRevision: number): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('update_settings', { expectedRevision, settings }));
}

export async function resetSettings(expectedRevision: number | null): Promise<SettingsEnvelope> {
  return decodeSettingsEnvelope(await invoke<unknown>('reset_settings', { expectedRevision }));
}

export function setNativeSaveMenuEnabled(enabled: boolean): Promise<void> {
  return invoke<void>('set_native_save_menu_enabled', { enabled });
}

export function setNativeThemePreference(preference: ThemePreference): Promise<void> {
  return invoke<void>('set_native_theme_preference', {
    selectedSkin: preference.selectedSkin,
    followSystem: preference.followSystem,
  });
}

export function setNativeLocalePreference(
  preference: LocalePreference,
  effectiveLocale: EffectiveLocale,
): Promise<void> {
  return invoke<void>('set_native_locale_preference', {
    mode: preference.mode,
    effectiveLocale,
  });
}
