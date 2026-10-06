/* eslint-disable react-hooks/exhaustive-deps -- 状态束解构的 setter 为稳定引用，依赖数组保持拆分前语义 */
import { emit, listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, SettingsEnvelope } from '../../types';
import { decodeSettingsEnvelope, projectSettingsError } from '../../lib/settings';
import { getSettings, resetSettings, updateSettings } from '../../lib/tauriCommands';

const SETTINGS_UPDATED_EVENT = 'mmd:settings-changed';

export interface SettingsCommands {
  load(): Promise<SettingsEnvelope>;
  reset(expectedRevision: number | null): Promise<SettingsEnvelope>;
  update(settings: AppSettings, expectedRevision: number): Promise<SettingsEnvelope>;
}

export interface SettingsEventApi {
  emit(event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<() => void>;
}

export interface SettingsRecovery {
  canReset: boolean;
  kind: 'conflict' | 'future' | 'recoverable';
}

const defaultCommands: SettingsCommands = {
  load: () => getSettings(),
  reset: (expectedRevision) => resetSettings(expectedRevision),
  update: (settings, expectedRevision) => updateSettings(settings, expectedRevision),
};

const defaultEventApi: SettingsEventApi = {
  emit: (event, payload) => emit(event, payload),
  listen: (event, listener) => listen<unknown>(event, listener),
};

export function useSettings(dependencies: {
  commands?: SettingsCommands;
  eventApi?: SettingsEventApi;
} = {}) {
  const commands = dependencies.commands ?? defaultCommands;
  const eventApi = dependencies.eventApi ?? defaultEventApi;
  const state = useSettingsState();
  const { busy, envelope, recovery, revisionRef, setBusy, setEnvelope, setRecovery } = state;

  const applyEnvelope = useCallback((next: SettingsEnvelope) => {
    if (next.revision <= revisionRef.current) return;
    revisionRef.current = next.revision;
    setEnvelope(next);
    setRecovery(null);
  }, []);

  const load = useCallback(
    () => runSettingsLoad({ applyEnvelope, commands, setBusy, setRecovery }),
    [applyEnvelope, commands]);

  useCrossWindowSettingsSubscription({ applyEnvelope, eventApi, load, setRecovery });

  const publish = useCallback(
    (next: SettingsEnvelope) => publishSettingsEnvelope({ applyEnvelope, eventApi, next, setRecovery }),
    [applyEnvelope, eventApi]);

  const update = useCallback(
    (settings: AppSettings) => runSettingsUpdate({ commands, publish, revisionRef, setBusy, setRecovery }, settings),
    [commands, publish]);
  const reset = useCallback(async () => {
    setBusy(true);
    try {
      await publish(await commands.reset(revisionRef.current >= 0 ? revisionRef.current : null));
    } catch (error) {
      setRecovery(projectSettingsError(error));
    } finally {
      setBusy(false);
    }
  }, [commands, publish]);

  return useMemo(() => ({
    busy,
    recovery,
    reset,
    retry: load,
    settings: envelope?.settings ?? null,
    updateSettings: update,
  }), [busy, envelope, load, recovery, reset, update]);
}

// 设置面板状态束：信封、忙态与恢复模型。
function useSettingsState() {
  const [envelope, setEnvelope] = useState<SettingsEnvelope | null>(null);
  const [busy, setBusy] = useState(true);
  const [recovery, setRecovery] = useState<SettingsRecovery | null>(null);
  const revisionRef = useRef(-1);
  return { busy, envelope, recovery, revisionRef, setBusy, setEnvelope, setRecovery };
}

// 跨窗口设置更新订阅：载荷解码失败忽略（仅命令结果可替换设置），
// 注册失败进入恢复模型；挂载时执行首次加载。
function useCrossWindowSettingsSubscription(deps: {
  applyEnvelope: (next: SettingsEnvelope) => void;
  eventApi: SettingsEventApi;
  load: () => Promise<void>;
  setRecovery: (recovery: SettingsRecovery) => void;
}): void {
  const { applyEnvelope, eventApi, load, setRecovery } = deps;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void eventApi.listen(SETTINGS_UPDATED_EVENT, (event) => {
      if (disposed) return;
      try {
        applyEnvelope(decodeSettingsEnvelope(event.payload));
      } catch {
        // Ignore invalid cross-window payloads; only command results may replace settings.
      }
    }).then((registered) => {
      if (disposed) registered();
      else unlisten = registered;
    }).catch(() => {
      if (!disposed) setRecovery({ canReset: true, kind: 'recoverable' });
    });
    void load();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyEnvelope, eventApi, load]);
}

// 首次/重试加载：忙态与恢复模型统一收口。
async function runSettingsLoad(deps: {
  applyEnvelope: (next: SettingsEnvelope) => void;
  commands: SettingsCommands;
  setBusy: (busy: boolean) => void;
  setRecovery: (recovery: SettingsRecovery) => void;
}): Promise<void> {
  const { applyEnvelope, commands, setBusy, setRecovery } = deps;
  setBusy(true);
  try {
    applyEnvelope(await commands.load());
  } catch (error) {
    setRecovery(projectSettingsError(error));
  } finally {
    setBusy(false);
  }
}

// 设置更新：要求设置已加载（revision 就绪），否则进入恢复模型。
async function runSettingsUpdate(deps: {
  commands: SettingsCommands;
  publish: (next: SettingsEnvelope) => Promise<void>;
  revisionRef: React.RefObject<number>;
  setBusy: (busy: boolean) => void;
  setRecovery: (recovery: SettingsRecovery) => void;
}, settings: AppSettings): Promise<void> {
  const { commands, publish, revisionRef, setBusy, setRecovery } = deps;
  setBusy(true);
  try {
    if (revisionRef.current < 0) {
      setRecovery({ canReset: true, kind: 'recoverable' });
      return;
    }
    await publish(await commands.update(settings, revisionRef.current));
  } catch (error) {
    setRecovery(projectSettingsError(error));
  } finally {
    setBusy(false);
  }
}

// 发布设置：先本地应用再跨窗口广播；广播失败进入恢复模型。
async function publishSettingsEnvelope(deps: {
  applyEnvelope: (next: SettingsEnvelope) => void;
  eventApi: SettingsEventApi;
  next: SettingsEnvelope;
  setRecovery: (recovery: SettingsRecovery) => void;
}): Promise<void> {
  deps.applyEnvelope(deps.next);
  try {
    await deps.eventApi.emit(SETTINGS_UPDATED_EVENT, deps.next);
  } catch {
    deps.setRecovery({ canReset: true, kind: 'recoverable' });
  }
}
