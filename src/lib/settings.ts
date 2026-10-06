import {
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
  type AutosaveMode,
  type SettingsEnvelope,
  type SettingsError,
  type SettingsLocaleMode,
  type SettingsSkinId,
} from '../types';

const SETTINGS_KEYS = [
  'autosaveEnabled',
  'autosaveDelayMs',
  'autosaveMode',
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
const AUTOSAVE_MODES: readonly AutosaveMode[] = [
  'afterDelay',
  'onFocusChange',
  'onWindowChange',
];
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

function isAutosaveMode(value: unknown): value is AutosaveMode {
  return typeof value === 'string' && (AUTOSAVE_MODES as readonly string[]).includes(value);
}

// 数值字段：有限数。
function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

// 开关与文本字段：布尔与字符串。
function appSettingsPrimitivesInvalid(value: Record<string, unknown>): boolean {
  return typeof value.autosaveEnabled !== 'boolean'
    || typeof value.spellcheckEnabled !== 'boolean'
    || typeof value.wikilinksEnabled !== 'boolean'
    || typeof value.resourceDirectory !== 'string'
    || typeof value.followSystemTheme !== 'boolean';
}

// 数值与枚举字段：有限数、触发方式、皮肤与语言。
function appSettingsEnumsInvalid(value: Record<string, unknown>): boolean {
  return !finiteNumber(value.autosaveDelayMs)
    || !isAutosaveMode(value.autosaveMode)
    || !finiteNumber(value.editorPaneRatio)
    || !finiteNumber(value.editorFontSize)
    || !isSkin(value.selectedSkin)
    || !isLocale(value.localeMode);
}

// 映射字段：快捷键字符串表与导出配置对象。
function appSettingsMapsInvalid(value: Record<string, unknown>): boolean {
  return !isStringMap(value.shortcuts)
    || !isRecord(value.exportProfiles);
}

// 设置字段预检：布尔/数值/枚举/映射逐项校验。
function appSettingsFieldsInvalid(value: Record<string, unknown>): boolean {
  return appSettingsPrimitivesInvalid(value)
    || appSettingsEnumsInvalid(value)
    || appSettingsMapsInvalid(value);
}

function decodeAppSettings(value: unknown): AppSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null;
  if (appSettingsFieldsInvalid(value)) return null;

  return {
    autosaveEnabled: value.autosaveEnabled as boolean,
    autosaveDelayMs: value.autosaveDelayMs as number,
    autosaveMode: value.autosaveMode as AppSettings['autosaveMode'],
    spellcheckEnabled: value.spellcheckEnabled as boolean,
    wikilinksEnabled: value.wikilinksEnabled as boolean,
    resourceDirectory: value.resourceDirectory as string,
    editorPaneRatio: value.editorPaneRatio as number,
    editorFontSize: value.editorFontSize as number,
    selectedSkin: value.selectedSkin as AppSettings['selectedSkin'],
    followSystemTheme: value.followSystemTheme as boolean,
    localeMode: value.localeMode as AppSettings['localeMode'],
    shortcuts: value.shortcuts as AppSettings['shortcuts'],
    exportProfiles: value.exportProfiles as AppSettings['exportProfiles'],
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
