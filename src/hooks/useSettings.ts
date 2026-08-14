import { emit, listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, SettingsEnvelope } from '../types';
import { decodeSettingsEnvelope, projectSettingsError } from '../lib/settings';
import { getSettings, resetSettings, updateSettings } from '../lib/tauriCommands';

export const SETTINGS_UPDATED_EVENT = 'mmd:settings-changed';

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
  const [envelope, setEnvelope] = useState<SettingsEnvelope | null>(null);
  const [busy, setBusy] = useState(true);
  const [recovery, setRecovery] = useState<SettingsRecovery | null>(null);
  const revisionRef = useRef(-1);

  const applyEnvelope = useCallback((next: SettingsEnvelope) => {
    if (next.revision <= revisionRef.current) return;
    revisionRef.current = next.revision;
    setEnvelope(next);
    setRecovery(null);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      applyEnvelope(await commands.load());
    } catch (error) {
      setRecovery(projectSettingsError(error));
    } finally {
      setBusy(false);
    }
  }, [applyEnvelope, commands]);

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

  const publish = useCallback(async (next: SettingsEnvelope) => {
    applyEnvelope(next);
    try {
      await eventApi.emit(SETTINGS_UPDATED_EVENT, next);
    } catch {
      setRecovery({ canReset: true, kind: 'recoverable' });
    }
  }, [applyEnvelope, eventApi]);

  const update = useCallback(async (settings: AppSettings) => {
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
  }, [commands, publish]);

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
