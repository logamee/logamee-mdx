import {
  applyEffectiveLocale,
  decodeLocalePreference,
  decodeLocaleSnapshotEnvelope,
  decodeSerializedLocalePreference,
  DEFAULT_LOCALE_PREFERENCE,
  LOCALE_PROTOCOL_VERSION,
  LOCALE_SNAPSHOT_EVENT,
  LOCALE_STORAGE_KEY,
  resolveEffectiveLocale,
  type EffectiveLocale,
  type LocalePreference,
  type LocaleRoot,
  type LocaleStorage,
} from './locale';
import { decodeNativeLocaleMenuIntent, NATIVE_MENU_EVENT } from './nativeMenu';

export type LocaleRuntimeRole = 'main' | 'popout';
export type LocaleUnlisten = () => void;

export interface LocaleEventApi {
  emit(event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<LocaleUnlisten>;
}

export interface LocaleStorageEventSource {
  addEventListener(type: 'storage', listener: (event: { key: string | null; newValue: string | null }) => void): void;
  removeEventListener(type: 'storage', listener: (event: { key: string | null; newValue: string | null }) => void): void;
}

interface CreateLocaleRuntimeOptions {
  readonly role: LocaleRuntimeRole;
  readonly root: LocaleRoot;
  readonly storage: LocaleStorage;
  readonly storageEvents: LocaleStorageEventSource;
  readonly eventApi: LocaleEventApi;
  readonly systemLanguage: string;
  readonly initialPreference: LocalePreference;
  readonly revisionSeed?: number;
  readonly onError: (error: unknown) => void;
  readonly syncNativePreference?: (preference: LocalePreference, effectiveLocale: EffectiveLocale) => Promise<void>;
}

export interface LocaleRuntimeSnapshot {
  readonly preference: LocalePreference;
  readonly effectiveLocale: EffectiveLocale;
  readonly revision: number;
}

export interface LocaleRuntime {
  start(): Promise<void>;
  stop(): void;
  setPreference(value: unknown): boolean;
  getSnapshot(): LocaleRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
}

function reportSafely(onError: (error: unknown) => void, error: unknown): void {
  try { onError(error); } catch { /* Locale error reporting must remain isolated. */ }
}

export function createLocaleRuntime({
  role,
  root,
  storage,
  storageEvents,
  eventApi,
  systemLanguage,
  initialPreference,
  revisionSeed = role === 'main' ? Date.now() : 0,
  onError,
  syncNativePreference,
}: CreateLocaleRuntimeOptions): LocaleRuntime {
  let preference = decodeLocalePreference(initialPreference) ?? DEFAULT_LOCALE_PREFERENCE;
  let effectiveLocale = resolveEffectiveLocale(preference, systemLanguage);
  let revision = Number.isSafeInteger(revisionSeed) && revisionSeed >= 0 ? revisionSeed : 0;
  let stopped = false;
  let started = false;
  let unlistenLocale: LocaleUnlisten | undefined;
  let unlistenNative: LocaleUnlisten | undefined;
  let nativeQueue: Promise<void> = Promise.resolve();
  const subscribers = new Set<() => void>();

  applyEffectiveLocale(root, effectiveLocale);

  const notify = (): void => subscribers.forEach((listener) => listener());
  const applyPreference = (nextPreference: LocalePreference): void => {
    preference = nextPreference;
    effectiveLocale = resolveEffectiveLocale(preference, systemLanguage);
    applyEffectiveLocale(root, effectiveLocale);
    notify();
  };
  const emitSnapshot = (): void => {
    if (revision >= Number.MAX_SAFE_INTEGER) revision = 0;
    revision += 1;
    void eventApi.emit(LOCALE_SNAPSHOT_EVENT, {
      protocolVersion: LOCALE_PROTOCOL_VERSION,
      revision,
      preference,
    }).catch((error: unknown) => reportSafely(onError, error));
  };
  const projectNative = (broadcast: boolean): void => {
    const capturedPreference = preference;
    const capturedLocale = effectiveLocale;
    nativeQueue = nativeQueue.then(async () => {
      try {
        await syncNativePreference?.(capturedPreference, capturedLocale);
      } catch (error) {
        reportSafely(onError, error);
      }
      if (broadcast && capturedPreference.mode === preference.mode) emitSnapshot();
    });
  };
  const commitPreference = (nextPreference: LocalePreference): boolean => {
    try {
      storage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(nextPreference));
    } catch (error) {
      reportSafely(onError, error);
      return false;
    }
    applyPreference(nextPreference);
    projectNative(true);
    return true;
  };
  const handleStorage = (event: { key: string | null; newValue: string | null }): void => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = decodeSerializedLocalePreference(event.newValue);
    if (role === 'popout') {
      if (next) applyPreference(next);
    } else {
      commitPreference(next ?? DEFAULT_LOCALE_PREFERENCE);
    }
  };
  const handleLocaleEvent = (event: { payload: unknown }): void => {
    if (role === 'main') return;
    const snapshot = decodeLocaleSnapshotEnvelope(event.payload);
    if (!snapshot || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    applyPreference(snapshot.preference);
  };
  const handleNativeMenu = (event: { payload: unknown }): void => {
    if (role !== 'main') return;
    const intent = decodeNativeLocaleMenuIntent(event.payload);
    if (intent) commitPreference({ version: 1, mode: intent.mode });
  };

  return {
    async start(): Promise<void> {
      if (started || stopped) return;
      started = true;
      storageEvents.addEventListener('storage', handleStorage);
      if (role === 'main') {
        try { unlistenNative = await eventApi.listen(NATIVE_MENU_EVENT, handleNativeMenu); }
        catch (error) { reportSafely(onError, error); }
        projectNative(false);
        await nativeQueue;
      }
      if (stopped) return;
      try { unlistenLocale = await eventApi.listen(LOCALE_SNAPSHOT_EVENT, handleLocaleEvent); }
      catch (error) { reportSafely(onError, error); }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      storageEvents.removeEventListener('storage', handleStorage);
      unlistenLocale?.();
      unlistenNative?.();
      subscribers.clear();
    },
    setPreference(value: unknown): boolean {
      if (role !== 'main') return false;
      const nextPreference = decodeLocalePreference(value);
      return nextPreference ? commitPreference(nextPreference) : false;
    },
    getSnapshot(): LocaleRuntimeSnapshot { return { preference, effectiveLocale, revision }; },
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}
