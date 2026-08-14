import {
  applyEffectiveTheme,
  decodeSerializedThemePreference,
  decodeThemePreference,
  decodeThemeSnapshotEnvelope,
  DEFAULT_THEME_PREFERENCE,
  resolveEffectiveTheme,
  THEME_PROTOCOL_VERSION,
  THEME_SNAPSHOT_EVENT,
  THEME_STORAGE_KEY,
  type EffectiveTheme,
  type ThemePreference,
  type ThemeRoot,
  type ThemeStorage,
} from './theme';
import { decodeNativeThemeMenuIntent, NATIVE_MENU_EVENT } from './nativeMenu';

export type ThemeRuntimeRole = 'main' | 'popout';
export type ThemeUnlisten = () => void;

export interface ThemeEventApi {
  emit(event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<ThemeUnlisten>;
}

export interface ThemeMediaQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

export interface ThemeStorageEventSource {
  addEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void,
  ): void;
  removeEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void,
  ): void;
}

interface CreateThemeRuntimeOptions {
  readonly role: ThemeRuntimeRole;
  readonly root: ThemeRoot;
  readonly storage: ThemeStorage;
  readonly mediaQuery: ThemeMediaQuery;
  readonly storageEvents: ThemeStorageEventSource;
  readonly eventApi: ThemeEventApi;
  readonly initialPreference: ThemePreference;
  readonly revisionSeed?: number;
  readonly onError: (error: unknown) => void;
  readonly syncNativePreference?: (preference: ThemePreference) => Promise<void>;
}

export interface ThemeRuntimeSnapshot {
  readonly preference: ThemePreference;
  readonly effectiveTheme: EffectiveTheme;
  readonly revision: number;
}

export interface ThemeRuntime {
  start(): Promise<void>;
  stop(): void;
  setPreference(value: unknown): boolean;
  getSnapshot(): ThemeRuntimeSnapshot;
}

function reportSafely(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Reporting must not break theme application or listener cleanup.
  }
}

function preferencesEqual(left: ThemePreference, right: ThemePreference): boolean {
  return left.version === right.version
    && left.selectedSkin === right.selectedSkin
    && left.followSystem === right.followSystem;
}

export function createThemeRuntime({
  role,
  root,
  storage,
  mediaQuery,
  storageEvents,
  eventApi,
  initialPreference,
  revisionSeed = role === 'main' ? Date.now() : 0,
  onError,
  syncNativePreference,
}: CreateThemeRuntimeOptions): ThemeRuntime {
  let preference = decodeThemePreference(initialPreference) ?? DEFAULT_THEME_PREFERENCE;
  let effectiveTheme = resolveEffectiveTheme(preference, mediaQuery.matches);
  let revision = Number.isSafeInteger(revisionSeed) && revisionSeed >= 0
    ? revisionSeed
    : 0;
  let state: 'idle' | 'starting' | 'started' | 'stopped' = 'idle';
  let synchronousListenersAttached = false;
  let unlistenTheme: ThemeUnlisten | undefined;
  let unlistenNativeMenu: ThemeUnlisten | undefined;
  let nativeProjectionQueue: Promise<void> = Promise.resolve();
  let startupProjectionReady = role !== 'main' || !syncNativePreference;
  const pendingStartupCommits: ThemePreference[] = [];

  const isStopped = (): boolean => state === 'stopped';

  applyEffectiveTheme(root, effectiveTheme);

  const applyPreference = (nextPreference: ThemePreference): void => {
    preference = nextPreference;
    effectiveTheme = resolveEffectiveTheme(preference, mediaQuery.matches);
    applyEffectiveTheme(root, effectiveTheme);
  };

  const emitSnapshot = (snapshotPreference: ThemePreference): void => {
    if (revision >= Number.MAX_SAFE_INTEGER) revision = 0;
    revision += 1;
    const snapshot = {
      protocolVersion: THEME_PROTOCOL_VERSION,
      revision,
      preference: snapshotPreference,
    } as const;
    void eventApi.emit(THEME_SNAPSHOT_EVENT, snapshot).catch((error: unknown) => {
      reportSafely(onError, error);
    });
  };

  const enqueueNativeProjection = (
    nextPreference: ThemePreference,
    broadcast: boolean,
  ): Promise<void> => {
    const capturedPreference = nextPreference;
    nativeProjectionQueue = nativeProjectionQueue.then(async () => {
      if (syncNativePreference) {
        try {
          await syncNativePreference(capturedPreference);
        } catch (error) {
          reportSafely(onError, error);
        }
      }
      if (broadcast && preferencesEqual(capturedPreference, preference)) {
        emitSnapshot(capturedPreference);
      }
    });
    return nativeProjectionQueue;
  };

  const persistPreference = (nextPreference: ThemePreference): boolean => {
    try {
      storage.setItem(THEME_STORAGE_KEY, JSON.stringify(nextPreference));
      return true;
    } catch (error) {
      reportSafely(onError, error);
      return false;
    }
  };

  const commitPreference = (nextPreference: ThemePreference): boolean => {
    if (!persistPreference(nextPreference)) return false;
    applyPreference(nextPreference);
    if (state === 'starting' && !startupProjectionReady) {
      pendingStartupCommits.push(nextPreference);
    } else {
      void enqueueNativeProjection(nextPreference, true);
    }
    return true;
  };

  const handleMediaChange = (event: { matches: boolean }): void => {
    effectiveTheme = resolveEffectiveTheme(preference, event.matches);
    applyEffectiveTheme(root, effectiveTheme);
  };

  const handleStorage = (event: { key: string | null; newValue: string | null }): void => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const decoded = decodeSerializedThemePreference(event.newValue);
    if (role === 'popout') {
      if (decoded) applyPreference(decoded);
      return;
    }

    const nextPreference = decoded ?? DEFAULT_THEME_PREFERENCE;
    commitPreference(nextPreference);
  };

  const handleThemeEvent = (event: { payload: unknown }): void => {
    if (role === 'main') return;
    const snapshot = decodeThemeSnapshotEnvelope(event.payload);
    if (!snapshot || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    applyPreference(snapshot.preference);
  };

  const handleNativeMenu = (event: { payload: unknown }): void => {
    if (role !== 'main') return;
    const intent = decodeNativeThemeMenuIntent(event.payload);
    if (!intent) return;
    const nextPreference = intent.type === 'select-theme-skin'
      ? { ...preference, selectedSkin: intent.selectedSkin }
      : { ...preference, followSystem: !preference.followSystem };
    commitPreference(nextPreference);
  };

  const stop = (): void => {
    if (state === 'stopped') return;
    state = 'stopped';
    if (synchronousListenersAttached) {
      mediaQuery.removeEventListener('change', handleMediaChange);
      storageEvents.removeEventListener('storage', handleStorage);
      synchronousListenersAttached = false;
    }
    unlistenTheme?.();
    unlistenTheme = undefined;
    unlistenNativeMenu?.();
    unlistenNativeMenu = undefined;
  };

  const registerThemeListener = async (): Promise<void> => {
    try {
      const registeredUnlisten = await eventApi.listen(THEME_SNAPSHOT_EVENT, handleThemeEvent);
      if (isStopped()) registeredUnlisten();
      else unlistenTheme = registeredUnlisten;
    } catch (error) {
      if (!isStopped()) reportSafely(onError, error);
    }
  };

  const registerNativeMenuListener = async (): Promise<void> => {
    try {
      const registeredUnlisten = await eventApi.listen(NATIVE_MENU_EVENT, handleNativeMenu);
      if (isStopped()) registeredUnlisten();
      else unlistenNativeMenu = registeredUnlisten;
    } catch (error) {
      if (!isStopped()) reportSafely(onError, error);
    }
  };

  return {
    async start(): Promise<void> {
      if (state !== 'idle') return;
      state = 'starting';
      const startupPreference = preference;
      mediaQuery.addEventListener('change', handleMediaChange);
      storageEvents.addEventListener('storage', handleStorage);
      synchronousListenersAttached = true;

      if (role === 'main') await registerNativeMenuListener();
      if (isStopped()) return;
      if (role === 'main' && syncNativePreference) {
        const startupProjection = enqueueNativeProjection(startupPreference, false);
        startupProjectionReady = true;
        for (const pendingPreference of pendingStartupCommits.splice(0)) {
          void enqueueNativeProjection(pendingPreference, true);
        }
        await startupProjection;
      }
      if (isStopped()) return;
      await registerThemeListener();
      if (!isStopped()) state = 'started';
    },
    stop,
    setPreference(value: unknown): boolean {
      if (role !== 'main') return false;
      const nextPreference = decodeThemePreference(value);
      return nextPreference ? commitPreference(nextPreference) : false;
    },
    getSnapshot(): ThemeRuntimeSnapshot {
      return { preference, effectiveTheme, revision };
    },
  };
}
