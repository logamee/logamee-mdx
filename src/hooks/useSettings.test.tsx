// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsEnvelope } from '../types';
import { currentSettingsEnvelope } from '../lib/settings.test';
import { useSettings, type SettingsCommands, type SettingsEventApi } from './useSettings';

function createEventApi() {
  const listeners = new Set<(event: { payload: unknown }) => void>();
  const api: SettingsEventApi = {
    emit: vi.fn<SettingsEventApi['emit']>(async (_event, payload) => {
      listeners.forEach((listener) => listener({ payload }));
    }),
    listen: vi.fn<SettingsEventApi['listen']>(async (_event, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { api, listeners };
}

function Harness({ commands, eventApi, observe }: {
  commands: SettingsCommands;
  eventApi: SettingsEventApi;
  observe: (value: ReturnType<typeof useSettings>) => void;
}) {
  const value = useSettings({ commands, eventApi });
  useEffect(() => observe(value), [observe, value]);
  return <output>{value.settings?.autosaveDelayMs ?? 'loading'}</output>;
}

describe('useSettings', () => {
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

  it('loads settings and propagates successful updates to every listener', async () => {
    const updated: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 5,
      settings: { ...currentSettingsEnvelope.settings, autosaveDelayMs: 2400 },
    };
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>(async () => currentSettingsEnvelope),
      reset: vi.fn<SettingsCommands['reset']>(async () => currentSettingsEnvelope),
      update: vi.fn<SettingsCommands['update']>(async () => updated),
    };
    const { api } = createEventApi();
    let current: ReturnType<typeof useSettings> | undefined;

    await act(async () => root.render(<Harness commands={commands} eventApi={api} observe={(value) => { current = value; }} />));
    expect(container.textContent).toBe('1500');

    await act(async () => current?.updateSettings(updated.settings));
    expect(container.textContent).toBe('2400');
    expect(api.emit).toHaveBeenCalledWith('mmd:settings-changed', updated);
  });

  it('offers reset and retry after a corrupt load without exposing the raw backend error', async () => {
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>()
        .mockRejectedValueOnce({ code: 'malformed', message: 'secret /Users/me/settings.json parse error', canReset: true })
        .mockResolvedValueOnce(currentSettingsEnvelope),
      reset: vi.fn<SettingsCommands['reset']>(async () => currentSettingsEnvelope),
      update: vi.fn<SettingsCommands['update']>(async () => currentSettingsEnvelope),
    };
    const { api } = createEventApi();
    let current: ReturnType<typeof useSettings> | undefined;

    await act(async () => root.render(<Harness commands={commands} eventApi={api} observe={(value) => { current = value; }} />));
    expect(current?.recovery).toEqual({ canReset: true, kind: 'recoverable' });
    expect(JSON.stringify(current?.recovery)).not.toContain('/Users/me');

    await act(async () => current?.retry());
    expect(current?.settings).toEqual(currentSettingsEnvelope.settings);
    expect(current?.recovery).toBeNull();
  });

  it('reset persists defaults and broadcasts them to active and popout hooks', async () => {
    const defaults: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 6,
      settings: { ...currentSettingsEnvelope.settings, autosaveEnabled: false },
    };
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>().mockRejectedValue({ code: 'invalid', message: 'bad', canReset: true }),
      reset: vi.fn<SettingsCommands['reset']>(async () => defaults),
      update: vi.fn<SettingsCommands['update']>(async () => defaults),
    };
    const { api } = createEventApi();
    let current: ReturnType<typeof useSettings> | undefined;

    await act(async () => root.render(<Harness commands={commands} eventApi={api} observe={(value) => { current = value; }} />));
    await act(async () => current?.reset());

    expect(commands.reset).toHaveBeenCalledOnce();
    expect(commands.reset).toHaveBeenCalledWith(null);
    expect(current?.settings).toEqual(defaults.settings);
    expect(api.emit).toHaveBeenCalledWith('mmd:settings-changed', defaults);
  });

  it('synchronizes two mounted window consumers in both directions and ignores stale remote events', async () => {
    const updateEnvelope: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 5,
      settings: { ...currentSettingsEnvelope.settings, spellcheckEnabled: false },
    };
    const resetEnvelope: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 6,
      settings: { ...currentSettingsEnvelope.settings, autosaveEnabled: false },
    };
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>(async () => currentSettingsEnvelope),
      reset: vi.fn<SettingsCommands['reset']>(async () => resetEnvelope),
      update: vi.fn<SettingsCommands['update']>(async () => updateEnvelope),
    };
    const { api, listeners } = createEventApi();
    const consumers: Array<ReturnType<typeof useSettings> | undefined> = [];

    await act(async () => root.render(
      <>
        <Harness commands={commands} eventApi={api} observe={(value) => { consumers[0] = value; }} />
        <Harness commands={commands} eventApi={api} observe={(value) => { consumers[1] = value; }} />
      </>,
    ));
    await act(async () => consumers[0]?.updateSettings(updateEnvelope.settings));
    expect(consumers[0]?.settings?.spellcheckEnabled).toBe(false);
    expect(consumers[1]?.settings?.spellcheckEnabled).toBe(false);

    await act(async () => consumers[1]?.reset());
    expect(commands.reset).toHaveBeenCalledOnce();
    expect(commands.reset).toHaveBeenCalledWith(5);
    expect(consumers[0]?.settings?.autosaveEnabled).toBe(false);
    expect(consumers[1]?.settings?.autosaveEnabled).toBe(false);

    const stale = { ...currentSettingsEnvelope, revision: 5 };
    await act(async () => listeners.forEach((listener) => listener({ payload: stale })));
    expect(consumers[0]?.settings?.autosaveEnabled).toBe(false);
    expect(consumers[1]?.settings?.autosaveEnabled).toBe(false);
  });

  it('passes the loaded revision to update and reloads after a stale-consumer conflict', async () => {
    const latest: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 5,
      settings: { ...currentSettingsEnvelope.settings, resourceDirectory: 'media' },
    };
    const update = vi.fn<SettingsCommands['update']>(async (_settings, expectedRevision) => {
      if (expectedRevision !== latest.revision) {
        throw { code: 'conflict', message: 'stale settings at /Users/me/settings.json', canReset: false };
      }
      return latest;
    });
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>()
        .mockResolvedValueOnce(currentSettingsEnvelope)
        .mockResolvedValueOnce(latest),
      reset: vi.fn<SettingsCommands['reset']>(async () => latest),
      update,
    };
    const { api } = createEventApi();
    let current: ReturnType<typeof useSettings> | undefined;

    await act(async () => root.render(<Harness commands={commands} eventApi={api} observe={(value) => { current = value; }} />));
    await act(async () => current?.updateSettings({ ...currentSettingsEnvelope.settings, resourceDirectory: 'images' }));

    expect(update).toHaveBeenCalledWith(expect.any(Object), 4);
    expect(current?.settings?.resourceDirectory).toBe('assets');
    expect(current?.recovery).toEqual({ canReset: false, kind: 'conflict' });
    expect(JSON.stringify(current?.recovery)).not.toContain('/Users/me');

    await act(async () => current?.retry());
    expect(current?.settings?.resourceDirectory).toBe('media');
    expect(current?.recovery).toBeNull();
  });

  it('passes the loaded revision to reset and preserves newer settings on conflict', async () => {
    const latest: SettingsEnvelope = {
      ...currentSettingsEnvelope,
      revision: 8,
      settings: { ...currentSettingsEnvelope.settings, spellcheckEnabled: false },
    };
    const reset = vi.fn<SettingsCommands['reset']>(async (expectedRevision) => {
      if (expectedRevision !== latest.revision) {
        throw { code: 'conflict', message: 'raw Tauri conflict /private/settings.json', canReset: false };
      }
      return latest;
    });
    const commands: SettingsCommands = {
      load: vi.fn<SettingsCommands['load']>()
        .mockResolvedValueOnce(currentSettingsEnvelope)
        .mockResolvedValueOnce(latest),
      reset,
      update: vi.fn<SettingsCommands['update']>(async () => latest),
    };
    const { api } = createEventApi();
    let current: ReturnType<typeof useSettings> | undefined;

    await act(async () => root.render(<Harness commands={commands} eventApi={api} observe={(value) => { current = value; }} />));
    await act(async () => current?.reset());

    expect(reset).toHaveBeenCalledWith(4);
    expect(current?.settings?.spellcheckEnabled).toBe(true);
    expect(current?.recovery).toEqual({ canReset: false, kind: 'conflict' });

    await act(async () => current?.retry());
    expect(current?.settings?.spellcheckEnabled).toBe(false);
  });
});
