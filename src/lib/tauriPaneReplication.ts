import { emit, listen } from '@tauri-apps/api/event';
import {
  decodePaneContentEnvelope,
  decodePaneSnapshotEnvelope,
  decodePaneSnapshotRequestEnvelope,
  PANE_CONTENT_CHANGE_EVENT,
  PANE_STATE_EVENT,
  PANE_STATE_REQUEST_EVENT,
  PaneReplication,
  type PaneCache,
  type PaneScheduler,
  type PaneSnapshotEnvelope,
  type PaneTransport,
  type PaneUnlisten,
  type ReplicaRole,
} from './paneSync';

const PANE_EVENT_NAMES = [
  PANE_STATE_EVENT,
  PANE_CONTENT_CHANGE_EVENT,
  PANE_STATE_REQUEST_EVENT,
] as const;
const PANE_PUBLICATION_FALLBACK_MS = 100;

const batchedPaneScheduler: PaneScheduler = {
  schedule: (task) => {
    let completed = false;
    let frameId: number | null = null;
    let fallbackTimerId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const runOnce = () => {
      if (completed) return;
      completed = true;
      if (frameId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(frameId);
      }
      if (fallbackTimerId !== null) globalThis.clearTimeout(fallbackTimerId);
      task();
    };

    fallbackTimerId = globalThis.setTimeout(runOnce, PANE_PUBLICATION_FALLBACK_MS);
    if (typeof globalThis.requestAnimationFrame === 'function') {
      frameId = globalThis.requestAnimationFrame(runOnce);
    }
  },
};

let fallbackIdSequence = 0;

export interface PaneEventApi {
  emit(event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<PaneUnlisten>;
}

export interface PaneStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface TauriPaneRuntimeOptions {
  eventApi: PaneEventApi;
  storage: PaneStorage;
  onError: (error: unknown) => void;
}

interface CreateTauriPaneReplicationOptions {
  role: ReplicaRole;
  observe: (snapshot: PaneSnapshotEnvelope) => void;
  onError: (error: unknown) => void;
  scheduler?: PaneScheduler;
}

interface TauriPaneReplicationDependencies {
  eventApi?: PaneEventApi;
  storage?: PaneStorage;
  createId?: (prefix: string) => string;
}

const tauriPaneEventApi: PaneEventApi = {
  emit: (event, payload) => emit(event, payload),
  listen: (event, listener) => listen<unknown>(event, (tauriEvent) => {
    listener({ payload: tauriEvent.payload });
  }),
};

function reportSafely(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Error reporting must not break transport or cache cleanup.
  }
}

class TauriPaneTransport implements PaneTransport {
  constructor(
    private readonly eventApi: PaneEventApi,
    private readonly onError: (error: unknown) => void,
  ) {}

  async listen(listener: (input: unknown) => void): Promise<PaneUnlisten> {
    const registrations = await Promise.allSettled(PANE_EVENT_NAMES.map(async (eventName) => ({
      eventName,
      unlisten: await this.eventApi.listen(eventName, (event) => listener(event.payload)),
    })));
    const unlisteners = registrations.flatMap((registration) => (
      registration.status === 'fulfilled' ? [registration.value.unlisten] : []
    ));
    const failure = registrations.find((registration) => registration.status === 'rejected');
    if (failure?.status === 'rejected') {
      for (const unlisten of unlisteners) unlisten();
      throw failure.reason;
    }

    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }

  emit(input: unknown): void {
    const eventName = decodePaneSnapshotEnvelope(input)
      ? PANE_STATE_EVENT
      : decodePaneContentEnvelope(input)
        ? PANE_CONTENT_CHANGE_EVENT
        : decodePaneSnapshotRequestEnvelope(input)
          ? PANE_STATE_REQUEST_EVENT
          : null;
    if (!eventName) {
      reportSafely(this.onError, new Error('Pane replication tried to emit an invalid protocol envelope'));
      return;
    }

    void this.eventApi.emit(eventName, input).catch((error: unknown) => {
      reportSafely(this.onError, error);
    });
  }
}

class LocalStoragePaneCache implements PaneCache {
  constructor(
    private readonly storage: PaneStorage,
    private readonly onError: (error: unknown) => void,
  ) {}

  read(): unknown {
    let serialized: string | null;
    try {
      serialized = this.storage.getItem(PANE_STATE_EVENT);
    } catch (error) {
      reportSafely(this.onError, error);
      return null;
    }
    if (serialized === null) return null;

    try {
      const parsed = JSON.parse(serialized) as unknown;
      const snapshot = decodePaneSnapshotEnvelope(parsed);
      if (snapshot && (snapshot.state.activeFileKind === 'pdf' || snapshot.state.activeFileKind === 'docx')) {
        this.remove();
        return null;
      }
      return parsed;
    } catch {
      this.remove();
      return null;
    }
  }

  remove(): void {
    try {
      this.storage.removeItem(PANE_STATE_EVENT);
    } catch (error) {
      reportSafely(this.onError, error);
    }
  }

  write(snapshot: PaneSnapshotEnvelope): void {
    if (snapshot.state.activeFileKind === 'pdf' || snapshot.state.activeFileKind === 'docx') {
      this.remove();
      return;
    }
    try {
      this.storage.setItem(PANE_STATE_EVENT, JSON.stringify(snapshot));
    } catch (error) {
      reportSafely(this.onError, error);
    }
  }
}

export function createPaneProtocolId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${(++fallbackIdSequence).toString(36)}`;
  return `${prefix}-${randomId}`;
}

export function createTauriPaneRuntime(options: TauriPaneRuntimeOptions): {
  cache: PaneCache;
  transport: PaneTransport;
} {
  return {
    cache: new LocalStoragePaneCache(options.storage, options.onError),
    transport: new TauriPaneTransport(options.eventApi, options.onError),
  };
}

export function createTauriPaneReplication(
  options: CreateTauriPaneReplicationOptions,
  dependencies: TauriPaneReplicationDependencies = {},
): PaneReplication {
  const createId = dependencies.createId ?? createPaneProtocolId;
  const runtime = createTauriPaneRuntime({
    eventApi: dependencies.eventApi ?? tauriPaneEventApi,
    storage: dependencies.storage ?? globalThis.localStorage,
    onError: options.onError,
  });
  const common = {
    cache: runtime.cache,
    transport: runtime.transport,
    observe: options.observe,
    onError: options.onError,
  };

  if (options.role === 'main') {
    return new PaneReplication({
      ...common,
      role: 'main',
      authorityId: createId('pane-authority'),
      scheduler: options.scheduler ?? batchedPaneScheduler,
    });
  }
  if (options.role === 'editor-popout') {
    return new PaneReplication({
      ...common,
      role: 'editor-popout',
      requesterId: createId('pane-requester'),
      sourceId: createId('pane-editor-source'),
    });
  }
  return new PaneReplication({
    ...common,
    role: 'preview-popout',
    requesterId: createId('pane-requester'),
  });
}
