// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../types';
import { currentSettingsEnvelope } from '../lib/settings.test';
import { DEFAULT_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE } from '../lib/settings';
import { useEditorFontSize } from './useEditorFontSize';

type EditorFontSizeController = ReturnType<typeof useEditorFontSize>;

// 模拟 useSettings 的提交时序：命令完成后 settings 才携带新字号重渲染。
function Harness({ initial, updateSettings, observe }: {
  initial: AppSettings | null;
  updateSettings: (settings: AppSettings) => Promise<void>;
  observe: (value: EditorFontSizeController) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(initial);
  const value = useEditorFontSize(settings, (next) => updateSettings(next).then(() => setSettings(next)));
  useEffect(() => observe(value), [observe, value]);
  return <output>{value.fontSize}</output>;
}

describe('useEditorFontSize', () => {
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
    vi.restoreAllMocks();
  });

  async function renderHarness(initial: AppSettings | null, updateSettings: (settings: AppSettings) => Promise<void>) {
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    let controller: EditorFontSizeController | undefined;
    const observe = (value: EditorFontSizeController) => { controller = value; };
    await act(async () => root.render(
      <Harness initial={initial} updateSettings={updateSettings} observe={observe} />,
    ));
    return () => controller;
  }

  const settleFlush = async () => {
    await act(async () => { await new Promise((resolve) => globalThis.setTimeout(resolve, 1)); });
  };

  it('steps the persisted size by one and resets it to the default', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    const getController = await renderHarness(
      { ...currentSettingsEnvelope.settings, editorFontSize: 16 },
      updateSettings,
    );

    await act(async () => getController()?.increase());
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0].editorFontSize).toBe(17);

    await settleFlush();
    await act(async () => getController()?.reset());
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1][0].editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(container.textContent).toBe(String(DEFAULT_EDITOR_FONT_SIZE));
  });

  it('coalesces rapid steps into serialized writes instead of concurrent revisions', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    const getController = await renderHarness(
      { ...currentSettingsEnvelope.settings, editorFontSize: 16 },
      updateSettings,
    );

    act(() => {
      getController()?.increase();
      getController()?.increase();
      getController()?.increase();
    });
    // 第一次写入立即开始；连按期间的目标（19）在它完成后串行冲刷。
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0].editorFontSize).toBe(17);

    await settleFlush();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1][0].editorFontSize).toBe(19);

    await settleFlush();
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it('skips writes when the size is already at the boundary', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    const getController = await renderHarness(
      { ...currentSettingsEnvelope.settings, editorFontSize: MAX_EDITOR_FONT_SIZE },
      updateSettings,
    );
    expect(container.textContent).toBe(String(MAX_EDITOR_FONT_SIZE));

    await act(async () => getController()?.increase());
    await settleFlush();
    expect(updateSettings).not.toHaveBeenCalled();

    const smallest = await renderHarness(
      { ...currentSettingsEnvelope.settings, editorFontSize: MIN_EDITOR_FONT_SIZE },
      updateSettings,
    );
    await act(async () => smallest()?.decrease());
    await settleFlush();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('ignores requests while settings are unavailable', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    const getController = await renderHarness(null, updateSettings);

    await act(async () => getController()?.increase());
    await settleFlush();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(container.textContent).toBe(String(DEFAULT_EDITOR_FONT_SIZE));
  });

  it('drops the queued target when a write fails so it is not retried forever', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => {
      throw new Error('settings backend unavailable');
    });
    const getController = await renderHarness(
      { ...currentSettingsEnvelope.settings, editorFontSize: 16 },
      updateSettings,
    );

    await act(async () => getController()?.increase());
    await settleFlush();
    await settleFlush();
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
