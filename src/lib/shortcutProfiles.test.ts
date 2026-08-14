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
});
