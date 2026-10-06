import type { SettingsEnvelope } from '../types';

/**
 * Shared settings test fixture: the complete current backend projection.
 * Lives in a non-test module so importing it never registers settings.test
 * cases in the importing test file.
 */
export const currentSettingsEnvelope: SettingsEnvelope = {
  schemaVersion: 1,
  revision: 4,
  settings: {
    autosaveEnabled: true,
    autosaveMode: 'afterDelay',
    autosaveDelayMs: 1500,
    spellcheckEnabled: true,
    wikilinksEnabled: false,
    resourceDirectory: 'assets',
    editorPaneRatio: 0.5,
    editorFontSize: 16,
    selectedSkin: 'jinxiu-zhusha',
    followSystemTheme: false,
    localeMode: 'system',
    shortcuts: {},
    exportProfiles: {},
  },
};
