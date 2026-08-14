import { describe, expect, it, vi } from 'vitest';
import {
  LOCALE_SNAPSHOT_EVENT,
  LOCALE_STORAGE_KEY,
  type LocalePreference,
  type LocaleRoot,
  type LocaleStorage,
} from './locale';
import { createLocaleRuntime, type LocaleEventApi, type LocaleStorageEventSource } from './localeRuntime';
import { NATIVE_MENU_EVENT } from './nativeMenu';

class MemoryStorage implements LocaleStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class FakeRoot implements LocaleRoot {
  readonly values = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.values.set(name, value); }
}

class FakeStorageEvents implements LocaleStorageEventSource {
  private listener: ((event: { key: string | null; newValue: string | null }) => void) | null = null;
  addEventListener(_: 'storage', listener: (event: { key: string | null; newValue: string | null }) => void): void { this.listener = listener; }
  removeEventListener(): void { this.listener = null; }
  deliver(key: string, newValue: string): void { this.listener?.({ key, newValue }); }
}

class FakeEventApi implements LocaleEventApi {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly listened: string[] = [];
  private readonly listeners = new Map<string, (event: { payload: unknown }) => void>();
  emit(event: string, payload: unknown): Promise<void> { this.emitted.push({ event, payload }); return Promise.resolve(); }
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<() => void> {
    this.listened.push(event);
    this.listeners.set(event, listener);
    return Promise.resolve(() => this.listeners.delete(event));
  }
  deliver(event: string, payload: unknown): void { this.listeners.get(event)?.({ payload }); }
}

const preference = (mode: LocalePreference['mode']): LocalePreference => ({ version: 1, mode });

describe('locale runtime', () => {
  it('persists a native selection, applies it, projects the native menu, and broadcasts', async () => {
    const storage = new MemoryStorage();
    const root = new FakeRoot();
    const eventApi = new FakeEventApi();
    const projected: Array<{ preference: LocalePreference; effectiveLocale: string }> = [];
    const runtime = createLocaleRuntime({
      role: 'main', root, storage, storageEvents: new FakeStorageEvents(), eventApi,
      systemLanguage: 'en-US', initialPreference: preference('system'), revisionSeed: 10,
      syncNativePreference: async (nextPreference, effectiveLocale) => {
        projected.push({ preference: nextPreference, effectiveLocale });
      },
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();
    projected.length = 0;

    eventApi.deliver(NATIVE_MENU_EVENT, 'locale:zh-CN');
    await vi.waitFor(() => expect(eventApi.emitted).toHaveLength(1));

    expect(runtime.getSnapshot().preference).toEqual(preference('zh-CN'));
    expect(runtime.getSnapshot().effectiveLocale).toBe('zh-CN');
    expect(root.values.get('lang')).toBe('zh-CN');
    expect(JSON.parse(storage.values.get(LOCALE_STORAGE_KEY)!)).toEqual(preference('zh-CN'));
    expect(projected).toEqual([{ preference: preference('zh-CN'), effectiveLocale: 'zh-CN' }]);
    expect(eventApi.emitted[0]).toEqual({
      event: LOCALE_SNAPSHOT_EVENT,
      payload: { protocolVersion: 1, revision: 11, preference: preference('zh-CN') },
    });
  });

  it('converges a popout from the main locale snapshot and notifies subscribers', async () => {
    const eventApi = new FakeEventApi();
    const root = new FakeRoot();
    const runtime = createLocaleRuntime({
      role: 'popout', root, storage: new MemoryStorage(), storageEvents: new FakeStorageEvents(), eventApi,
      systemLanguage: 'en-US', initialPreference: preference('system'), revisionSeed: 0,
      onError: vi.fn<(error: unknown) => void>(),
    });
    const listener = vi.fn<() => void>();
    runtime.subscribe(listener);
    await runtime.start();

    eventApi.deliver(LOCALE_SNAPSHOT_EVENT, {
      protocolVersion: 1,
      revision: 4,
      preference: preference('zh-CN'),
    });

    expect(runtime.getSnapshot().effectiveLocale).toBe('zh-CN');
    expect(root.values.get('lang')).toBe('zh-CN');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(eventApi.listened).toContain(LOCALE_SNAPSHOT_EVENT);
  });
});
