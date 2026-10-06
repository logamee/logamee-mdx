export const SETTINGS_SCHEMA_VERSION = 1 as const;

export type SettingsSkinId =
  | 'original'
  | 'jinxiu-zhusha'
  | 'ruyao-tianqing'
  | 'qinghua-jilan'
  | 'songke-zhuying'
  | 'gujuan-nuanxing'
  | 'zhuying-qingci'
  | 'jiushu-huangzhi'
  | 'shanshui-yemo';

export type SettingsLocaleMode = 'system' | 'zh-CN' | 'en';

export type AutosaveMode = 'afterDelay' | 'onFocusChange' | 'onWindowChange';

export interface AppSettings {
  autosaveEnabled: boolean;
  autosaveDelayMs: number;
  autosaveMode: AutosaveMode;
  spellcheckEnabled: boolean;
  wikilinksEnabled: boolean;
  resourceDirectory: string;
  editorPaneRatio: number;
  editorFontSize: number;
  selectedSkin: SettingsSkinId;
  followSystemTheme: boolean;
  localeMode: SettingsLocaleMode;
  shortcuts: Record<string, string>;
  exportProfiles: Record<string, unknown>;
}

export interface SettingsEnvelope {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  revision: number;
  settings: AppSettings;
}

export interface SettingsError {
  code: string;
  message: string;
  canReset: boolean;
}
