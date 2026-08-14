import { describe, expect, it, vi } from 'vitest';
import {
  THEME_SNAPSHOT_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
  type ThemeRoot,
  type ThemeStorage,
} from './theme';
import {
  createThemeRuntime,
  type ThemeEventApi,
  type ThemeMediaQuery,
  type ThemeStorageEventSource,
  type ThemeUnlisten,
} from './themeRuntime';
import { NATIVE_MENU_EVENT } from './nativeMenu';

class MemoryThemeStorage implements ThemeStorage {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.push({ key, value });
  }
}

class FakeRoot implements ThemeRoot {
  readonly values = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.values.set(name, value);
  }
}

class FakeMediaQuery implements ThemeMediaQuery {
  private listener: ((event: { matches: boolean }) => void) | null = null;
  readonly add = vi.fn<ThemeMediaQuery['addEventListener']>((_, listener) => {
    this.listener = listener;
  });
  readonly remove = vi.fn<ThemeMediaQuery['removeEventListener']>((_, listener) => {
    if (this.listener === listener) this.listener = null;
  });

  constructor(public matches: boolean) {}

  addEventListener = this.add;
  removeEventListener = this.remove;

  change(matches: boolean): void {
    this.matches = matches;
    this.listener?.({ matches });
  }
}

class FakeStorageEvents implements ThemeStorageEventSource {
  private listener: ((event: { key: string | null; newValue: string | null }) => void) | null = null;
  readonly add = vi.fn<ThemeStorageEventSource['addEventListener']>((_, listener) => {
    this.listener = listener;
  });
  readonly remove = vi.fn<ThemeStorageEventSource['removeEventListener']>((_, listener) => {
    if (this.listener === listener) this.listener = null;
  });

  addEventListener = this.add;
  removeEventListener = this.remove;

  deliver(key: string, newValue: string): void {
    this.listener?.({ key, newValue });
  }
}

class FakeEventApi implements ThemeEventApi {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly listened: string[] = [];
  readonly unlisten = vi.fn<ThemeUnlisten>();
  private readonly listeners = new Map<string, (event: { payload: unknown }) => void>();

  emit(event: string, payload: unknown): Promise<void> {
    this.emitted.push({ event, payload });
    return Promise.resolve();
  }

  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<ThemeUnlisten> {
    this.listened.push(event);
    this.listeners.set(event, listener);
    return Promise.resolve(() => {
      this.listeners.delete(event);
      this.unlisten();
    });
  }

  deliver(payload: unknown): void {
    this.deliverFor(THEME_SNAPSHOT_EVENT, payload);
  }

  deliverFor(event: string, payload: unknown): void {
    this.listeners.get(event)?.({ payload });
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const preference = (selectedSkin: ThemePreference['selectedSkin'], followSystem = false): ThemePreference => ({
  version: 1,
  selectedSkin,
  followSystem,
});

describe('theme runtime', () => {
  it('persists, applies, and broadcasts one revisioned snapshot from the main authority', async () => {
    const storage = new MemoryThemeStorage();
    const root = new FakeRoot();
    const mediaQuery = new FakeMediaQuery(false);
    const storageEvents = new FakeStorageEvents();
    const eventApi = new FakeEventApi();
    const runtime = createThemeRuntime({
      role: 'main', root, storage, mediaQuery, storageEvents, eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 40,
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();
    expect(eventApi.listened).toEqual([NATIVE_MENU_EVENT, THEME_SNAPSHOT_EVENT]);

    expect(runtime.setPreference(preference('ruyao-tianqing', true))).toBe(true);
    await Promise.resolve();

    expect(storage.writes[storage.writes.length - 1]).toEqual({
      key: THEME_STORAGE_KEY,
      value: JSON.stringify(preference('ruyao-tianqing', true)),
    });
    expect(root.values.get('data-skin')).toBe('ruyao-tianqing');
    expect(eventApi.emitted).toEqual([{
      event: THEME_SNAPSHOT_EVENT,
      payload: {
        protocolVersion: 1,
        revision: 41,
        preference: preference('ruyao-tianqing', true),
      },
    }]);
  });

  it('routes a native theme command through main authority, native checks, and one broadcast', async () => {
    const storage = new MemoryThemeStorage();
    const eventApi = new FakeEventApi();
    const synced: ThemePreference[] = [];
    const runtime = createThemeRuntime({
      role: 'main', root: new FakeRoot(), storage,
      mediaQuery: new FakeMediaQuery(false), storageEvents: new FakeStorageEvents(), eventApi,
      initialPreference: preference('jinxiu-zhusha', true), revisionSeed: 20,
      syncNativePreference: async (nextPreference) => {
        synced.push(nextPreference);
      },
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();
    synced.length = 0;

    eventApi.deliverFor(NATIVE_MENU_EVENT, 'theme-skin:qinghua-jilan');
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getSnapshot().preference).toEqual(preference('qinghua-jilan', true));
    expect(synced).toEqual([preference('qinghua-jilan', true)]);
    expect(storage.writes).toHaveLength(1);
    expect(eventApi.emitted).toEqual([{
      event: THEME_SNAPSHOT_EVENT,
      payload: {
        protocolVersion: 1,
        revision: 21,
        preference: preference('qinghua-jilan', true),
      },
    }]);

    eventApi.deliverFor(NATIVE_MENU_EVENT, 'theme-follow-system');
    await vi.waitFor(() => expect(eventApi.emitted).toHaveLength(2));
    expect(runtime.getSnapshot().preference).toEqual(preference('qinghua-jilan', false));
  });

  it('does not broadcast a stale projection after storage already converged a popout to the latest commit', async () => {
    const eventApi = new FakeEventApi();
    const popoutEventApi = new FakeEventApi();
    const popoutStorageEvents = new FakeStorageEvents();
    const popoutRoot = new FakeRoot();
    const firstProjection = deferred<void>();
    const secondProjection = deferred<void>();
    const projected: ThemePreference[] = [];
    const runtime = createThemeRuntime({
      role: 'main', root: new FakeRoot(), storage: new MemoryThemeStorage(),
      mediaQuery: new FakeMediaQuery(false), storageEvents: new FakeStorageEvents(), eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 50,
      syncNativePreference: (nextPreference) => {
        projected.push(nextPreference);
        if (projected.length === 1) return Promise.resolve();
        if (projected.length === 2) return firstProjection.promise;
        return secondProjection.promise;
      },
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();
    const popoutRuntime = createThemeRuntime({
      role: 'popout', root: popoutRoot, storage: new MemoryThemeStorage(),
      mediaQuery: new FakeMediaQuery(false), storageEvents: popoutStorageEvents,
      eventApi: popoutEventApi, initialPreference: preference('jinxiu-zhusha'), revisionSeed: 0,
      onError: vi.fn<(error: unknown) => void>(),
    });
    await popoutRuntime.start();

    expect(runtime.setPreference(preference('ruyao-tianqing'))).toBe(true);
    expect(runtime.setPreference(preference('qinghua-jilan'))).toBe(true);
    popoutStorageEvents.deliver(
      THEME_STORAGE_KEY,
      JSON.stringify(preference('qinghua-jilan')),
    );
    expect(popoutRoot.values.get('data-skin')).toBe('qinghua-jilan');
    await Promise.resolve();
    expect(projected).toEqual([
      preference('jinxiu-zhusha'),
      preference('ruyao-tianqing'),
    ]);

    expect(projected).toHaveLength(2);
    expect(eventApi.emitted).toEqual([]);

    firstProjection.resolve();
    await vi.waitFor(() => expect(projected).toHaveLength(3));
    expect(eventApi.emitted).toEqual([]);
    expect(popoutRoot.values.get('data-skin')).toBe('qinghua-jilan');

    secondProjection.resolve();
    await vi.waitFor(() => expect(eventApi.emitted).toHaveLength(1));

    expect(projected).toEqual([
      preference('jinxiu-zhusha'),
      preference('ruyao-tianqing'),
      preference('qinghua-jilan'),
    ]);

    expect(runtime.getSnapshot()).toMatchObject({
      preference: preference('qinghua-jilan'),
      revision: 51,
    });
    expect(eventApi.emitted.map(({ payload }) => payload)).toEqual([
      { protocolVersion: 1, revision: 51, preference: preference('qinghua-jilan') },
    ]);
    popoutEventApi.deliver(eventApi.emitted[0].payload);
    expect(popoutRuntime.getSnapshot().preference).toEqual(preference('qinghua-jilan'));
    expect(popoutRoot.values.get('data-skin')).toBe('qinghua-jilan');
  });

  it('registers the native menu listener before awaiting the initial native projection', async () => {
    const initialProjection = deferred<void>();
    const projected: ThemePreference[] = [];
    const eventApi = new FakeEventApi();
    const runtime = createThemeRuntime({
      role: 'main', root: new FakeRoot(), storage: new MemoryThemeStorage(),
      mediaQuery: new FakeMediaQuery(false), storageEvents: new FakeStorageEvents(), eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 8,
      syncNativePreference: (nextPreference) => {
        projected.push(nextPreference);
        return projected.length === 1 ? initialProjection.promise : Promise.resolve();
      },
      onError: vi.fn<(error: unknown) => void>(),
    });

    const starting = runtime.start();
    await Promise.resolve();
    expect(eventApi.listened[0]).toBe(NATIVE_MENU_EVENT);
    eventApi.deliverFor(NATIVE_MENU_EVENT, 'theme-skin:songke-zhuying');
    expect(runtime.getSnapshot().preference).toEqual(preference('songke-zhuying'));

    initialProjection.resolve();
    await starting;
    await vi.waitFor(() => expect(projected).toHaveLength(2));
    expect(projected).toEqual([
      preference('jinxiu-zhusha'),
      preference('songke-zhuying'),
    ]);
    expect(eventApi.emitted[eventApi.emitted.length - 1]?.payload).toMatchObject({
      preference: preference('songke-zhuying'),
    });
  });

  it('still registers native menu intents when the snapshot listener rejects', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const eventApi: ThemeEventApi = {
      emit: vi.fn<ThemeEventApi['emit']>(() => Promise.resolve()),
      listen: vi.fn<ThemeEventApi['listen']>((event, listener) => {
        if (event === THEME_SNAPSHOT_EVENT) return Promise.reject(new Error('snapshot unavailable'));
        listeners.set(event, listener);
        return Promise.resolve(() => listeners.delete(event));
      }),
    };
    const runtime = createThemeRuntime({
      role: 'main', root: new FakeRoot(), storage: new MemoryThemeStorage(),
      mediaQuery: new FakeMediaQuery(false), storageEvents: new FakeStorageEvents(), eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 3,
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();

    listeners.get(NATIVE_MENU_EVENT)?.({ payload: 'theme-skin:qinghua-jilan' });
    await Promise.resolve();
    expect(runtime.getSnapshot().preference).toEqual(preference('qinghua-jilan'));
  });

  it('tracks system appearance and restores the selected light skin', async () => {
    const root = new FakeRoot();
    const mediaQuery = new FakeMediaQuery(false);
    const runtime = createThemeRuntime({
      role: 'main', root, storage: new MemoryThemeStorage(), mediaQuery,
      storageEvents: new FakeStorageEvents(), eventApi: new FakeEventApi(),
      initialPreference: preference('songke-zhuying', true), revisionSeed: 1,
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();

    mediaQuery.change(true);
    expect(root.values.get('data-skin')).toBe('original');
    expect(root.values.get('data-appearance')).toBe('dark');
    mediaQuery.change(false);
    expect(root.values.get('data-skin')).toBe('songke-zhuying');
    expect(root.values.get('data-appearance')).toBe('light');
  });

  it('converges a popout through storage and ignores duplicate or stale Tauri revisions', async () => {
    const root = new FakeRoot();
    const storageEvents = new FakeStorageEvents();
    const eventApi = new FakeEventApi();
    const runtime = createThemeRuntime({
      role: 'popout', root, storage: new MemoryThemeStorage(),
      mediaQuery: new FakeMediaQuery(false), storageEvents, eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 0,
      onError: vi.fn<(error: unknown) => void>(),
    });
    await runtime.start();

    storageEvents.deliver(THEME_STORAGE_KEY, JSON.stringify(preference('qinghua-jilan')));
    expect(root.values.get('data-skin')).toBe('qinghua-jilan');

    eventApi.deliver({
      protocolVersion: 1,
      revision: 8,
      preference: preference('songke-zhuying'),
    });
    eventApi.deliver({
      protocolVersion: 1,
      revision: 8,
      preference: preference('ruyao-tianqing'),
    });
    eventApi.deliver({
      protocolVersion: 1,
      revision: 7,
      preference: preference('ruyao-tianqing'),
    });

    expect(root.values.get('data-skin')).toBe('songke-zhuying');
    expect(runtime.getSnapshot().preference).toEqual(preference('songke-zhuying'));
    expect(runtime.setPreference(preference('ruyao-tianqing'))).toBe(false);
  });

  it('cleans up matchMedia, storage, and late Tauri listener registrations', async () => {
    let resolveListen: ((unlisten: ThemeUnlisten) => void) | undefined;
    const eventApi: ThemeEventApi = {
      emit: vi.fn<ThemeEventApi['emit']>(),
      listen: vi.fn<ThemeEventApi['listen']>(() => new Promise<ThemeUnlisten>((resolve) => {
        resolveListen = resolve;
      })),
    };
    const unlisten = vi.fn<ThemeUnlisten>();
    const mediaQuery = new FakeMediaQuery(false);
    const storageEvents = new FakeStorageEvents();
    const runtime = createThemeRuntime({
      role: 'popout', root: new FakeRoot(), storage: new MemoryThemeStorage(),
      mediaQuery, storageEvents, eventApi,
      initialPreference: preference('jinxiu-zhusha'), revisionSeed: 0,
      onError: vi.fn<(error: unknown) => void>(),
    });

    const starting = runtime.start();
    runtime.stop();
    resolveListen?.(unlisten);
    await starting;

    expect(mediaQuery.remove).toHaveBeenCalledOnce();
    expect(storageEvents.remove).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
