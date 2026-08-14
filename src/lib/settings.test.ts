import { describe, expect, it } from 'vitest';
import type { SettingsEnvelope } from '../types';
import { decodeSettingsEnvelope, projectSettingsError } from './settings';

export const currentSettingsEnvelope: SettingsEnvelope = {
  schemaVersion: 1,
  revision: 4,
  settings: {
    autosaveEnabled: true,
    autosaveDelayMs: 1500,
    spellcheckEnabled: true,
    wikilinksEnabled: false,
    resourceDirectory: 'assets',
    editorPaneRatio: 0.5,
    selectedSkin: 'jinxiu-zhusha',
    followSystemTheme: false,
    localeMode: 'system',
    shortcuts: {},
    exportProfiles: {},
  },
};

describe('settings projection', () => {
  it('projects the complete current Rust settings envelope without changing values', () => {
    expect(decodeSettingsEnvelope(currentSettingsEnvelope)).toEqual(currentSettingsEnvelope);
  });

  it('keeps wikilinks disabled in the projected defaults', () => {
    expect(decodeSettingsEnvelope(currentSettingsEnvelope).settings.wikilinksEnabled).toBe(false);
  });

  it.each(['original', 'gujuan-nuanxing', 'zhuying-qingci', 'jiushu-huangzhi'] as const)(
    'accepts LogicFrame skin %s',
    (selectedSkin) => {
      expect(decodeSettingsEnvelope({
        ...currentSettingsEnvelope,
        settings: { ...currentSettingsEnvelope.settings, selectedSkin },
      }).settings.selectedSkin).toBe(selectedSkin);
    },
  );

  it.each([
    { ...currentSettingsEnvelope, schemaVersion: 2 },
    { ...currentSettingsEnvelope, revision: -1 },
    { ...currentSettingsEnvelope, unexpected: true },
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, autosaveDelayMs: '1500' } },
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, spellcheckEnabled: undefined } },
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, unknownSetting: true } },
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, shortcuts: { bold: 1 } } },
  ])('rejects a response that is not the exact current backend projection', (response) => {
    expect(() => decodeSettingsEnvelope(response)).toThrow('Invalid settings response');
  });

  it('projects unsupported-version failures to retry-only recovery without raw details', () => {
    expect(projectSettingsError({
      code: 'unsupportedVersion',
      message: 'future file at /Users/me/settings.json',
      canReset: true,
    })).toEqual({ canReset: false, kind: 'future' });
  });

  it('projects revision conflicts to reload-only recovery without raw details', () => {
    expect(projectSettingsError({
      code: 'conflict',
      message: 'stale revision at /Users/me/settings.json',
      canReset: true,
    })).toEqual({ canReset: false, kind: 'conflict' });
  });
});
