import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  normalizeShortcut,
  resolveShortcutProfile,
  shortcutMatchesEvent,
} from './shortcutProfiles';

describe('shortcutProfiles', () => {
  it('normalizes modifier order and aliases', () => {
    expect(normalizeShortcut(' shift + ctrl + p ')).toBe('Ctrl+Shift+P');
    expect(normalizeShortcut('command+s')).toBe('Mod+S');
    expect(normalizeShortcut('option+1')).toBe('Alt+1');
  });

  it('resolves overrides onto complete defaults and rejects unknown actions', () => {
    expect(resolveShortcutProfile({ save: 'Ctrl+Shift+S' })).toEqual({
      ...DEFAULT_SHORTCUTS,
      save: 'Ctrl+Shift+S',
    });
    expect(() => resolveShortcutProfile({ launchMissiles: 'Ctrl+M' })).toThrow('Unknown shortcut action');
  });

  it('detects conflicts after normalization', () => {
    expect(findShortcutConflicts({ save: 'Ctrl+P', quickOpen: 'ctrl+p' })).toEqual([
      { shortcut: 'Ctrl+P', actions: ['quickOpen', 'save'] },
    ]);
  });

  it('matches Mod against the host platform primary modifier', () => {
    const event = { altKey: false, ctrlKey: true, key: 's', metaKey: false, shiftKey: false };
    expect(shortcutMatchesEvent('Mod+S', event, 'linux')).toBe(true);
    expect(shortcutMatchesEvent('Mod+S', { ...event, ctrlKey: false, metaKey: true }, 'mac')).toBe(true);
  });

  it('provides zoom-style editor font size shortcuts in the defaults', () => {
    expect(DEFAULT_SHORTCUTS.editorFontLarger).toBe('Mod+=');
    expect(DEFAULT_SHORTCUTS.editorFontSmaller).toBe('Mod+-');
    expect(DEFAULT_SHORTCUTS.editorFontReset).toBe('Mod+0');
    expect(resolveShortcutProfile({ editorFontLarger: 'Ctrl+Alt+9' }).editorFontLarger).toBe('Ctrl+Alt+9');
  });

  it('matches the punctuation and digit keys used by editor font shortcuts', () => {
    const decrease = { altKey: false, ctrlKey: false, key: '-', metaKey: true, shiftKey: false };
    const increase = { altKey: false, ctrlKey: false, key: '=', metaKey: true, shiftKey: false };
    const reset = { altKey: false, ctrlKey: false, key: '0', metaKey: true, shiftKey: false };
    expect(shortcutMatchesEvent('Mod+-', decrease, 'mac')).toBe(true);
    expect(shortcutMatchesEvent('Mod+-', { ...decrease, metaKey: false, ctrlKey: true }, 'win')).toBe(true);
    expect(shortcutMatchesEvent('Mod+=', increase, 'mac')).toBe(true);
    expect(shortcutMatchesEvent('Mod+0', reset, 'mac')).toBe(true);
    expect(shortcutMatchesEvent('Mod+=', { ...increase, key: '+' }, 'mac')).toBe(false);
  });
});
