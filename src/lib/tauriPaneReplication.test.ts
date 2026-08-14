import { describe, expect, it, vi } from 'vitest';
import {
  decodePaneContentEnvelope,
  PANE_CONTENT_CHANGE_EVENT,
  PANE_STATE_EVENT,
  PANE_STATE_REQUEST_EVENT,
  type PaneContentEnvelope,
  type PaneSnapshotEnvelope,
  type PaneSnapshotRequestEnvelope,
  type PaneUnlisten,
} from './paneSync';
import {
  createTauriPaneReplication,
  createTauriPaneRuntime,
  type PaneEventApi,
  type PaneStorage,
} from './tauriPaneReplication';

class MemoryPaneStorage implements PaneStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.removed.push(key);
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakePaneEventApi implements PaneEventApi {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly listened: string[] = [];
  readonly unlistened: string[] = [];
  private readonly listeners = new Map<string, (event: { payload: unknown }) => void>();

  emit(event: string, payload: unknown): Promise<void> {
    this.emitted.push({ event, payload });
    return Promise.resolve();
  }

  listen(event: string, listener: (event: { payload: unknown }) => void): Promise<PaneUnlisten> {
    this.listened.push(event);
    this.listeners.set(event, listener);
    return Promise.resolve(() => {
      this.unlistened.push(event);
      this.listeners.delete(event);
    });
  }

  deliver(event: string, payload: unknown): void {
    this.listeners.get(event)?.({ payload });
  }
}

const snapshot: PaneSnapshotEnvelope = {
  protocolVersion: 2,
  authorityId: 'authority-main',
  revision: 2,
  documentId: 'document-current',
  documentEpoch: 3,
  state: {
    activeFileKind: 'markdown',
    activeMimeType: null,
    activePath: '/workspace/current.md',
    content: '# Current',
    lastSavedContent: '# Current',
    authorityStatus: 'committed',
    workspaceRoot: '/workspace',
    documentId: 'document-current',
    previewRevision: 0,
    documentEpoch: 3,
  },
};

const content: PaneContentEnvelope = {
  protocolVersion: 2,
  authorityId: 'authority-main',
  sourceId: 'editor-source',
  sequence: 1,
  documentId: 'document-current',
  documentEpoch: 3,
  content: '# Edited',
};

const request: PaneSnapshotRequestEnvelope = {
  protocolVersion: 2,
  requesterId: 'preview-requester',
};

const binarySnapshot: PaneSnapshotEnvelope = {
  protocolVersion: 2,
  authorityId: 'authority-main',
  revision: 3,
  documentId: 'document-pdf',
  documentEpoch: 5,
  state: {
    activeFileKind: 'pdf',
    activeMimeType: 'application/pdf',
    activePath: '/workspace/document.pdf',
    bytesBase64: 'JVBERg==',
    content: '',
    lastSavedContent: '',
    authorityStatus: 'committed',
    workspaceRoot: '/workspace',
    documentId: 'document-pdf',
    previewRevision: 0,
    documentEpoch: 5,
  },
};

function installAnimationFrameHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 0;
  const cancel = vi.fn<(handle: number) => void>((handle) => {
    callbacks.delete(handle);
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
    const handle = ++nextHandle;
    callbacks.set(handle, callback);
    return handle;
  }));
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return { callbacks, cancel };
}

function createMainReplication(eventApi: PaneEventApi, storage: PaneStorage) {
  return createTauriPaneReplication({
    role: 'main',
    observe: () => undefined,
    onError: () => undefined,
  }, {
    eventApi,
    storage,
    createId: () => 'authority-main',
  });
}

describe('Tauri pane replication runtime', () => {
  it('publishes_the_latest_main_window_snapshot_on_the_next_animation_frame', () => {
    vi.useFakeTimers();
    const frame = installAnimationFrameHarness();
    try {
      const eventApi = new FakePaneEventApi();
      const storage = new MemoryPaneStorage();
      const replication = createMainReplication(eventApi, storage);
      const state = (nextContent: string): PaneSnapshotEnvelope['state'] => ({
        ...snapshot.state,
        content: nextContent,
      });

      replication.publishAuthoritativeState(state('# First'));
      replication.publishAuthoritativeState(state('# Second'));
      replication.publishAuthoritativeState(state('# Final'));

      expect(storage.values.has(PANE_STATE_EVENT)).toBe(false);
      expect(eventApi.emitted).toEqual([]);

      frame.callbacks.get(1)?.(16);

      const serialized = storage.values.get(PANE_STATE_EVENT);
      expect(serialized).toBeDefined();
      expect(JSON.parse(serialized!)).toMatchObject({
        revision: 3,
        state: { content: '# Final' },
      });
      expect(eventApi.emitted).toHaveLength(1);
      expect(eventApi.emitted[0]).toMatchObject({
        event: PANE_STATE_EVENT,
        payload: {
          revision: 3,
          state: { content: '# Final' },
        },
      });
      expect(frame.cancel).toHaveBeenCalledWith(1);
      expect(vi.getTimerCount()).toBe(0);

      vi.runAllTimers();
      expect(eventApi.emitted).toHaveLength(1);

      replication.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('falls_back_to_a_bounded_timer_when_animation_frames_are_suspended', () => {
    vi.useFakeTimers();
    const frame = installAnimationFrameHarness();
    try {
      const eventApi = new FakePaneEventApi();
      const replication = createMainReplication(eventApi, new MemoryPaneStorage());

      replication.publishAuthoritativeState(snapshot.state);
      expect(eventApi.emitted).toEqual([]);

      vi.advanceTimersByTime(99);
      expect(eventApi.emitted).toEqual([]);
      vi.advanceTimersByTime(1);

      expect(eventApi.emitted).toHaveLength(1);
      expect(frame.cancel).toHaveBeenCalledWith(1);
      expect(frame.callbacks.has(1)).toBe(false);

      replication.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('cancels_the_timer_and_frame_without_double_publishing_when_either_one_wins', () => {
    vi.useFakeTimers();
    const frame = installAnimationFrameHarness();
    try {
      const eventApi = new FakePaneEventApi();
      const replication = createMainReplication(eventApi, new MemoryPaneStorage());

      replication.publishAuthoritativeState(snapshot.state);
      const firstFrame = frame.callbacks.get(1);
      firstFrame?.(16);
      vi.runAllTimers();
      firstFrame?.(32);
      expect(eventApi.emitted).toHaveLength(1);

      replication.publishAuthoritativeState({ ...snapshot.state, content: '# Timer wins' });
      const secondFrame = frame.callbacks.get(2);
      vi.runAllTimers();
      secondFrame?.(48);
      expect(eventApi.emitted).toHaveLength(2);

      replication.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('does_not_publish_a_scheduled_snapshot_after_disposal', () => {
    vi.useFakeTimers();
    const frame = installAnimationFrameHarness();
    try {
      const eventApi = new FakePaneEventApi();
      const replication = createMainReplication(eventApi, new MemoryPaneStorage());

      replication.publishAuthoritativeState(snapshot.state);
      const frameCallback = frame.callbacks.get(1);
      replication.dispose();
      frameCallback?.(16);
      vi.runAllTimers();

      expect(eventApi.emitted).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('maps_the_three_protocol_envelopes_to_their_existing_tauri_events', async () => {
    const eventApi = new FakePaneEventApi();
    const runtime = createTauriPaneRuntime({
      eventApi,
      storage: new MemoryPaneStorage(),
      onError: () => undefined,
    });
    const received: unknown[] = [];

    const unlisten = await runtime.transport.listen((payload) => received.push(payload));

    expect(eventApi.listened).toEqual([
      PANE_STATE_EVENT,
      PANE_CONTENT_CHANGE_EVENT,
      PANE_STATE_REQUEST_EVENT,
    ]);

    eventApi.deliver(PANE_STATE_EVENT, snapshot);
    eventApi.deliver(PANE_CONTENT_CHANGE_EVENT, content);
    eventApi.deliver(PANE_STATE_REQUEST_EVENT, request);
    expect(received).toEqual([snapshot, content, request]);

    runtime.transport.emit(snapshot);
    runtime.transport.emit(content);
    runtime.transport.emit(request);
    await Promise.resolve();

    expect(eventApi.emitted).toEqual([
      { event: PANE_STATE_EVENT, payload: snapshot },
      { event: PANE_CONTENT_CHANGE_EVENT, payload: content },
      { event: PANE_STATE_REQUEST_EVENT, payload: request },
    ]);

    eventApi.deliver(PANE_STATE_EVENT, binarySnapshot);
    runtime.transport.emit(binarySnapshot);
    await Promise.resolve();
    expect(received[received.length - 1]).toEqual(binarySnapshot);
    expect(eventApi.emitted[eventApi.emitted.length - 1]).toEqual({
      event: PANE_STATE_EVENT,
      payload: binarySnapshot,
    });

    unlisten();
    expect(eventApi.unlistened).toEqual([
      PANE_STATE_EVENT,
      PANE_CONTENT_CHANGE_EVENT,
      PANE_STATE_REQUEST_EVENT,
    ]);
  });

  it('cleans_up_successful_listener_registrations_when_one_event_registration_fails', async () => {
    const unlistenState = vi.fn<PaneUnlisten>();
    const unlistenRequest = vi.fn<PaneUnlisten>();
    const eventApi: PaneEventApi = {
      emit: vi.fn<PaneEventApi['emit']>(),
      listen: vi.fn<PaneEventApi['listen']>(async (event) => {
        if (event === PANE_CONTENT_CHANGE_EVENT) throw new Error('content listener failed');
        return event === PANE_STATE_EVENT ? unlistenState : unlistenRequest;
      }),
    };
    const runtime = createTauriPaneRuntime({
      eventApi,
      storage: new MemoryPaneStorage(),
      onError: () => undefined,
    });

    await expect(runtime.transport.listen(() => undefined)).rejects.toThrow('content listener failed');

    expect(unlistenState).toHaveBeenCalledOnce();
    expect(unlistenRequest).toHaveBeenCalledOnce();
  });

  it('decodes_local_storage_json_and_removes_malformed_cache_entries', () => {
    const storage = new MemoryPaneStorage();
    const runtime = createTauriPaneRuntime({
      eventApi: new FakePaneEventApi(),
      storage,
      onError: () => undefined,
    });

    storage.values.set(PANE_STATE_EVENT, JSON.stringify(snapshot));
    expect(runtime.cache.read()).toEqual(snapshot);

    storage.values.set(PANE_STATE_EVENT, '{broken json');
    expect(runtime.cache.read()).toBeNull();
    expect(storage.removed).toEqual([PANE_STATE_EVENT]);

    runtime.cache.write(snapshot);
    expect(storage.values.get(PANE_STATE_EVENT)).toBe(JSON.stringify(snapshot));
    runtime.cache.remove();
    expect(storage.values.has(PANE_STATE_EVENT)).toBe(false);
  });

  it('clears binary snapshots instead of reading or serializing their payloads', () => {
    const storage = new MemoryPaneStorage();
    const onError = vi.fn<(error: unknown) => void>();
    const runtime = createTauriPaneRuntime({
      eventApi: new FakePaneEventApi(),
      storage,
      onError,
    });

    storage.values.set(PANE_STATE_EVENT, JSON.stringify(binarySnapshot));
    expect(runtime.cache.read()).toBeNull();
    expect(storage.values.has(PANE_STATE_EVENT)).toBe(false);

    storage.values.set(PANE_STATE_EVENT, JSON.stringify(snapshot));
    runtime.cache.write(binarySnapshot);
    expect(storage.values.has(PANE_STATE_EVENT)).toBe(false);
    expect(storage.removed).toEqual([PANE_STATE_EVENT, PANE_STATE_EVENT]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports_async_emit_failures_through_the_shared_error_callback', async () => {
    const failure = new Error('emit failed');
    const onError = vi.fn<(error: unknown) => void>();
    const eventApi: PaneEventApi = {
      emit: vi.fn<PaneEventApi['emit']>().mockRejectedValue(failure),
      listen: vi.fn<PaneEventApi['listen']>(),
    };
    const runtime = createTauriPaneRuntime({
      eventApi,
      storage: new MemoryPaneStorage(),
      onError,
    });

    runtime.transport.emit(snapshot);
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('creates_a_unique_editor_source_id_for_each_popout_replication_instance', async () => {
    let nextId = 0;
    const createId = (prefix: string) => `${prefix}-${++nextId}`;
    const createEditor = (eventApi: FakePaneEventApi, storage: MemoryPaneStorage) => {
      storage.values.set(PANE_STATE_EVENT, JSON.stringify(snapshot));
      return createTauriPaneReplication({
        role: 'editor-popout',
        observe: () => undefined,
        onError: () => undefined,
      }, { eventApi, storage, createId });
    };
    const firstEvents = new FakePaneEventApi();
    const secondEvents = new FakePaneEventApi();
    const first = createEditor(firstEvents, new MemoryPaneStorage());
    const second = createEditor(secondEvents, new MemoryPaneStorage());

    first.start();
    second.start();
    firstEvents.deliver(PANE_STATE_EVENT, snapshot);
    secondEvents.deliver(PANE_STATE_EVENT, snapshot);
    first.publishEditorContent('# First editor');
    second.publishEditorContent('# Second editor');
    await Promise.resolve();

    const firstContent = firstEvents.emitted.find(({ event }) => event === PANE_CONTENT_CHANGE_EVENT);
    const secondContent = secondEvents.emitted.find(({ event }) => event === PANE_CONTENT_CHANGE_EVENT);
    const firstEnvelope = decodePaneContentEnvelope(firstContent?.payload);
    const secondEnvelope = decodePaneContentEnvelope(secondContent?.payload);
    expect(firstEnvelope?.sourceId).toBe('pane-editor-source-2');
    expect(secondEnvelope?.sourceId).toBe('pane-editor-source-4');
    expect(firstEnvelope?.sourceId).not.toBe(secondEnvelope?.sourceId);

    first.dispose();
    second.dispose();
  });
});
