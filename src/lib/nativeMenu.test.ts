import { describe, expect, it } from 'vitest';
import {
  decodeNativeMenuCommand,
  decodeNativeLocaleMenuIntent,
  decodeNativeThemeMenuIntent,
  isNativeMenuAction,
  isNativeSaveMenuEnabled,
  NATIVE_MENU_ACTIONS,
  NATIVE_MENU_EVENT,
} from './nativeMenu';

describe('native menu event contract', () => {
  it('lists the file actions emitted by the Tauri system menu bar', () => {
    expect(NATIVE_MENU_EVENT).toBe('mmd-native-menu');
    expect(NATIVE_MENU_ACTIONS).toEqual([
      'new', 'open-file', 'open-directory', 'quick-open', 'workspace-search', 'save', 'save-as',
    ]);
  });

  it('accepts only known native file menu actions', () => {
    expect(isNativeMenuAction('save')).toBe(true);
    expect(isNativeMenuAction('open-directory')).toBe(true);
    expect(isNativeMenuAction('quick-open')).toBe(true);
    expect(isNativeMenuAction('workspace-search')).toBe(true);
    expect(isNativeMenuAction('quit')).toBe(false);
    expect(isNativeMenuAction(null)).toBe(false);
  });

  it('decodes recent menu IDs without accepting paths or malformed identifiers', () => {
    expect(decodeNativeMenuCommand('open-recent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      type: 'open-recent',
      entryId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(decodeNativeMenuCommand('clear-recent-files')).toEqual({ type: 'clear-recent-files' });
    expect(decodeNativeMenuCommand('open-file')).toBe('open-file');
    expect(decodeNativeMenuCommand('open-recent:/tmp/note.md')).toBeNull();
    expect(decodeNativeMenuCommand('open-recent:short')).toBeNull();
  });

  it('decodes only allow-listed theme menu IDs', () => {
    expect(decodeNativeThemeMenuIntent('theme-skin:jinxiu-zhusha')).toEqual({
      type: 'select-theme-skin',
      selectedSkin: 'jinxiu-zhusha',
    });
    expect(decodeNativeThemeMenuIntent('theme-skin:shanshui-yemo')).toEqual({
      type: 'select-theme-skin',
      selectedSkin: 'shanshui-yemo',
    });
    expect(decodeNativeThemeMenuIntent('theme-follow-system')).toEqual({
      type: 'toggle-theme-follow-system',
    });
    expect(decodeNativeThemeMenuIntent('theme-skin:unknown')).toBeNull();
    expect(decodeNativeThemeMenuIntent('theme-follow-system:true')).toBeNull();
    expect(decodeNativeThemeMenuIntent('open-file')).toBeNull();
  });

  it('decodes only the three locale menu modes', () => {
    expect(decodeNativeLocaleMenuIntent('locale:system')).toEqual({ type: 'select-locale-mode', mode: 'system' });
    expect(decodeNativeLocaleMenuIntent('locale:zh-CN')).toEqual({ type: 'select-locale-mode', mode: 'zh-CN' });
    expect(decodeNativeLocaleMenuIntent('locale:en')).toEqual({ type: 'select-locale-mode', mode: 'en' });
    expect(decodeNativeLocaleMenuIntent('locale:fr')).toBeNull();
    expect(decodeNativeLocaleMenuIntent('theme-follow-system')).toBeNull();
  });

  it.each([
    ['markdown', 'committed', false, true],
    ['html', 'committed', false, true],
    ['excalidraw', 'committed', false, true],
    ['markdown', 'committed', true, false],
    ['html', 'provisional', false, false],
    ['markdown', 'unknown', false, false],
    ['html', 'failed', false, false],
    ['pdf', 'committed', false, false],
    ['docx', 'committed', false, false],
    ['image', 'committed', false, false],
    ['video', 'committed', false, false],
    ['audio', 'committed', false, false],
  ] as const)(
    'derives save availability for %s with %s authority and busy=%s',
    (fileKind, authorityStatus, busy, expected) => {
      expect(isNativeSaveMenuEnabled({ authorityStatus, busy, fileKind })).toBe(expected);
    },
  );
});
