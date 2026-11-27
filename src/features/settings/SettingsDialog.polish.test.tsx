// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types';
import { currentSettingsEnvelope } from '../../lib/settingsFixtures';
import { applyEffectiveTheme } from '../../lib/theme';
import { applyEditorFontSize } from '../../lib/settings';
import { SettingsDialog } from './SettingsDialog';
import { FileSidebarRail } from '../workspace/fileSidebarChromeView';

describe('SettingsDialog and SidebarRail polish behaviors', () => {
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
    document.documentElement.removeAttribute('data-skin');
    document.documentElement.removeAttribute('data-appearance');
    document.documentElement.style.removeProperty('--editor-font-size');
  });

  const settings = currentSettingsEnvelope.settings;
  const callbacks = {
    onReset: async () => undefined,
    onSave: async (_next: AppSettings) => undefined,
  };

  it('closes on the primary mouse button only', async () => {
    const onClose = vi.fn<() => void>();
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={settings} onClose={onClose} {...callbacks} />,
    ));
    expect(container.querySelector('dialog')!.classList.contains('settings-tabs-dialog')).toBe(true);
    for (const button of [1, 2]) {
      act(() => container.querySelector('.settings-dialog-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button })));
    }
    expect(onClose).not.toHaveBeenCalled();
    act(() => container.querySelector('.settings-dialog-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the live appearance preview while a save is in flight', async () => {
    document.documentElement.setAttribute('data-skin', settings.selectedSkin);
    document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`);
    let finish!: () => void;
    const onSave = vi.fn<(_next: AppSettings) => Promise<void>>(() => new Promise<void>((resolve) => { finish = resolve; }));
    const render = (busy: boolean, next: AppSettings = settings) => act(async () => root.render(
      <SettingsDialog busy={busy} locale="en" settings={next} onClose={() => root.render(null)} onReset={async () => undefined} onSave={onSave} />,
    ));
    await render(false);
    act(() => {
      container.querySelector<HTMLInputElement>('input[value="shanshui-yemo"]')!.click();
      const fontInput = container.querySelector<HTMLInputElement>('[name="editorFontSize"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fontInput, '22');
      fontInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector<HTMLButtonElement>('.settings-dialog-actions button[type="submit"]')!.click());
    expect(onSave).toHaveBeenCalledOnce();

    // 写入期间应用把 busy 置为 true，预览不能在确认结果到达前退回旧皮肤。
    await render(true);
    expect(document.documentElement.getAttribute('data-skin')).toBe('shanshui-yemo');
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('22px');

    // 已确认的设置投影先于对话框卸载到达。
    act(() => {
      applyEffectiveTheme(document.documentElement, { skin: 'shanshui-yemo', appearance: 'light' });
      applyEditorFontSize(document.documentElement, 22);
    });
    await render(true, { ...settings, selectedSkin: 'shanshui-yemo', editorFontSize: 22 });
    await act(async () => { finish(); });
    act(() => root.render(null));
    expect(document.documentElement.getAttribute('data-skin')).toBe('shanshui-yemo');
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('22px');
  });

  it('focuses the dialog, closes on Escape or backdrop, and restores focus to the opener', async () => {
    const opener = document.createElement('button');
    container.before(opener);
    opener.focus();
    const onClose = vi.fn<() => void>(() => root.render(null));
    const open = () => act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={settings} onClose={onClose} {...callbacks} />,
    ));
    try {
      await open();
      expect(container.querySelector('dialog')!.contains(document.activeElement)).toBe(true);
      act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
      expect(onClose).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(opener);
      await open();
      opener.focus();
      act(() => opener.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
      expect(onClose).toHaveBeenCalledTimes(2);
      await open();
      act(() => container.querySelector('.settings-dialog-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
      expect(onClose).toHaveBeenCalledTimes(3);
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it('stays open while an IME composition reports Escape', async () => {
    const onClose = vi.fn<() => void>();
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={settings} onClose={onClose} {...callbacks} />,
    ));
    for (const init of [
      { isComposing: true, key: 'Escape' },
      { isComposing: false, key: 'Escape', keyCode: 229 },
    ]) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      act(() => document.activeElement!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'failed save', 'failed reset'])('restores the live skin and font preview after %s', async (outcome) => {
    document.documentElement.setAttribute('data-skin', 'original');
    document.documentElement.setAttribute('data-appearance', 'light');
    document.documentElement.style.setProperty('--editor-font-size', '16px');
    const recover = async () => root.render(
      <SettingsDialog locale="en" busy={false} recovery={{ kind: 'conflict', canReset: false }} {...callbacks} />,
    );
    await act(async () => root.render(
      <SettingsDialog
        busy={false}
        locale="en"
        settings={settings}
        onClose={() => root.render(null)}
        onReset={recover}
        onSave={recover}
      />,
    ));

    const darkSkin = container.querySelector<HTMLInputElement>('input[name="selectedSkin"][value="shanshui-yemo"]');
    act(() => {
      darkSkin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.documentElement.getAttribute('data-skin')).toBe('shanshui-yemo');
    act(() => {
      const fontInput = container.querySelector<HTMLInputElement>('[name="editorFontSize"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fontInput, '22');
      fontInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('22px');
    if (outcome === 'failed save') {
      act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    } else if (outcome === 'failed reset') {
      act(() => container.querySelector<HTMLButtonElement>('.settings-dialog-actions button')!.click());
    } else {
      act(() => container.querySelector<HTMLButtonElement>('.settings-dialog-close')!.click());
    }
    expect(Boolean(container.querySelector('[role="alertdialog"]'))).toBe(outcome !== 'cancel');
    expect(document.documentElement.getAttribute('data-skin')).toBe('original');
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('16px');
  });

  it('preserves an incoming appearance revision when a preview is dismissed', async () => {
    const render = (value: AppSettings) => act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={value} onClose={() => root.render(null)} {...callbacks} />,
    ));
    await render(settings);
    act(() => container.querySelector<HTMLInputElement>('input[value="shanshui-yemo"]')!.click());
    applyEffectiveTheme(document.documentElement, { skin: 'qinghua-jilan', appearance: 'light' });
    document.documentElement.style.setProperty('--editor-font-size', '20px');
    await render({ ...settings, selectedSkin: 'qinghua-jilan', editorFontSize: 20 });
    act(() => container.querySelector<HTMLInputElement>('input[value="shanshui-yemo"]')!.click());
    act(() => root.render(null));
    expect(document.documentElement.getAttribute('data-skin')).toBe('qinghua-jilan');
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('20px');
  });

  it('preserves a confirmed settings projection even when it equals the outgoing preview', async () => {
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={settings} onClose={() => root.render(null)} {...callbacks} />,
    ));
    act(() => {
      container.querySelector<HTMLInputElement>('input[value="shanshui-yemo"]')!.click();
      const fontInput = container.querySelector<HTMLInputElement>('[name="editorFontSize"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fontInput, '22');
      fontInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    applyEditorFontSize(document.documentElement, 22);
    applyEffectiveTheme(document.documentElement, { skin: 'shanshui-yemo', appearance: 'dark' });
    act(() => root.render(null));
    expect(document.documentElement.getAttribute('data-skin')).toBe('shanshui-yemo');
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('22px');
  });

  it('exposes files, outline, and quick-open actions on the collapsed sidebar rail', () => {
    const onCollapseChange = vi.fn<(collapsed: boolean) => void>();
    const onSelectView = vi.fn<(view: 'files' | 'outline') => void>();
    const onQuickOpen = vi.fn<() => void>();

    act(() => {
      root.render(
        <FileSidebarRail
          onCollapseChange={onCollapseChange}
          onQuickOpen={onQuickOpen}
          onSelectView={onSelectView}
          toggleLabel="Expand file tree"
        />,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Outline"]')?.click();
    });
    expect(onSelectView).toHaveBeenCalledWith('outline');
    expect(onCollapseChange).toHaveBeenCalledWith(false);

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Quick Open"]')?.click();
    });
    expect(onQuickOpen).toHaveBeenCalledTimes(1);
  });
});
