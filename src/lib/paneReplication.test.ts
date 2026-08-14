import { describe, expect, it, vi } from 'vitest';
import * as paneSync from './paneSync';
import { PaneReplication, type PaneCache, type PaneReplicatedState, type PaneSnapshotEnvelope, type PaneTransport, type PaneUnlisten } from './paneSync';

class FakePaneCache implements PaneCache {
  removeCalls = 0;
  readonly writes: PaneSnapshotEnvelope[] = [];

  constructor(
    private readonly input: unknown,
    private readonly lifecycle: string[],
  ) {}

  read(): unknown {
    this.lifecycle.push('cache:read');
    return this.input;
  }

  remove(): void {
    this.lifecycle.push('cache:remove');
    this.removeCalls += 1;
  }

  write(snapshot: PaneSnapshotEnvelope): void {
    this.writes.push(snapshot);
  }
}

class FakePaneTransport implements PaneTransport {
  private listener: ((input: unknown) => void) | null = null;
  emitted: unknown[] = [];

  constructor(private readonly lifecycle: string[]) {}

  listen(listener: (input: unknown) => void): Promise<PaneUnlisten> {
    this.lifecycle.push('transport:listen');
    this.listener = listener;
    const unlisten = () => {
      this.lifecycle.push('transport:unlisten');
      if (this.listener === listener) this.listener = null;
    };
    return Promise.resolve(unlisten);
  }

  emit(input: unknown): void {
    this.emitted.push(input);
  }

  deliver(input: unknown): void {
    this.listener?.(input);
  }
}

class DeferredPaneTransport implements PaneTransport {
  private listener: ((input: unknown) => void) | null = null;
  private resolveUnlisten: ((unlisten: PaneUnlisten) => void) | null = null;
  readonly lifecycle: string[] = [];
  readonly emitted: unknown[] = [];
  unlistenCalls = 0;

  constructor(private readonly responseOnEmit?: unknown) {}

  get listenerCount(): number {
    return this.listener ? 1 : 0;
  }

  listen(listener: (input: unknown) => void): Promise<PaneUnlisten> {
    this.lifecycle.push('transport:listen');
    this.listener = listener;
    return new Promise((resolve) => {
      this.resolveUnlisten = resolve;
    });
  }

  resolveListen(): void {
    const listener = this.listener;
    const resolveUnlisten = this.resolveUnlisten;
    if (!listener || !resolveUnlisten) throw new Error('Pane transport listen is not pending');
    this.resolveUnlisten = null;
    resolveUnlisten(() => {
      this.lifecycle.push('transport:unlisten');
      this.unlistenCalls += 1;
      if (this.listener === listener) this.listener = null;
    });
  }

  emit(input: unknown): void {
    this.lifecycle.push('transport:emit');
    this.emitted.push(input);
    if (this.responseOnEmit !== undefined) this.deliver(this.responseOnEmit);
  }

  deliver(input: unknown): void {
    this.listener?.(input);
  }
}

class RegistrationGatedPaneTransport implements PaneTransport {
  private pendingListener: ((input: unknown) => void) | null = null;
  private activeListener: ((input: unknown) => void) | null = null;
  private resolveUnlisten: ((unlisten: PaneUnlisten) => void) | null = null;
  readonly emitted: unknown[] = [];

  constructor(private readonly responseOnEmit?: unknown) {}

  listen(listener: (input: unknown) => void): Promise<PaneUnlisten> {
    this.pendingListener = listener;
    return new Promise((resolve) => {
      this.resolveUnlisten = resolve;
    });
  }

  resolveListen(): void {
    const listener = this.pendingListener;
    const resolveUnlisten = this.resolveUnlisten;
    if (!listener || !resolveUnlisten) throw new Error('Pane transport listen is not pending');
    this.pendingListener = null;
    this.activeListener = listener;
    this.resolveUnlisten = null;
    resolveUnlisten(() => {
      if (this.activeListener === listener) this.activeListener = null;
    });
  }

  emit(input: unknown): void {
    this.emitted.push(input);
    if (this.responseOnEmit !== undefined) this.activeListener?.(this.responseOnEmit);
  }
}

class RejectingPaneTransport implements PaneTransport {
  emit(): void {}

  listen(): Promise<PaneUnlisten> {
    return Promise.reject(new Error('listener registration failed'));
  }
}

class ManualPaneScheduler {
  private readonly tasks: Array<() => void> = [];

  get queuedTaskCount(): number {
    return this.tasks.length;
  }

  schedule(task: () => void): void {
    this.tasks.push(task);
  }

  flush(): void {
    this.tasks.shift()?.();
  }
}

class LoopbackPaneTransport implements PaneTransport {
  private readonly listeners = new Set<(input: unknown) => void>();
  readonly emitted: unknown[] = [];

  listen(listener: (input: unknown) => void): Promise<PaneUnlisten> {
    this.listeners.add(listener);
    return Promise.resolve(() => this.listeners.delete(listener));
  }

  emit(input: unknown): void {
    this.emitted.push(input);
    for (const listener of this.listeners) listener(input);
  }
}

function binarySnapshot(
  kind: 'pdf' | 'docx',
  revision = 1,
): PaneSnapshotEnvelope {
  return {
    protocolVersion: 2,
    authorityId: 'authority-main',
    revision,
    documentId: `document-${kind}`,
    documentEpoch: 4,
    state: {
      activeFileKind: kind,
      activeMimeType: kind === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      activePath: `/workspace/document.${kind}`,
      bytesBase64: kind === 'pdf' ? 'JVBERg==' : 'UEsDBA==',
      content: '',
      lastSavedContent: '',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: `document-${kind}`,
      previewRevision: 0,
      documentEpoch: 4,
    },
  };
}

describe('pane replication', () => {
  it('requires protocol v2 snapshots with a non-negative safe preview revision', () => {
    const snapshot = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'image',
        activeMimeType: 'image/png',
        activePath: '/workspace/current.png',
        content: '',
        lastSavedContent: '',
        previewRevision: 3,
        authorityStatus: 'committed',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        documentEpoch: 4,
      },
    };

    expect(paneSync.decodePaneSnapshotEnvelope(snapshot)).toEqual(snapshot);
    expect(paneSync.decodePaneSnapshotEnvelope({ ...snapshot, protocolVersion: 1 })).toBeNull();

    const missingPreviewRevision = { ...snapshot.state } as Record<string, unknown>;
    Reflect.deleteProperty(missingPreviewRevision, 'previewRevision');
    expect(paneSync.decodePaneSnapshotEnvelope({ ...snapshot, state: missingPreviewRevision })).toBeNull();
    for (const previewRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(paneSync.decodePaneSnapshotEnvelope({
        ...snapshot,
        state: { ...snapshot.state, previewRevision },
      })).toBeNull();
    }
  });

  it('pane_decoders_reject_extra_wire_fields', () => {
    const snapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/workspace/current.md',
        content: '# Current',
        lastSavedContent: '# Saved',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const content = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-popout',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited',
    };

    expect(paneSync.decodePaneSnapshotEnvelope({ ...snapshot, unexpected: true })).toBeNull();
    expect(paneSync.decodePaneSnapshotEnvelope({
      ...snapshot,
      state: { ...snapshot.state, unexpected: true },
    })).toBeNull();
    expect(paneSync.decodePaneContentEnvelope({ ...content, unexpected: true })).toBeNull();
    expect(paneSync.decodePaneSnapshotRequestEnvelope({
      protocolVersion: 2,
      requesterId: 'preview-popout',
      unexpected: true,
    })).toBeNull();
  });

  it('pane_snapshots_accept_only_known_authority_status_values', () => {
    const snapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/workspace/current.md',
        content: '# Current',
        lastSavedContent: '# Saved',
        authorityStatus: 'provisional',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };

    expect(paneSync.decodePaneSnapshotEnvelope(snapshot)).toEqual(snapshot);
    expect(paneSync.decodePaneSnapshotEnvelope({
      ...snapshot,
      state: { ...snapshot.state, authorityStatus: 'trusted' },
    })).toBeNull();
  });

  it('accepts only strict bounded PDF and DOCX replicated states', () => {
    for (const kind of ['pdf', 'docx'] as const) {
      const snapshot = binarySnapshot(kind);
      expect(paneSync.decodePaneSnapshotEnvelope(snapshot)).toEqual(snapshot);

      const invalidStates: unknown[] = [
        { ...snapshot.state, activeMimeType: 'application/octet-stream' },
        { ...snapshot.state, bytesBase64: null },
        { ...snapshot.state, bytesBase64: '' },
        { ...snapshot.state, bytesBase64: 'AB==' },
        { ...snapshot.state, bytesBase64: 'AQIDBA__' },
        { ...snapshot.state, content: 'binary content must stay empty' },
        { ...snapshot.state, lastSavedContent: 'binary snapshots are saved-equivalent' },
      ];
      const missingBytes = { ...snapshot.state } as Record<string, unknown>;
      Reflect.deleteProperty(missingBytes, 'bytesBase64');
      invalidStates.push(missingBytes);

      for (const state of invalidStates) {
        expect(paneSync.decodePaneSnapshotEnvelope({ ...snapshot, state })).toBeNull();
      }
    }
  });

  it('rejects non-null binary bytes for every non-document kind', () => {
    for (const kind of ['markdown', 'html', 'image', 'video', 'audio'] as const) {
      const snapshot: PaneSnapshotEnvelope = {
        protocolVersion: 2,
        authorityId: 'authority-main',
        revision: 1,
        documentId: `document-${kind}`,
        documentEpoch: 1,
        state: {
          activeFileKind: kind,
          activeMimeType: null,
          activePath: `/workspace/document.${kind}`,
          bytesBase64: null,
          content: '',
          lastSavedContent: '',
          authorityStatus: 'committed',
          workspaceRoot: '/workspace',
          documentId: `document-${kind}`,
          previewRevision: 0,
          documentEpoch: 1,
        },
      };

      expect(paneSync.decodePaneSnapshotEnvelope(snapshot)).toEqual(snapshot);
      expect(paneSync.decodePaneSnapshotEnvelope({
        ...snapshot,
        state: { ...snapshot.state, bytesBase64: 'AQ==' },
      })).toBeNull();
    }
  });

  it('ignores binary cache snapshots and waits for the complete live authority response', () => {
    const cached = binarySnapshot('docx', 7);
    const live = binarySnapshot('docx', 8);
    const cache = new FakePaneCache(cached, []);
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache,
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    expect(observed).toEqual([]);
    expect(cache.removeCalls).toBe(1);

    transport.deliver(live);
    expect(observed).toEqual([live]);
    expect(observed[0]?.state.bytesBase64).toBe(live.state.bytesBase64);
  });

  it('rejects stale document epochs and preview revisions even when transport revision increases', () => {
    const snapshot = (
      revision: number,
      documentEpoch: number,
      previewRevision: number,
      documentId = 'document-current',
    ): PaneSnapshotEnvelope => ({
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision,
      documentId,
      documentEpoch,
      state: {
        activeFileKind: 'image',
        activeMimeType: 'image/png',
        activePath: '/workspace/current.png',
        content: '',
        lastSavedContent: '',
        previewRevision,
        authorityStatus: 'committed',
        workspaceRoot: '/workspace',
        documentId,
        documentEpoch,
      },
    });
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, []),
      transport,
      observe: (next) => observed.push(next),
    });

    replication.start();
    const current = snapshot(5, 8, 12);
    const staleEpoch = snapshot(6, 7, 99);
    const stalePreview = snapshot(7, 8, 11);
    const nextDocument = snapshot(8, 9, 0, 'document-next');
    transport.deliver(current);
    transport.deliver(staleEpoch);
    transport.deliver(stalePreview);
    transport.deliver(nextDocument);

    expect(observed).toEqual([current, nextDocument]);
  });

  it('delivers binary bytes live while clearing the cache instead of writing the payload', () => {
    const state = binarySnapshot('pdf').state;
    const cache = new FakePaneCache(null, []);
    const transport = new LoopbackPaneTransport();
    const observed: PaneSnapshotEnvelope[] = [];
    const main = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache,
      transport,
      observe: () => undefined,
    });
    const popout = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });
    main.start();
    popout.start();

    main.publishAuthoritativeState(state);

    expect(cache.writes).toEqual([]);
    expect(cache.removeCalls).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.state).toEqual(state);
    expect(observed[0]?.state.bytesBase64).toBe('JVBERg==');
  });

  it('requests_live_snapshot_after_listener_registration_when_cache_is_empty', async () => {
    const liveSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-live',
      revision: 1,
      documentId: 'document-live',
      documentEpoch: 1,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/workspace/live.md',
        content: '# Live',
        lastSavedContent: '# Live',
        workspaceRoot: '/workspace',
        documentId: 'document-live',
        previewRevision: 0,
        documentEpoch: 1,
      },
    };
    const transport = new RegistrationGatedPaneTransport(liveSnapshot);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();

    expect(transport.emitted).toEqual([]);
    expect(observed).toEqual([]);

    transport.resolveListen();
    await Promise.resolve();

    expect(transport.emitted).toEqual([{ protocolVersion: 2, requesterId: 'preview-requester' }]);
    expect(observed).toEqual([liveSnapshot]);
  });

  it('treats_valid_cache_as_provisional_and_requests_live_snapshot_after_listener_registration', async () => {
    const cachedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-cached',
      revision: 8,
      documentId: 'document-cached',
      documentEpoch: 2,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/workspace/cached.md',
        content: '# Cached',
        lastSavedContent: '# Cached',
        workspaceRoot: '/workspace',
        documentId: 'document-cached',
        previewRevision: 0,
        documentEpoch: 2,
      },
    };
    const liveSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-live',
      revision: 1,
      documentId: 'document-live',
      documentEpoch: 3,
      state: {
        activeFileKind: 'html',
        activeMimeType: 'text/html',
        activePath: '/workspace/live.html',
        content: '<h1>Live</h1>',
        lastSavedContent: '<h1>Live</h1>',
        workspaceRoot: '/workspace',
        documentId: 'document-live',
        previewRevision: 0,
        documentEpoch: 3,
      },
    };
    const transport = new RegistrationGatedPaneTransport(liveSnapshot);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'editor-popout',
      requesterId: 'editor-requester',
      sourceId: 'editor-source',
      cache: new FakePaneCache(cachedSnapshot, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();

    expect(observed).toEqual([cachedSnapshot]);
    expect(transport.emitted).toEqual([]);

    transport.resolveListen();
    await Promise.resolve();

    expect(transport.emitted).toEqual([{ protocolVersion: 2, requesterId: 'editor-requester' }]);
    expect(observed).toEqual([cachedSnapshot, liveSnapshot]);
  });

  it('pins_the_first_live_authority_and_rejects_delayed_snapshots_from_older_authorities', async () => {
    const snapshot = (authorityId: string, revision: number, content: string): PaneSnapshotEnvelope => ({
      protocolVersion: 2,
      authorityId,
      revision,
      documentId: `document-${authorityId}`,
      documentEpoch: 1,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: `/workspace/${authorityId}.md`,
        content,
        lastSavedContent: content,
        workspaceRoot: '/workspace',
        documentId: `document-${authorityId}`,
        previewRevision: 0,
        documentEpoch: 1,
      },
    });
    const cached = snapshot('authority-old', 9, '# Cached old');
    const currentV1 = snapshot('authority-current', 1, '# Current v1');
    const delayedOld = snapshot('authority-old', 10, '# Delayed old');
    const currentV2 = snapshot('authority-current', 2, '# Current v2');
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(cached, []),
      transport,
      observe: (accepted) => observed.push(accepted),
    });

    replication.start();
    await Promise.resolve();
    transport.deliver(currentV1);
    transport.deliver(delayedOld);
    transport.deliver(currentV2);

    expect(observed).toEqual([cached, currentV1, currentV2]);
  });

  it('reports_listener_registration_failure_without_an_unhandled_rejection', async () => {
    const onError = vi.fn<(error: unknown) => void>();
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, []),
      transport: new RejectingPaneTransport(),
      observe: () => undefined,
      onError,
    });

    replication.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toEqual(new Error('listener registration failed'));
  });

  it('stale_cached_snapshot_is_provisional_and_replaced_by_live_different_authority', () => {
    const cachedSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-old',
      revision: 99,
      documentId: 'document-cached',
      documentEpoch: 3,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/cached/old.md',
        content: '# Cached state',
        lastSavedContent: '# Cached saved state',
        workspaceRoot: '/cached',
        documentId: 'document-cached',
        previewRevision: 0,
        documentEpoch: 3,
      },
    };
    const liveSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'html',
        activeMimeType: 'text/html',
        activePath: '/live/current.html',
        content: '<h1>Live state</h1>',
        lastSavedContent: '<h1>Live saved state</h1>',
        workspaceRoot: '/live',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(cachedSnapshot, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();

    expect(lifecycle).toEqual(['cache:read', 'transport:listen']);
    expect(observed).toEqual([cachedSnapshot]);

    transport.deliver(liveSnapshot);

    expect(observed).toEqual([cachedSnapshot, liveSnapshot]);
  });

  it('older_same_authority_revision_is_ignored', () => {
    const currentSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 7,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/current/document.md',
        content: '# Current state',
        lastSavedContent: '# Current saved state',
        workspaceRoot: '/current',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const olderSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 6,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'html',
        activeMimeType: 'text/html',
        activePath: '/older/document.html',
        content: '<h1>Older state</h1>',
        lastSavedContent: '<h1>Older saved state</h1>',
        workspaceRoot: '/older',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();

    expect(lifecycle).toEqual(['cache:read', 'transport:listen']);
    expect(observed).toEqual([]);

    transport.deliver(currentSnapshot);

    expect(observed).toEqual([currentSnapshot]);

    transport.deliver(olderSnapshot);

    expect(observed).toEqual([currentSnapshot]);
  });

  it('newer_same_authority_revision_applies', () => {
    const currentSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 7,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/current/document.md',
        content: '# Current state',
        lastSavedContent: '# Current saved state',
        workspaceRoot: '/current',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const newerSnapshot = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 8,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'html',
        activeMimeType: 'text/html',
        activePath: '/newer/document.html',
        content: '<h1>Newer state</h1>',
        lastSavedContent: '<h1>Newer saved state</h1>',
        workspaceRoot: '/newer',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    transport.deliver(currentSnapshot);

    expect(observed).toEqual([currentSnapshot]);

    transport.deliver(newerSnapshot);

    expect(observed).toEqual([currentSnapshot, newerSnapshot]);
  });

  it('only_main_publishes_full_authoritative_snapshots', () => {
    const state: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Authoritative state',
      lastSavedContent: '# Saved authoritative state',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const mainTransport = new FakePaneTransport([]);
    const popoutTransport = new FakePaneTransport([]);
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, []),
      transport: mainTransport,
      observe: () => undefined,
    });
    const popoutReplication = new PaneReplication({
      role: 'editor-popout',
      sourceId: 'editor-source',
      requesterId: 'editor-requester',
      cache: new FakePaneCache(null, []),
      transport: popoutTransport,
      observe: () => undefined,
    });

    mainReplication.publishAuthoritativeState(state);
    popoutReplication.publishAuthoritativeState(state);

    expect(mainTransport.emitted).toEqual([{
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state,
    }]);
    expect(popoutTransport.emitted).toEqual([]);
  });

  it('full_snapshots_carry_document_id_and_epoch', () => {
    const state: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Current document',
      lastSavedContent: '# Saved current document',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const transport = new FakePaneTransport([]);
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, []),
      transport,
      observe: () => undefined,
    });

    replication.publishAuthoritativeState(state);

    expect(transport.emitted).toEqual([{
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state,
    }]);
  });

  it('incremental_editor_content_changes_only_content', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const mainLifecycle: string[] = [];
    const editorLifecycle: string[] = [];
    const mainTransport = new FakePaneTransport(mainLifecycle);
    const editorTransport = new FakePaneTransport(editorLifecycle);
    const mainObserved: PaneSnapshotEnvelope[] = [];
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, mainLifecycle),
      transport: mainTransport,
      observe: (snapshot) => mainObserved.push(snapshot),
    });
    const editorReplication = new PaneReplication({
      role: 'editor-popout',
      sourceId: 'editor-source',
      requesterId: 'editor-requester',
      cache: new FakePaneCache(null, editorLifecycle),
      transport: editorTransport,
      observe: () => undefined,
    });

    mainReplication.start();
    editorReplication.start();
    mainReplication.publishAuthoritativeState(initialState);
    editorTransport.deliver(mainTransport.emitted[0]);

    editorReplication.publishEditorContent('# Edited content');

    expect(editorTransport.emitted).toEqual([{
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited content',
    }]);

    mainTransport.deliver(editorTransport.emitted[0]);

    expect(mainObserved[mainObserved.length - 1]?.state).toEqual({
      ...initialState,
      content: '# Edited content',
    });
  });

  it('editor popouts do not publish content for provisional or legacy unknown snapshots', () => {
    for (const authorityStatus of ['provisional', undefined] as const) {
      const transport = new FakePaneTransport([]);
      const replication = new PaneReplication({
        role: 'editor-popout',
        sourceId: 'editor-source',
        requesterId: 'editor-requester',
        cache: new FakePaneCache(null, []),
        transport,
        observe: () => undefined,
      });
      replication.start();
      transport.deliver({
        protocolVersion: 2,
        authorityId: 'authority-main',
        revision: 1,
        documentId: 'document-current',
        documentEpoch: 4,
        state: {
          activeFileKind: 'markdown',
          activeMimeType: null,
          activePath: '/workspace/document.md',
          content: '# Provisional',
          lastSavedContent: '# Provisional',
          ...(authorityStatus ? { authorityStatus } : {}),
          workspaceRoot: '/workspace',
          documentId: 'document-current',
          previewRevision: 0,
          documentEpoch: 4,
        },
      });
      transport.emitted = [];

      replication.publishEditorContent('# Unauthorized edit');

      expect(transport.emitted).toEqual([]);
    }
  });

  it('downgrades committed cache authority until a live snapshot arrives', () => {
    const cachedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 7,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: null,
        activePath: '/workspace/document.md',
        content: '# Cached content',
        lastSavedContent: '# Saved content',
        authorityStatus: 'committed',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'editor-popout',
      sourceId: 'editor-source',
      requesterId: 'editor-requester',
      cache: new FakePaneCache(cachedSnapshot, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    transport.emitted = [];
    replication.publishEditorContent('# Stale cached edit');

    expect(observed).toEqual([{
      ...cachedSnapshot,
      state: { ...cachedSnapshot.state, authorityStatus: 'unknown' },
    }]);
    expect(transport.emitted).toEqual([]);
  });

  it('main rejects incremental content while its authoritative snapshot is provisional', () => {
    const state: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: '/workspace/document.md',
      content: '# Provisional',
      lastSavedContent: '# Provisional',
      authorityStatus: 'provisional',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });
    replication.start();
    replication.publishAuthoritativeState(state);

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Unauthorized edit',
    });

    expect(observed).toEqual([]);
  });

  it('main_authoritative_baseline_ignores_cached_and_live_full_snapshots', () => {
    const canonicalState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/canonical/document.md',
      content: '# Canonical content',
      lastSavedContent: '# Saved canonical content',
      authorityStatus: 'committed',
      workspaceRoot: '/canonical',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const foreignCachedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-foreign-cache',
      revision: 99,
      documentId: 'document-foreign-cache',
      documentEpoch: 40,
      state: {
        activeFileKind: 'html',
        activeMimeType: 'text/html',
        activePath: '/foreign-cache/stale.html',
        content: '<h1>Foreign cached content</h1>',
        lastSavedContent: '<h1>Saved foreign cached content</h1>',
        workspaceRoot: '/foreign-cache',
        documentId: 'document-foreign-cache',
        previewRevision: 0,
        documentEpoch: 40,
      },
    };
    const foreignLiveSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-foreign-live',
      revision: 1,
      documentId: 'document-foreign-live',
      documentEpoch: 41,
      state: {
        activeFileKind: 'image',
        activeMimeType: 'image/png',
        activePath: '/foreign-live/image.png',
        content: 'foreign-live-image-data',
        lastSavedContent: 'saved-foreign-live-image-data',
        workspaceRoot: '/foreign-live',
        documentId: 'document-foreign-live',
        previewRevision: 0,
        documentEpoch: 41,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(foreignCachedSnapshot, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.publishAuthoritativeState(canonicalState);
    replication.start();
    transport.deliver(foreignLiveSnapshot);

    expect(observed).toEqual([]);

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited canonical content',
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.state).toEqual({
      ...canonicalState,
      content: '# Edited canonical content',
    });
  });

  it('duplicate_or_out_of_order_source_sequence_is_ignored', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.publishAuthoritativeState(initialState);
    const observationBaseline = observed.length;

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-a',
      sequence: 3,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Accepted A3',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-a',
      sequence: 3,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Duplicate ignored',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-a',
      sequence: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Older ignored',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-b',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Accepted B1',
    });

    expect(observed.slice(observationBaseline).map((snapshot) => snapshot.state.content)).toEqual([
      '# Accepted A3',
      '# Accepted B1',
    ]);
    expect(observed[observed.length - 1]?.state).toEqual({
      ...initialState,
      content: '# Accepted B1',
    });
  });

  it('stale_content_identity_is_ignored_without_poisoning_source_sequence', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.publishAuthoritativeState(initialState);
    const observationBaseline = observed.length;
    const emissionBaseline = transport.emitted.length;

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-foreign',
      sourceId: 'editor-source',
      sequence: 100,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Foreign authority content',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 101,
      documentId: 'document-foreign',
      documentEpoch: 4,
      content: '# Foreign document content',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 102,
      documentId: 'document-current',
      documentEpoch: 3,
      content: '# Stale epoch content',
    });

    expect(observed.slice(observationBaseline)).toEqual([]);
    expect(transport.emitted).toHaveLength(emissionBaseline);

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Valid current content',
    });

    expect(observed.slice(observationBaseline).map((snapshot) => snapshot.state.content)).toEqual([
      '# Valid current content',
    ]);
    expect(observed[observed.length - 1]?.state).toEqual({
      ...initialState,
      content: '# Valid current content',
    });
  });

  it('accepted_current_content_increments_revision_and_emits_full_snapshot', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.publishAuthoritativeState(initialState);
    const observationBaseline = observed.length;
    const emissionBaseline = transport.emitted.length;

    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited current content',
    });

    const expectedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        ...initialState,
        content: '# Edited current content',
      },
    };
    expect(transport.emitted.slice(emissionBaseline)).toEqual([expectedSnapshot]);
    expect(observed.slice(observationBaseline)).toEqual([expectedSnapshot]);
  });

  it('start_is_idempotent', () => {
    const cachedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 7,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Cached content',
        lastSavedContent: '# Saved cached content',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(cachedSnapshot, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.start();

    expect(lifecycle).toEqual(['cache:read', 'transport:listen']);
    expect(observed).toEqual([cachedSnapshot]);
  });

  it('dispose_removes_registered_transport_listener', async () => {
    const snapshotV1: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Version 1',
        lastSavedContent: '# Saved version 1',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const snapshotV2: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Version 2',
        lastSavedContent: '# Saved version 2',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    await Promise.resolve();
    transport.deliver(snapshotV1);
    replication.dispose();
    transport.deliver(snapshotV2);

    expect(lifecycle).toEqual(['cache:read', 'transport:listen', 'transport:unlisten']);
    expect(observed).toEqual([snapshotV1]);
  });

  it('late_async_listener_registration_after_dispose_immediately_unlistens', async () => {
    const snapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-current',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Live content',
        lastSavedContent: '# Saved live content',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const transport = new DeferredPaneTransport();
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(null, transport.lifecycle),
      transport,
      observe: (observedSnapshot) => observed.push(observedSnapshot),
    });

    replication.start();
    replication.dispose();

    expect(transport.lifecycle).toEqual(['cache:read', 'transport:listen']);

    transport.resolveListen();
    await Promise.resolve();

    expect(transport.lifecycle).toEqual(['cache:read', 'transport:listen', 'transport:unlisten']);
    expect(transport.unlistenCalls).toBe(1);
    expect(transport.listenerCount).toBe(0);

    transport.deliver(snapshot);

    expect(observed).toEqual([]);
  });

  it('dispose_before_scheduled_flush_prevents_stale_cache_write_and_transport_emit', () => {
    const scheduler = new ManualPaneScheduler();
    const cache = new FakePaneCache(null, []);
    const transport = new FakePaneTransport([]);
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-obsolete',
      scheduler,
      cache,
      transport,
      observe: () => undefined,
    });

    replication.start();
    replication.publishAuthoritativeState({
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: '/workspace/obsolete.md',
      content: '# Obsolete',
      lastSavedContent: '# Obsolete',
      workspaceRoot: '/workspace',
      documentId: 'document-obsolete',
      previewRevision: 0,
      documentEpoch: 1,
    });
    replication.dispose();
    scheduler.flush();

    expect(cache.writes).toEqual([]);
    expect(transport.emitted).toEqual([]);
  });

  it('all_live_and_cache_payloads_are_runtime_decoded', () => {
    const canonicalState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const cachedPayload: unknown = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 99,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Cached poison',
    };
    const livePayload: unknown = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Live content',
    };
    const lifecycle: string[] = [];
    const transport = new FakePaneTransport(lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(cachedPayload, lifecycle),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.publishAuthoritativeState(canonicalState);
    const observationBaseline = observed.length;
    const emissionBaseline = transport.emitted.length;
    replication.start();
    transport.deliver(livePayload);

    const expectedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        ...canonicalState,
        content: '# Live content',
      },
    };
    expect(observed.slice(observationBaseline)).toEqual([expectedSnapshot]);
    expect(transport.emitted.slice(emissionBaseline)).toEqual([expectedSnapshot]);

    const validSnapshotPayload: unknown = expectedSnapshot;
    const invalidContentPayload: unknown = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      content: 42,
    };
    const nullPayload: unknown = null;
    const arrayPayload: unknown = [];
    expect(paneSync.decodePaneSnapshotEnvelope(validSnapshotPayload)).toEqual(expectedSnapshot);
    expect(paneSync.decodePaneSnapshotEnvelope(nullPayload)).toBeNull();
    expect(paneSync.decodePaneSnapshotEnvelope(arrayPayload)).toBeNull();
    expect(paneSync.decodePaneContentEnvelope(livePayload)).toEqual(livePayload);
    expect(paneSync.decodePaneContentEnvelope(nullPayload)).toBeNull();
    expect(paneSync.decodePaneContentEnvelope(arrayPayload)).toBeNull();
    expect(paneSync.decodePaneContentEnvelope(invalidContentPayload)).toBeNull();

    const validRequestPayload: unknown = { protocolVersion: 2, requesterId: 'requester-one' };
    expect(paneSync.decodePaneSnapshotRequestEnvelope(validRequestPayload)).toEqual(validRequestPayload);
    expect(paneSync.decodePaneSnapshotRequestEnvelope(nullPayload)).toBeNull();
    expect(paneSync.decodePaneSnapshotRequestEnvelope(arrayPayload)).toBeNull();
  });

  it('pane_decoders_reject_wrong_or_missing_protocol_version', () => {
    const missingProtocolVersion = Symbol('missing-protocol-version');
    const protocolVersionField = (protocolVersion: unknown): Record<string, unknown> => (
      protocolVersion === missingProtocolVersion ? {} : { protocolVersion }
    );
    const snapshotPayload = (protocolVersion: unknown, revision = 1, content = '# Live snapshot'): unknown => ({
      ...protocolVersionField(protocolVersion),
      authorityId: 'authority-main',
      revision,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content,
        lastSavedContent: '# Saved content',
        authorityStatus: 'committed',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    });
    const contentPayload = (protocolVersion: unknown, sequence = 1, content = '# Valid edit'): unknown => ({
      ...protocolVersionField(protocolVersion),
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence,
      documentId: 'document-current',
      documentEpoch: 4,
      content,
    });
    const requestPayload = (protocolVersion: unknown): unknown => ({
      ...protocolVersionField(protocolVersion),
      requesterId: 'requester-one',
    });
    const validSnapshotPayload = snapshotPayload(2);
    const validContentPayload = contentPayload(2);
    const validRequestPayload = requestPayload(2);

    const popoutTransport = new FakePaneTransport([]);
    const popoutObserved: PaneSnapshotEnvelope[] = [];
    const popoutReplication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(snapshotPayload(missingProtocolVersion, 99, '# Cached poison'), []),
      transport: popoutTransport,
      observe: (snapshot) => popoutObserved.push(snapshot),
    });

    popoutReplication.start();
    popoutTransport.deliver(validSnapshotPayload);

    expect(popoutObserved).toEqual([validSnapshotPayload]);

    const canonicalState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Canonical content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const mainTransport = new FakePaneTransport([]);
    const mainObserved: PaneSnapshotEnvelope[] = [];
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, []),
      transport: mainTransport,
      observe: (snapshot) => mainObserved.push(snapshot),
    });

    mainReplication.start();
    mainReplication.publishAuthoritativeState(canonicalState);
    const observationBaseline = mainObserved.length;
    const emissionBaseline = mainTransport.emitted.length;
    mainTransport.deliver(contentPayload(1, 99, '# Wrong-version poison'));
    mainTransport.deliver(validContentPayload);

    const expectedSnapshot = snapshotPayload(2, 2, '# Valid edit');
    expect(mainObserved.slice(observationBaseline)).toEqual([expectedSnapshot]);
    expect(mainTransport.emitted.slice(emissionBaseline)).toEqual([expectedSnapshot]);

    expect(paneSync.decodePaneSnapshotEnvelope(validSnapshotPayload)).toEqual(validSnapshotPayload);
    expect(paneSync.decodePaneContentEnvelope(validContentPayload)).toEqual(validContentPayload);
    expect(paneSync.decodePaneSnapshotRequestEnvelope(validRequestPayload)).toEqual(validRequestPayload);
    for (const invalidProtocolVersion of [missingProtocolVersion, 1, '2']) {
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload(invalidProtocolVersion))).toBeNull();
      expect(paneSync.decodePaneContentEnvelope(contentPayload(invalidProtocolVersion))).toBeNull();
      expect(paneSync.decodePaneSnapshotRequestEnvelope(requestPayload(invalidProtocolVersion))).toBeNull();
    }
  });

  it('pane_decoders_reject_illegal_ordering_numbers_and_ids', () => {
    const missingField = Symbol('missing-field');
    const field = (name: string, value: unknown): Record<string, unknown> => (
      value === missingField ? {} : { [name]: value }
    );
    const valueOf = (overrides: Record<string, unknown>, name: string, fallback: unknown): unknown => (
      name in overrides ? overrides[name] : fallback
    );
    const snapshotPayload = (overrides: Record<string, unknown> = {}): unknown => ({
      protocolVersion: 2,
      ...field('authorityId', valueOf(overrides, 'authorityId', 'authority-main')),
      ...field('revision', valueOf(overrides, 'revision', 0)),
      ...field('documentId', valueOf(overrides, 'documentId', 'document-current')),
      ...field('documentEpoch', valueOf(overrides, 'documentEpoch', 0)),
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Snapshot content',
        lastSavedContent: '# Saved content',
        ...field('previewRevision', valueOf(overrides, 'previewRevision', 0)),
        workspaceRoot: '/workspace',
        ...field('documentId', valueOf(overrides, 'stateDocumentId', 'document-current')),
        ...field('documentEpoch', valueOf(overrides, 'stateDocumentEpoch', 0)),
      },
    });
    const contentPayload = (overrides: Record<string, unknown> = {}): unknown => ({
      protocolVersion: 2,
      ...field('authorityId', valueOf(overrides, 'authorityId', 'authority-main')),
      ...field('sourceId', valueOf(overrides, 'sourceId', 'editor-source')),
      ...field('sequence', valueOf(overrides, 'sequence', 1)),
      ...field('documentId', valueOf(overrides, 'documentId', 'document-current')),
      ...field('documentEpoch', valueOf(overrides, 'documentEpoch', 0)),
      content: '# Edited content',
    });
    const requestPayload = (overrides: Record<string, unknown> = {}): unknown => ({
      protocolVersion: 2,
      ...field('requesterId', valueOf(overrides, 'requesterId', 'requester-one')),
    });
    const longestValidId = `${'A'.repeat(120)}Az09._:-`;
    const zeroSnapshot = snapshotPayload();
    const maxSnapshot = snapshotPayload({
      authorityId: longestValidId,
      revision: Number.MAX_SAFE_INTEGER,
      documentId: longestValidId,
      documentEpoch: Number.MAX_SAFE_INTEGER,
      stateDocumentId: longestValidId,
      stateDocumentEpoch: Number.MAX_SAFE_INTEGER,
    });
    const minimumContent = contentPayload();
    const maxContent = contentPayload({
      authorityId: longestValidId,
      sourceId: longestValidId,
      sequence: Number.MAX_SAFE_INTEGER,
      documentId: longestValidId,
      documentEpoch: Number.MAX_SAFE_INTEGER,
    });
    const shortestIdRequest = requestPayload({ requesterId: 'A' });
    const boundaryRequest = requestPayload({ requesterId: longestValidId });

    expect(paneSync.decodePaneSnapshotEnvelope(zeroSnapshot)).toEqual(zeroSnapshot);
    expect(paneSync.decodePaneSnapshotEnvelope(maxSnapshot)).toEqual(maxSnapshot);
    expect(paneSync.decodePaneContentEnvelope(minimumContent)).toEqual(minimumContent);
    expect(paneSync.decodePaneContentEnvelope(maxContent)).toEqual(maxContent);
    expect(paneSync.decodePaneSnapshotRequestEnvelope(shortestIdRequest)).toEqual(shortestIdRequest);
    expect(paneSync.decodePaneSnapshotRequestEnvelope(boundaryRequest)).toEqual(boundaryRequest);

    const illegalNonNegativeIntegers: unknown[] = [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      missingField,
    ];
    for (const illegalNumber of illegalNonNegativeIntegers) {
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ revision: illegalNumber }))).toBeNull();
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ documentEpoch: illegalNumber }))).toBeNull();
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ stateDocumentEpoch: illegalNumber }))).toBeNull();
      expect(paneSync.decodePaneContentEnvelope(contentPayload({ documentEpoch: illegalNumber }))).toBeNull();
    }
    for (const illegalSequence of [...illegalNonNegativeIntegers, 0]) {
      expect(paneSync.decodePaneContentEnvelope(contentPayload({ sequence: illegalSequence }))).toBeNull();
    }

    const trailingNewlineId = 'trailing-newline\n';
    const illegalIds: unknown[] = [
      '',
      '   ',
      'A'.repeat(129),
      'bad/id',
      42,
      missingField,
      trailingNewlineId,
      'control\u0001id',
      'nul\u0000id',
      'document-文',
    ];
    for (const illegalId of illegalIds) {
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ authorityId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ documentId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ stateDocumentId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneContentEnvelope(contentPayload({ authorityId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneContentEnvelope(contentPayload({ sourceId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneContentEnvelope(contentPayload({ documentId: illegalId }))).toBeNull();
      expect(paneSync.decodePaneSnapshotRequestEnvelope(requestPayload({ requesterId: illegalId }))).toBeNull();
    }
  });

  it('snapshot_decoder_rejects_malformed_or_identity_inconsistent_state', () => {
    const missingField = Symbol('missing-field');
    const field = (name: string, value: unknown): Record<string, unknown> => (
      value === missingField ? {} : { [name]: value }
    );
    const valueOf = (overrides: Record<string, unknown>, name: string, fallback: unknown): unknown => (
      name in overrides ? overrides[name] : fallback
    );
    const statePayload = (overrides: Record<string, unknown>): unknown => ({
      ...field('activeFileKind', valueOf(overrides, 'activeFileKind', 'markdown')),
      ...field('activeMimeType', valueOf(overrides, 'activeMimeType', 'text/markdown')),
      ...field('activePath', valueOf(overrides, 'activePath', '/workspace/document.md')),
      ...field('content', valueOf(overrides, 'content', '# Snapshot content')),
      ...field('lastSavedContent', valueOf(overrides, 'lastSavedContent', '# Saved content')),
      ...field('previewRevision', valueOf(overrides, 'previewRevision', 0)),
      ...field('workspaceRoot', valueOf(overrides, 'workspaceRoot', '/workspace')),
      ...field('documentId', valueOf(overrides, 'stateDocumentId', 'document-current')),
      ...field('documentEpoch', valueOf(overrides, 'stateDocumentEpoch', 4)),
    });
    const snapshotPayload = (overrides: Record<string, unknown> = {}): unknown => ({
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: valueOf(overrides, 'revision', 1),
      documentId: valueOf(overrides, 'documentId', 'document-current'),
      documentEpoch: valueOf(overrides, 'documentEpoch', 4),
      ...field('state', valueOf(overrides, 'state', statePayload(overrides))),
    });

    for (const activeFileKind of ['markdown', 'html', 'image', 'video', 'audio']) {
      const payload = snapshotPayload({ activeFileKind });
      expect(paneSync.decodePaneSnapshotEnvelope(payload)).toEqual(payload);
    }
    for (const nullableField of ['activeMimeType', 'activePath', 'workspaceRoot']) {
      const nullPayload = snapshotPayload({ [nullableField]: null });
      const stringPayload = snapshotPayload({ [nullableField]: 'valid-value' });
      expect(paneSync.decodePaneSnapshotEnvelope(nullPayload)).toEqual(nullPayload);
      expect(paneSync.decodePaneSnapshotEnvelope(stringPayload)).toEqual(stringPayload);
    }

    for (const malformedState of [null, [], 'state', missingField]) {
      expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ state: malformedState }))).toBeNull();
    }
    const malformedFields: Array<[string, unknown[]]> = [
      ['activeFileKind', ['epub', 42, missingField]],
      ['activeMimeType', [42, [], missingField]],
      ['activePath', [42, [], missingField]],
      ['content', [null, 42, missingField]],
      ['lastSavedContent', [null, 42, missingField]],
      ['workspaceRoot', [42, [], missingField]],
      ['stateDocumentId', ['bad/id', 42, missingField]],
      ['stateDocumentEpoch', [-1, 0.5, '4', missingField]],
    ];
    for (const [fieldName, malformedValues] of malformedFields) {
      for (const malformedValue of malformedValues) {
        expect(paneSync.decodePaneSnapshotEnvelope(snapshotPayload({ [fieldName]: malformedValue }))).toBeNull();
      }
    }

    const mismatchedDocumentId = snapshotPayload({ stateDocumentId: 'document-other' });
    const mismatchedDocumentEpoch = snapshotPayload({ stateDocumentEpoch: 5 });
    expect(paneSync.decodePaneSnapshotEnvelope(mismatchedDocumentId)).toBeNull();
    expect(paneSync.decodePaneSnapshotEnvelope(mismatchedDocumentEpoch)).toBeNull();

    const cachedPoison = snapshotPayload({
      revision: 99,
      content: '# Cached poison',
      stateDocumentId: 'document-other',
    });
    const validLiveV1 = snapshotPayload({ revision: 1, content: '# Live version 1' });
    const livePoison = snapshotPayload({
      revision: 100,
      content: '# Live poison',
      stateDocumentEpoch: 5,
    });
    const validLiveV2 = snapshotPayload({ revision: 2, content: '# Live version 2' });
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache: new FakePaneCache(cachedPoison, []),
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    transport.deliver(validLiveV1);
    transport.deliver(livePoison);
    transport.deliver(validLiveV2);

    expect(observed).toEqual([validLiveV1, validLiveV2]);
  });

  it('malformed_cache_is_removed_and_requests_one_snapshot_after_listener_registration', async () => {
    const malformedCachedSnapshot: unknown = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 99,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Malformed cached content',
        lastSavedContent: '# Saved content',
        workspaceRoot: '/workspace',
        documentId: 'document-other',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    const liveSnapshot: unknown = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: {
        activeFileKind: 'markdown',
        activeMimeType: 'text/markdown',
        activePath: '/workspace/document.md',
        content: '# Live content',
        lastSavedContent: '# Saved content',
        workspaceRoot: '/workspace',
        documentId: 'document-current',
        previewRevision: 0,
        documentEpoch: 4,
      },
    };
    expect(paneSync.decodePaneSnapshotEnvelope(malformedCachedSnapshot)).toBeNull();

    const transport = new DeferredPaneTransport(liveSnapshot);
    const cache = new FakePaneCache(malformedCachedSnapshot, transport.lifecycle);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache,
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.start();

    expect(transport.lifecycle).toEqual([
      'cache:read',
      'cache:remove',
      'transport:listen',
    ]);
    expect(cache.removeCalls).toBe(1);
    expect(transport.listenerCount).toBe(1);
    expect(observed).toEqual([]);
    expect(transport.emitted).toEqual([]);

    transport.resolveListen();
    await Promise.resolve();

    expect(transport.lifecycle).toEqual([
      'cache:read',
      'cache:remove',
      'transport:listen',
      'transport:emit',
    ]);
    expect(observed).toEqual([liveSnapshot]);
    expect(transport.emitted).toEqual([{
      protocolVersion: 2,
      requesterId: 'preview-requester',
    }]);

    replication.requestSnapshot();

    expect(transport.emitted).toEqual([
      { protocolVersion: 2, requesterId: 'preview-requester' },
      { protocolVersion: 2, requesterId: 'preview-requester' },
    ]);

    for (const emptyCacheValue of [null, undefined]) {
      const emptyCache = new FakePaneCache(emptyCacheValue, []);
      const emptyCacheReplication = new PaneReplication({
        role: 'editor-popout',
        sourceId: 'editor-source',
        requesterId: 'editor-requester',
        cache: emptyCache,
        transport: new FakePaneTransport([]),
        observe: () => undefined,
      });
      emptyCacheReplication.start();
      expect(emptyCache.removeCalls).toBe(0);
    }

    const mainTransport = new FakePaneTransport([]);
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      cache: new FakePaneCache(null, []),
      transport: mainTransport,
      observe: () => undefined,
    });

    mainReplication.requestSnapshot();

    expect(mainTransport.emitted).toEqual([]);
  });

  it('manual_scheduler_coalesces_authoritative_updates_to_one_final_cached_emitted_snapshot', () => {
    const state = (content: string): PaneReplicatedState => ({
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content,
      lastSavedContent: '# Saved content',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    });
    const firstState = state('# First state');
    const secondState = state('# Second state');
    const finalState = state('# Final state');
    const scheduler = new ManualPaneScheduler();
    const cache = new FakePaneCache(null, []);
    const transport = new FakePaneTransport([]);
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      scheduler,
      cache,
      transport,
      observe: () => undefined,
    });

    replication.publishAuthoritativeState(firstState);
    expect(scheduler.queuedTaskCount).toBe(1);
    replication.publishAuthoritativeState(secondState);
    expect(scheduler.queuedTaskCount).toBe(1);
    replication.publishAuthoritativeState(finalState);
    expect(scheduler.queuedTaskCount).toBe(1);
    expect(cache.writes).toEqual([]);
    expect(transport.emitted).toEqual([]);

    scheduler.flush();

    const expectedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 3,
      documentId: 'document-current',
      documentEpoch: 4,
      state: finalState,
    };
    expect(scheduler.queuedTaskCount).toBe(0);
    expect(cache.writes).toEqual([expectedSnapshot]);
    expect(transport.emitted).toEqual([expectedSnapshot]);

    scheduler.flush();

    expect(cache.writes).toEqual([expectedSnapshot]);
    expect(transport.emitted).toEqual([expectedSnapshot]);
  });

  it('manual_scheduler_coalesces_pending_state_and_accepted_content_to_final_snapshot', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial content',
      lastSavedContent: '# Saved content',
      authorityStatus: 'committed',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const scheduler = new ManualPaneScheduler();
    const cache = new FakePaneCache(null, []);
    const transport = new FakePaneTransport([]);
    const observed: PaneSnapshotEnvelope[] = [];
    const replication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      scheduler,
      cache,
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    replication.start();
    replication.publishAuthoritativeState(initialState);
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited content 1',
    });
    transport.deliver({
      protocolVersion: 2,
      authorityId: 'authority-main',
      sourceId: 'editor-source',
      sequence: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      content: '# Edited content 2',
    });

    const revision2Snapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 2,
      documentId: 'document-current',
      documentEpoch: 4,
      state: { ...initialState, content: '# Edited content 1' },
    };
    const finalSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 3,
      documentId: 'document-current',
      documentEpoch: 4,
      state: { ...initialState, content: '# Edited content 2' },
    };
    expect(observed).toEqual([revision2Snapshot, finalSnapshot]);
    expect(scheduler.queuedTaskCount).toBe(1);
    expect(cache.writes).toEqual([]);
    expect(transport.emitted).toEqual([]);

    scheduler.flush();

    expect(scheduler.queuedTaskCount).toBe(0);
    expect(cache.writes).toEqual([finalSnapshot]);
    expect(transport.emitted).toEqual([finalSnapshot]);

    scheduler.flush();

    expect(cache.writes).toEqual([finalSnapshot]);
    expect(transport.emitted).toEqual([finalSnapshot]);
  });

  it('snapshot_request_bypasses_pending_coalescing', () => {
    const state: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Pending authoritative state',
      lastSavedContent: '# Saved content',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const request = { protocolVersion: 2, requesterId: 'preview-requester' } as const;
    const expectedSnapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state,
    };
    const scheduler = new ManualPaneScheduler();
    const mainCache = new FakePaneCache(null, []);
    const transport = new LoopbackPaneTransport();
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      scheduler,
      cache: mainCache,
      transport,
      observe: () => undefined,
    });
    const popoutObserved: PaneSnapshotEnvelope[] = [];
    const popoutReplication = new PaneReplication({
      role: 'preview-popout',
      requesterId: request.requesterId,
      cache: new FakePaneCache(null, []),
      transport,
      observe: (snapshot) => popoutObserved.push(snapshot),
    });

    mainReplication.start();
    popoutReplication.start();
    mainReplication.publishAuthoritativeState(state);

    expect(scheduler.queuedTaskCount).toBe(1);
    expect(mainCache.writes).toEqual([]);
    expect(transport.emitted).toEqual([]);

    popoutReplication.requestSnapshot();

    expect(transport.emitted).toEqual([request, expectedSnapshot]);
    expect(popoutObserved).toEqual([expectedSnapshot]);
    expect(scheduler.queuedTaskCount).toBe(1);
    expect(mainCache.writes).toEqual([]);

    const malformedRequest: unknown = { protocolVersion: 2, requesterId: 'bad/id' };
    const malformedBaseline = transport.emitted.length;
    transport.emit(malformedRequest);
    expect(transport.emitted.slice(malformedBaseline)).toEqual([malformedRequest]);

    const noStateTransport = new LoopbackPaneTransport();
    const noStateMain = new PaneReplication({
      role: 'main',
      authorityId: 'authority-no-state',
      scheduler: new ManualPaneScheduler(),
      cache: new FakePaneCache(null, []),
      transport: noStateTransport,
      observe: () => undefined,
    });
    noStateMain.start();
    noStateTransport.emit(request);
    expect(noStateTransport.emitted).toEqual([request]);

    const nonMainTransport = new LoopbackPaneTransport();
    const nonMainReplication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'non-main-requester',
      cache: new FakePaneCache(null, []),
      transport: nonMainTransport,
      observe: () => undefined,
    });
    nonMainReplication.start();
    nonMainReplication.requestSnapshot();
    expect(nonMainTransport.emitted).toEqual([{
      protocolVersion: 2,
      requesterId: 'non-main-requester',
    }]);
  });

  it('pending_flush_rebases_above_immediate_snapshot_response', () => {
    const initialState: PaneReplicatedState = {
      activeFileKind: 'markdown',
      activeMimeType: 'text/markdown',
      activePath: '/workspace/document.md',
      content: '# Initial state',
      lastSavedContent: '# Saved initial state',
      workspaceRoot: '/workspace',
      documentId: 'document-current',
      previewRevision: 0,
      documentEpoch: 4,
    };
    const nextState: PaneReplicatedState = {
      ...initialState,
      content: '# Next state',
    };
    const request = { protocolVersion: 2, requesterId: 'preview-requester' } as const;
    const revision1Snapshot: PaneSnapshotEnvelope = {
      protocolVersion: 2,
      authorityId: 'authority-main',
      revision: 1,
      documentId: 'document-current',
      documentEpoch: 4,
      state: initialState,
    };
    const revision2Snapshot: PaneSnapshotEnvelope = {
      ...revision1Snapshot,
      revision: 2,
    };
    const revision3Snapshot: PaneSnapshotEnvelope = {
      ...revision1Snapshot,
      revision: 3,
      state: nextState,
    };
    const scheduler = new ManualPaneScheduler();
    const cache = new FakePaneCache(null, []);
    const transport = new LoopbackPaneTransport();
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'authority-main',
      scheduler,
      cache,
      transport,
      observe: () => undefined,
    });
    const popoutObserved: PaneSnapshotEnvelope[] = [];
    const popoutReplication = new PaneReplication({
      role: 'preview-popout',
      requesterId: request.requesterId,
      cache: new FakePaneCache(null, []),
      transport,
      observe: (snapshot) => popoutObserved.push(snapshot),
    });

    mainReplication.start();
    popoutReplication.start();
    mainReplication.publishAuthoritativeState(initialState);
    popoutReplication.requestSnapshot();

    expect(transport.emitted).toEqual([request, revision1Snapshot]);
    expect(popoutObserved).toEqual([revision1Snapshot]);
    expect(cache.writes).toEqual([]);
    expect(scheduler.queuedTaskCount).toBe(1);

    scheduler.flush();

    expect(scheduler.queuedTaskCount).toBe(0);
    expect(cache.writes).toEqual([revision2Snapshot]);
    expect(transport.emitted).toEqual([request, revision1Snapshot, revision2Snapshot]);
    expect(popoutObserved).toEqual([revision1Snapshot, revision2Snapshot]);

    mainReplication.publishAuthoritativeState(nextState);

    expect(scheduler.queuedTaskCount).toBe(1);
    expect(transport.emitted).toEqual([request, revision1Snapshot, revision2Snapshot]);

    scheduler.flush();

    expect(scheduler.queuedTaskCount).toBe(0);
    expect(cache.writes).toEqual([revision2Snapshot, revision3Snapshot]);
    expect(transport.emitted).toEqual([
      request,
      revision1Snapshot,
      revision2Snapshot,
      revision3Snapshot,
    ]);
    expect(popoutObserved).toEqual([revision1Snapshot, revision2Snapshot, revision3Snapshot]);
  });
});
