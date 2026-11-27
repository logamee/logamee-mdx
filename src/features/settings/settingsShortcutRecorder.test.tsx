// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutMatchesEvent } from '../../lib/shortcutProfiles';
import { copy } from './settingsDialogCopy';
import { ShortcutFieldRow } from './settingsShortcutRecorder';

describe('shortcut recording from the settings button', () => {
  let container: HTMLDivElement;
  let root: Root;
  let button: HTMLButtonElement;
  let input: HTMLInputElement;
  const onChange = vi.fn<(value: string) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ShortcutFieldRow action="save" label="Save" value="Mod+S" text={copy.en} onChange={onChange} />));
    button = container.querySelector('button')!;
    input = container.querySelector('input')!;
    button.focus();
    act(() => button.click());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function press(options: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
    act(() => document.activeElement?.dispatchEvent(event));
    return event;
  }

  it.each([
    ['MacIntel', { ctrlKey: true }, 'Ctrl+K'],
    ['MacIntel', { metaKey: true }, 'Mod+K'],
    ['MacIntel', { ctrlKey: true, metaKey: true }, 'Mod+Ctrl+K'],
    ['Win32', { ctrlKey: true }, 'Mod+K'],
    ['Linux x86_64', { ctrlKey: true, altKey: true }, 'Mod+Alt+K'],
  ] as const)('records a working %s binding for %o', (platform, modifiers, expected) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    expect(document.activeElement).toBe(input);
    const event = press({ key: 'k', ...modifiers });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expected);
    expect(shortcutMatchesEvent(expected, event, platform)).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the previous binding when a chord is unsupported or recording is cancelled', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    for (const options of [
      { key: 'k', metaKey: true },
      { key: '+', ctrlKey: true },
      { key: 'CapsLock', ctrlKey: true },
      { key: 'ß', altKey: true },
      { key: 'ﬁ', altKey: true },
    ]) {
      press(options);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    }
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('Mod+S');
  });
});
