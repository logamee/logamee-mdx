import {
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
  type SettingsEnvelope,
  type SettingsError,
  type SettingsLocaleMode,
  type SettingsSkinId,
} from '../types';

const SETTINGS_KEYS = [
  'autosaveEnabled',
  'autosaveDelayMs',
  'spellcheckEnabled',
  'wikilinksEnabled',
  'resourceDirectory',
  'editorPaneRatio',
  'editorFontSize',
  'selectedSkin',
  'followSystemTheme',
  'localeMode',
  'shortcuts',
  'exportProfiles',
] as const;
const ENVELOPE_KEYS = ['schemaVersion', 'revision', 'settings'] as const;
const SKINS: readonly SettingsSkinId[] = [
  'original',
  'jinxiu-zhusha',
  'ruyao-tianqing',
  'qinghua-jilan',
  'songke-zhuying',
  'gujuan-nuanxing',
  'zhuying-qingci',
  'jiushu-huangzhi',
  'shanshui-yemo',
];
const LOCALES: readonly SettingsLocaleMode[] = ['system', 'zh-CN', 'en'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isSkin(value: unknown): value is SettingsSkinId {
  return typeof value === 'string' && (SKINS as readonly string[]).includes(value);
}

function isLocale(value: unknown): value is SettingsLocaleMode {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function decodeAppSettings(value: unknown): AppSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null;
  if (
    typeof value.autosaveEnabled !== 'boolean'
    || typeof value.autosaveDelayMs !== 'number'
    || !Number.isFinite(value.autosaveDelayMs)
    || typeof value.spellcheckEnabled !== 'boolean'
    || typeof value.wikilinksEnabled !== 'boolean'
    || typeof value.resourceDirectory !== 'string'
    || typeof value.editorPaneRatio !== 'number'
    || !Number.isFinite(value.editorPaneRatio)
    || typeof value.editorFontSize !== 'number'
    || !Number.isFinite(value.editorFontSize)
    || !isSkin(value.selectedSkin)
    || typeof value.followSystemTheme !== 'boolean'
    || !isLocale(value.localeMode)
    || !isStringMap(value.shortcuts)
    || !isRecord(value.exportProfiles)
  ) return null;

  return {
    autosaveEnabled: value.autosaveEnabled,
    autosaveDelayMs: value.autosaveDelayMs,
    spellcheckEnabled: value.spellcheckEnabled,
    wikilinksEnabled: value.wikilinksEnabled,
    resourceDirectory: value.resourceDirectory,
    editorPaneRatio: value.editorPaneRatio,
    editorFontSize: value.editorFontSize,
    selectedSkin: value.selectedSkin,
    followSystemTheme: value.followSystemTheme,
    localeMode: value.localeMode,
    shortcuts: value.shortcuts,
    exportProfiles: value.exportProfiles,
  };
}

export function decodeSettingsEnvelope(value: unknown): SettingsEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) {
    throw new Error('Invalid settings response');
  }
  const settings = decodeAppSettings(value.settings);
  if (
    value.schemaVersion !== SETTINGS_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !settings
  ) {
    throw new Error('Invalid settings response');
  }
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, revision: value.revision as number, settings };
}

export const MIN_EDITOR_FONT_SIZE = 12;
export const MAX_EDITOR_FONT_SIZE = 28;
export const DEFAULT_EDITOR_FONT_SIZE = 16;

export function stepEditorFontSize(current: number, step: number): number {
  if (!Number.isFinite(current)) return DEFAULT_EDITOR_FONT_SIZE;
  const next = Math.round(current) + step;
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, next));
}

export function applyEditorFontSize(root: Pick<HTMLElement, 'style'>, size: number): void {
  root.style.setProperty('--editor-font-size', `${size}px`);
}

export function projectSettingsError(value: unknown): Pick<SettingsError, 'canReset'> & { kind: 'conflict' | 'future' | 'recoverable' } {
  if (!isRecord(value)) return { canReset: true, kind: 'recoverable' };
  const normalizedCode = typeof value.code === 'string' ? value.code.toLowerCase() : '';
  const kind = normalizedCode.includes('conflict')
    ? 'conflict'
    : normalizedCode.includes('future') || normalizedCode.includes('unsupportedversion') || normalizedCode.includes('unsupported_version')
      ? 'future'
      : 'recoverable';
  return {
    canReset: kind === 'future' || kind === 'conflict' ? false : typeof value.canReset === 'boolean' ? value.canReset : true,
    kind,
  };
}
