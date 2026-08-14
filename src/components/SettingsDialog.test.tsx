// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../types';
import { currentSettingsEnvelope } from '../lib/settings.test';
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

  it('lists the complete LogicFrame palette catalog with localized exact names', async () => {
    await act(async () => root.render(
      <SettingsDialog busy={false} locale="en" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    const options = [...container.querySelectorAll<HTMLOptionElement>('select[name="selectedSkin"] option')];
    expect(options.map(({ value, textContent }) => [value, textContent])).toEqual([
      ['original', 'Plain Paper · Indigo'],
      ['jinxiu-zhusha', 'Vermilion Notes · Cinnabar'],
      ['ruyao-tianqing', 'Ru Ware · Sky Blue'],
      ['qinghua-jilan', 'Blue-and-White · Cobalt'],
      ['songke-zhuying', 'Song Edition · Bamboo Green'],
      ['gujuan-nuanxing', 'Apricot Paper · Red Ochre'],
      ['zhuying-qingci', 'Spring Paper · Pea Green'],
      ['jiushu-huangzhi', 'Misty Landscape · Antique Silk'],
      ['shanshui-yemo', 'Night Tome · Pine Soot Ink'],
    ]);

    await act(async () => root.render(
      <SettingsDialog busy={false} locale="zh-CN" settings={currentSettingsEnvelope.settings}
        onClose={vi.fn<() => void>()}
        onReset={vi.fn<() => Promise<void>>(async () => undefined)}
        onSave={vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined)} />,
    ));
    expect([...container.querySelectorAll<HTMLOptionElement>('select[name="selectedSkin"] option')]
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
