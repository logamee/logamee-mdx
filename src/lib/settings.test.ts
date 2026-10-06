import { describe, expect, it } from 'vitest';
import { currentSettingsEnvelope } from './settingsFixtures';
import {
  applyEditorFontSize,
  decodeSettingsEnvelope,
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  projectSettingsError,
  stepEditorFontSize,
} from './settings';

describe('settings projection', () => {
  it('projects the complete current Rust settings envelope without changing values', () => {
    expect(decodeSettingsEnvelope(currentSettingsEnvelope)).toEqual(currentSettingsEnvelope);
  });

  it('keeps wikilinks disabled in the projected defaults', () => {
    expect(decodeSettingsEnvelope(currentSettingsEnvelope).settings.wikilinksEnabled).toBe(false);
  });

  it.each([
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, editorFontSize: '16' } },
    { ...currentSettingsEnvelope, settings: { ...currentSettingsEnvelope.settings, editorFontSize: Number.NaN } },
  ])('rejects a response whose editor font size is not a finite number', (response) => {
    expect(() => decodeSettingsEnvelope(response)).toThrow('Invalid settings response');
  });

  it('applies the editor font size as a root CSS variable in pixels', () => {
    const calls: Array<[string, string]> = [];
    const root = {
      style: {
        setProperty: (key: string, value: string) => {
          calls.push([key, value]);
        },
      },
    } as unknown as HTMLElement;

    applyEditorFontSize(root, 18);

    expect(calls).toEqual([['--editor-font-size', '18px']]);
  });

  it('steps the editor font size by whole pixels within the supported range', () => {
    expect(stepEditorFontSize(16, 1)).toBe(17);
    expect(stepEditorFontSize(16, -1)).toBe(15);
    expect(stepEditorFontSize(MAX_EDITOR_FONT_SIZE, 1)).toBe(MAX_EDITOR_FONT_SIZE);
    expect(stepEditorFontSize(MIN_EDITOR_FONT_SIZE, -1)).toBe(MIN_EDITOR_FONT_SIZE);
    expect(DEFAULT_EDITOR_FONT_SIZE).toBe(16);
  });

  it('recovers the default editor font size from an invalid current value', () => {
    expect(stepEditorFontSize(Number.NaN, 1)).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(stepEditorFontSize(Number.POSITIVE_INFINITY, -1)).toBe(DEFAULT_EDITOR_FONT_SIZE);
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
