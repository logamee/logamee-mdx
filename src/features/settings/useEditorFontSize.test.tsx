// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types';
import { currentSettingsEnvelope } from '../../lib/settingsFixtures';
import { DEFAULT_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE } from '../../lib/settings';
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

// 模拟真实应用的滞后链：写入承诺立即完成，但设置状态要等一个宏任务后才
// 推进（对应 React 调度延迟、恢复模型介入等场景），用于固化“写入完成但
// 设置尚未重渲染”的窗口。
function LaggingHarness({ initial, applyDelayMs, updateSettings, observe }: {
  initial: AppSettings | null;
  applyDelayMs: number;
  updateSettings: (settings: AppSettings) => Promise<void>;
  observe: (value: EditorFontSizeController) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(initial);
  const value = useEditorFontSize(settings, (next) => {
    void updateSettings(next);
    globalThis.setTimeout(() => setSettings(next), applyDelayMs);
    return Promise.resolve();
  });
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

    // 第二次写入依赖"写入完成 → 设置重渲染推进 → 重查冲刷"链：jsdom 下
    // 渲染在 act 退出时才冲刷，重查按 25ms 间隔重试，两段等待分别覆盖
    // 渲染冲刷和下一次重查，保证慢机器上断言前冲刷已真正发起。
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
    });
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1][0].editorFontSize).toBe(19);

    await settleFlush();
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps the queued target when the settings application lags behind the completed write', async () => {
    const updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(async () => undefined);
    let controller: EditorFontSizeController | undefined;
    const observe = (value: EditorFontSizeController) => { controller = value; };

    await act(async () => root.render(
      <LaggingHarness
        initial={{ ...currentSettingsEnvelope.settings, editorFontSize: 16 }}
        applyDelayMs={40}
        updateSettings={updateSettings}
        observe={observe}
      />,
    ));

    act(() => {
      controller?.increase();
      controller?.increase();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0].editorFontSize).toBe(17);

    // 写入已完成但设置要 40ms 后才推进：排队的目标（18）必须在重查中
    // 存活到设置推进，再串行写入，而不是被立即丢弃。第一段等待让设置
    // 应用并在 act 退出时冲刷渲染；第二段等待覆盖一次重查间隔，让冲刷
    // 真正发起第二次写入。
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    });
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1][0].editorFontSize).toBe(18);
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
