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
type LocaleUnlisten = () => void;

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

function reportSafely(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try { onError?.(error); } catch { /* Locale error reporting must remain isolated. */ }
}

export function createLocaleRuntime(options: CreateLocaleRuntimeOptions): LocaleRuntime {
  const state = createLocaleRuntimeState(options);
  return {
    async start(): Promise<void> {
      if (state.started || state.stopped) return;
      state.started = true;
      state.storageEvents.addEventListener('storage', state.handleStorage);
      if (state.role === 'main') {
        try { state.unlistenNative = await state.eventApi.listen(NATIVE_MENU_EVENT, state.handleNativeMenu); }
        catch (error) { reportSafely(options.onError, error); }
        state.projectNative(false);
        await state.nativeQueue;
      }
      if (state.stopped) return;
      try { state.unlistenLocale = await state.eventApi.listen(LOCALE_SNAPSHOT_EVENT, state.handleLocaleEvent); }
      catch (error) { reportSafely(options.onError, error); }
    },
    stop(): void {
      if (state.stopped) return;
      state.stopped = true;
      state.storageEvents.removeEventListener('storage', state.handleStorage);
      state.unlistenLocale?.();
      state.unlistenNative?.();
      state.subscribers.clear();
    },
    setPreference(value: unknown): boolean {
      if (state.role !== 'main') return false;
      const nextPreference = decodeLocalePreference(value);
      return nextPreference ? state.commitPreference(nextPreference) : false;
    },
    getSnapshot(): LocaleRuntimeSnapshot {
      return { preference: state.preference, effectiveLocale: state.effectiveLocale, revision: state.revision };
    },
    subscribe(listener: () => void): () => void {
      state.subscribers.add(listener);
      return () => state.subscribers.delete(listener);
    },
  };
}

interface LocaleRuntimeState {
  effectiveLocale: EffectiveLocale;
  preference: LocalePreference;
  revision: number;
  started: boolean;
  stopped: boolean;
  subscribers: Set<() => void>;
  unlistenLocale?: LocaleUnlisten;
  unlistenNative?: LocaleUnlisten;
  nativeQueue: Promise<void>;
}

// 运行时状态与事件处理器：偏好应用、快照广播、原生同步队列与三类事件。
function createLocaleRuntimeState(options: CreateLocaleRuntimeOptions): LocaleRuntimeState & {
  applyPreference: (next: LocalePreference) => void;
  commitPreference: (next: LocalePreference) => boolean;
  emitSnapshot: () => void;
  eventApi: CreateLocaleRuntimeOptions['eventApi'];
  handleLocaleEvent: (event: { payload: unknown }) => void;
  handleNativeMenu: (event: { payload: unknown }) => void;
  handleStorage: (event: { key: string | null; newValue: string | null }) => void;
  projectNative: (broadcast: boolean) => void;
  role: 'main' | 'popout';
  storageEvents: CreateLocaleRuntimeOptions['storageEvents'];
} {
  const { role, root, storage, storageEvents, eventApi, systemLanguage, onError, syncNativePreference } = options;
  const revisionSeed = options.revisionSeed ?? (role === 'main' ? Date.now() : 0);
  const state: LocaleRuntimeState = createLocaleRuntimeStateBase(options, revisionSeed);
  applyEffectiveLocale(root, state.effectiveLocale);

  const applyPreference = (nextPreference: LocalePreference): void => applyLocalePreference({
    nextPreference, root, state, systemLanguage,
  });
  const emitSnapshot = (): void => emitLocaleSnapshot({ eventApi, onError, state });
  const { commitPreference, projectNative } = createLocalePreferenceWriter({
    applyPreference, emitSnapshot, eventApi, onError, state, storage, syncNativePreference,
  });

  const handlers = createLocaleEventHandlers({
    applyPreference, commitPreference, role, state,
  });
  const { handleStorage, handleLocaleEvent, handleNativeMenu } = handlers;

  return Object.assign(state, {
    applyPreference,
    commitPreference,
    emitSnapshot,
    eventApi,
    handleLocaleEvent,
    handleNativeMenu,
    handleStorage,
    projectNative,
    role,
    storageEvents,
  });
}

// 三类事件处理器：storage 同步、主窗口快照消费与原生菜单意图。
function createLocaleEventHandlers(deps: {
  applyPreference: (next: LocalePreference) => void;
  commitPreference: (next: LocalePreference) => boolean;
  role: 'main' | 'popout';
  state: { preference: LocalePreference; revision: number };
}) {
  const { applyPreference, commitPreference, role, state } = deps;
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
    if (!snapshot || snapshot.revision <= state.revision) return;
    state.revision = snapshot.revision;
    applyPreference(snapshot.preference);
  };
  const handleNativeMenu = (event: { payload: unknown }): void => {
    if (role !== 'main') return;
    const intent = decodeNativeLocaleMenuIntent(event.payload);
    if (intent) commitPreference({ version: 1, mode: intent.mode });
  };
  return { handleLocaleEvent, handleNativeMenu, handleStorage };
}

// 偏好写入：持久化 + 应用 + 原生同步队列（广播仅在与当前模式一致时附带快照）。
function createLocalePreferenceWriter(deps: {
  applyPreference: (next: LocalePreference) => void;
  emitSnapshot: () => void;
  eventApi: CreateLocaleRuntimeOptions['eventApi'];
  onError: ((error: unknown) => void) | undefined;
  state: LocaleRuntimeState;
  storage: CreateLocaleRuntimeOptions['storage'];
  syncNativePreference: CreateLocaleRuntimeOptions['syncNativePreference'];
}) {
  const { applyPreference, emitSnapshot, onError, state, storage, syncNativePreference } = deps;
  const projectNative = (broadcast: boolean): void => {
    const capturedPreference = state.preference;
    const capturedLocale = state.effectiveLocale;
    state.nativeQueue = state.nativeQueue.then(async () => {
      try {
        await syncNativePreference?.(capturedPreference, capturedLocale);
      } catch (error) {
        reportSafely(onError, error);
      }
      if (broadcast && capturedPreference.mode === state.preference.mode) emitSnapshot();
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
  return { commitPreference, projectNative };
}

// 广播语言快照：revision 溢出回卷后自增并发布当前偏好。
function emitLocaleSnapshot(deps: {
  eventApi: CreateLocaleRuntimeOptions['eventApi'];
  onError: ((error: unknown) => void) | undefined;
  state: LocaleRuntimeState;
}): void {
  const { eventApi, onError, state } = deps;
  if (state.revision >= Number.MAX_SAFE_INTEGER) state.revision = 0;
  state.revision += 1;
  void eventApi.emit(LOCALE_SNAPSHOT_EVENT, {
    protocolVersion: LOCALE_PROTOCOL_VERSION,
    revision: state.revision,
    preference: state.preference,
  }).catch((error: unknown) => reportSafely(onError, error));
}

// 应用偏好：解析生效语言、落到根元素并通知订阅者。
function applyLocalePreference(deps: {
  nextPreference: LocalePreference;
  root: CreateLocaleRuntimeOptions['root'];
  state: LocaleRuntimeState;
  systemLanguage: string;
}): void {
  const { nextPreference, root, state, systemLanguage } = deps;
  state.preference = nextPreference;
  state.effectiveLocale = resolveEffectiveLocale(nextPreference, systemLanguage);
  applyEffectiveLocale(root, state.effectiveLocale);
  state.subscribers.forEach((listener) => listener());
}

// 状态基座：初始偏好/生效语言/revision 与空订阅集合。
function createLocaleRuntimeStateBase(
  options: CreateLocaleRuntimeOptions,
  revisionSeed: number,
): LocaleRuntimeState {
  const preference = decodeLocalePreference(options.initialPreference) ?? DEFAULT_LOCALE_PREFERENCE;
  return {
    effectiveLocale: resolveEffectiveLocale(preference, options.systemLanguage),
    preference,
    revision: Number.isSafeInteger(revisionSeed) && revisionSeed >= 0 ? revisionSeed : 0,
    started: false,
    stopped: false,
    subscribers: new Set(),
    nativeQueue: Promise.resolve(),
  };
}
