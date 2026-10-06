// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types';
import { currentSettingsEnvelope } from '../../lib/settingsFixtures';
import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the complete LogicFrame palette catalog as nine visible swatch choices', async () => {
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave} />,
    ));
    const choices = [...container.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input[name="selectedSkin"]')];
    const names = [...container.querySelectorAll<HTMLElement>('.settings-skin-name')];
    expect(choices.map(({ value }) => value)).toEqual([
      'original', 'jinxiu-zhusha', 'ruyao-tianqing', 'qinghua-jilan', 'songke-zhuying',
      'gujuan-nuanxing', 'zhuying-qingci', 'jiushu-huangzhi', 'shanshui-yemo',
    ]);
    expect(names.map(({ textContent }) => textContent)).toEqual([
      'Plain Paper · Indigo', 'Vermilion Notes · Cinnabar', 'Ru Ware · Sky Blue',
      'Blue-and-White · Cobalt', 'Song Edition · Bamboo Green', 'Apricot Paper · Red Ochre',
      'Spring Paper · Pea Green', 'Misty Landscape · Antique Silk', 'Night Tome · Pine Soot Ink',
    ]);
    expect(container.querySelector('select[name="selectedSkin"]')).toBeNull();
    expect(container.querySelectorAll('.settings-skin-swatches')).toHaveLength(9);

    const lastChoice = choices[choices.length - 1];
    await act(async () => lastChoice.click());
    expect(lastChoice.checked).toBe(true);
    await act(async () => container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ selectedSkin: 'shanshui-yemo' }));

    await act(async () => root.render(
      <SettingsDialog busy={false} locale="zh-CN" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    expect([...container.querySelectorAll<HTMLElement>('.settings-skin-name')]
      .map(({ textContent }) => textContent)).toEqual([
      '素笺·青黛', '朱批·丹砂', '汝瓷·天青', '青花·苏青', '宋版·竹青',
      '杏笺·赭石', '春笺·豆青', '烟岚·缃素', '玄卷·松烟',
    ]);
  });

  it('renders compact native controls and saves autosave, spellcheck, wikilinks, resource and layout settings', async () => {
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave}
      />,
    ));

    const dialog = container.querySelector('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelectorAll('.settings-section .settings-section').length).toBe(0);
    expect(container.querySelector<HTMLInputElement>('[name="wikilinksEnabled"]')?.checked).toBe(false);

    const delay = container.querySelector<HTMLInputElement>('[name="autosaveDelayMs"]')!;
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(delay, '2200');
      delay.dispatchEvent(new Event('input', { bubbles: true }));
      delay.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const form = container.querySelector('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      autosaveDelayMs: 2200,
      wikilinksEnabled: false,
    }));
  });

  it('edits and saves the editor font size within the supported range', async () => {
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="zh-CN"
        settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave}
      />,
    ));

    const fontSize = container.querySelector<HTMLInputElement>('[name="editorFontSize"]');
    expect(fontSize).not.toBeNull();
    expect(fontSize?.min).toBe('12');
    expect(fontSize?.max).toBe('28');
    expect(fontSize?.step).toBe('1');
    expect(fontSize?.value).toBe('16');
    const label = fontSize?.closest('.settings-field')?.querySelector('span');
    expect(label?.textContent).toBe('编辑器字号');

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(fontSize, '19');
      fontSize?.dispatchEvent(new Event('input', { bubbles: true }));
      fontSize?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ editorFontSize: 19 }));
  });

  it('blocks saving and explains when numeric settings leave the supported range', async () => {
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="zh-CN"
        settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave}
      />,
    ));
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    const setNumberInput = (input: HTMLInputElement, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setNumberInput(container.querySelector<HTMLInputElement>('[name="editorFontSize"]')!, '31');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('编辑器字号需在 12 到 28 px 之间。');
    expect(submit().disabled).toBe(true);
    await act(async () => container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ));
    expect(onSave).not.toHaveBeenCalled();

    setNumberInput(container.querySelector<HTMLInputElement>('[name="autosaveDelayMs"]')!, '100');
    expect(container.querySelectorAll('[role="alert"]').length).toBe(2);
    expect(submit().disabled).toBe(true);

    setNumberInput(container.querySelector<HTMLInputElement>('[name="editorFontSize"]')!, '18');
    setNumberInput(container.querySelector<HTMLInputElement>('[name="autosaveDelayMs"]')!, '1500');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(submit().disabled).toBe(false);
    await act(async () => container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ editorFontSize: 18 }));
  });

  it('updates the resource path only after an explicit directory authorization', async () => {
    const onAuthorizeResourceDirectory = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('/shared/mmd-assets')
      .mockResolvedValueOnce(null);
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        onAuthorizeResourceDirectory={onAuthorizeResourceDirectory}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave}
      />,
    ));

    const input = container.querySelector<HTMLInputElement>('[name="resourceDirectory"]')!;
    const authorize = container.querySelector<HTMLButtonElement>('[name="authorizeResourceDirectory"]')!;
    expect(input.value).toBe('assets');
    expect(authorize.title).toBe('Choose resource folder');

    await act(async () => authorize.click());
    expect(input.value).toBe('/shared/mmd-assets');

    await act(async () => authorize.click());
    expect(input.value).toBe('/shared/mmd-assets');

    await act(async () => container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      resourceDirectory: '/shared/mmd-assets',
    }));
  });

  it('edits shortcuts, reports conflicts, and restores shortcut defaults', async () => {
    const onSave = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={onSave}
      />,
    ));

    const saveShortcut = container.querySelector<HTMLInputElement>('[name="shortcut-save"]')!;
    const quickOpenShortcut = container.querySelector<HTMLInputElement>('[name="shortcut-quickOpen"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(saveShortcut, 'Ctrl+P');
      saveShortcut.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(quickOpenShortcut, 'Ctrl+P');
      quickOpenShortcut.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Shortcut conflict');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    act(() => container.querySelector<HTMLButtonElement>('[name="resetShortcuts"]')?.click());
    expect(saveShortcut.value).toBe('Mod+S');
  });

  it('lists the editor font size shortcuts with labels and zoom-style defaults', async () => {
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)}
      />,
    ));

    const larger = container.querySelector<HTMLInputElement>('[name="shortcut-editorFontLarger"]')!;
    const smaller = container.querySelector<HTMLInputElement>('[name="shortcut-editorFontSmaller"]')!;
    const reset = container.querySelector<HTMLInputElement>('[name="shortcut-editorFontReset"]')!;
    expect(larger.value).toBe('Mod+=');
    expect(smaller.value).toBe('Mod+-');
    expect(reset.value).toBe('Mod+0');
    expect(container.textContent).toContain('Increase editor font');
    expect(container.textContent).toContain('Decrease editor font');
    expect(container.textContent).toContain('Reset editor font');
  });

  it('manages the workspace index when a workspace is available', async () => {
    const onDiscardWorkspaceIndex = vi.fn<() => Promise<void>>(async () => undefined);
    const onRebuildWorkspaceIndex = vi.fn<() => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        workspaceAvailable
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)}
        onDiscardWorkspaceIndex={onDiscardWorkspaceIndex}
        onRebuildWorkspaceIndex={onRebuildWorkspaceIndex}
      />,
    ));

    expect(container.textContent).toContain('Workspace Index');
    expect(container.textContent).toContain('Manage the local index used to search workspace files.');
    const discard = container.querySelector<HTMLButtonElement>('[name="discardWorkspaceIndex"]')!;
    const rebuild = container.querySelector<HTMLButtonElement>('[name="rebuildWorkspaceIndex"]')!;
    expect(discard.disabled).toBe(false);
    expect(rebuild.disabled).toBe(false);

    await act(async () => discard.click());
    await act(async () => rebuild.click());
    expect(onDiscardWorkspaceIndex).toHaveBeenCalledTimes(1);
    expect(onRebuildWorkspaceIndex).toHaveBeenCalledTimes(1);
  });

  it('disables workspace index controls and explains why without a workspace', async () => {
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={currentSettingsEnvelope.settings}
        workspaceAvailable={false}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)}
        onDiscardWorkspaceIndex={vi.fn<() => Promise<void>>(async () => undefined)}
        onRebuildWorkspaceIndex={vi.fn<() => Promise<void>>(async () => undefined)}
      />,
    ));

    expect(container.textContent).toContain('Open a workspace to manage its index.');
    expect(container.querySelector<HTMLButtonElement>('[name="discardWorkspaceIndex"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[name="rebuildWorkspaceIndex"]')?.disabled).toBe(true);
  });

  it('shows reset and retry recovery actions without rendering a raw error', async () => {
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        recovery={{ canReset: true, kind: 'recoverable' }}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onRetry={vi.fn<() => Promise<void>>(async () => undefined)}
      />,
    ));

    expect(container.textContent).toContain('Reset Settings');
    expect(container.textContent).toContain('Try Again');
    expect(container.textContent).not.toContain('parse');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it('does not offer reset for a future schema and leaves the file unchanged', async () => {
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        recovery={{ canReset: false, kind: 'future' }}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onRetry={vi.fn<() => Promise<void>>(async () => undefined)}
      />,
    ));

    expect(container.textContent).toContain('Newer mdx Version');
    expect(container.textContent).toContain('Try Again');
    expect(container.textContent).not.toContain('Reset Settings');
  });

  it('offers reload only after a settings conflict without exposing backend details', async () => {
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        recovery={{ canReset: false, kind: 'conflict' }}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onRetry={vi.fn<() => Promise<void>>(async () => undefined)}
      />,
    ));

    expect(container.textContent).toContain('changed in another window');
    expect(container.textContent).toContain('Reload Settings');
    expect(container.textContent).not.toContain('Reset Settings');
    expect(container.textContent).not.toContain('Tauri');
  });
});

describe('SettingsDialog uncovered branches', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('invokes reset and retry from the recoverable dialog', async () => {
    const onReset = vi.fn<() => Promise<void>>(async () => undefined);
    const onRetry = vi.fn<() => Promise<void>>(async () => undefined);
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={null}
        recovery={{ canReset: true, kind: 'recoverable' }}
        onReset={onReset} onRetry={onRetry} />,
    ));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.dialog-button')];
    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the conflict recovery dialog with reload instead of reset', async () => {
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={null}
        recovery={{ canReset: false, kind: 'conflict' }}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)} />,
    ));
    expect(container.textContent).toContain('Reload Settings');
    expect(container.querySelector('[name="resetShortcuts"], .dialog-button.ghost')).toBeNull();
  });

  it('applies an authorized resource directory path to the draft', async () => {
    const onAuthorizeResourceDirectory = vi.fn<() => Promise<string | null>>(async () => '/ws/assets');
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onAuthorizeResourceDirectory={onAuthorizeResourceDirectory}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    const button = container.querySelector<HTMLButtonElement>('[name="authorizeResourceDirectory"]');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('[name="resourceDirectory"]');
    expect(input?.value).toBe('/ws/assets');
  });

  it('selects a skin radio and switches the language mode', async () => {
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    const skin = container.querySelector<HTMLInputElement>('input[name="selectedSkin"][value="qinghua-jilan"]');
    act(() => {
      skin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(skin?.checked).toBe(true);
    const localeSelect = container.querySelector<HTMLSelectElement>('[name="localeMode"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      valueSetter?.call(localeSelect, 'zh-CN');
      localeSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(localeSelect?.value).toBe('zh-CN');
  });

  it('toggles follow-system theme and editor ratio inputs', async () => {
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    const follow = container.querySelector<HTMLInputElement>('[name="followSystemTheme"]');
    act(() => {
      follow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const ratio = container.querySelector<HTMLInputElement>('[name="editorPaneRatio"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(ratio, '0.5');
      ratio?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ratio?.value).toBe('0.5');
  });
});
