import {
  PANE_PROTOCOL_VERSION,
  immediatePaneScheduler,
  type PaneCache,
  type PaneContentEnvelope,
  type PaneReplicatedState,
  type PaneScheduler,
  type PaneSnapshotEnvelope,
  type PaneSnapshotRequestEnvelope,
  type PaneTransport,
  type PaneReplicationOptions,
  type PaneUnlisten,
} from './paneSyncTypes';
import {
  decodePaneContentEnvelope,
  decodePaneSnapshotEnvelope,
  decodePaneSnapshotRequestEnvelope,
} from './paneSyncEnvelopeDecode';
import {
  isBinaryDocumentSnapshot,
  snapshotAcceptsEditorContent,
  snapshotSupersedesAccepted,
} from './paneSyncGuards';

export class PaneReplication {
  private readonly cache: PaneCache;
  private readonly transport: PaneTransport;
  private readonly observe: (snapshot: PaneSnapshotEnvelope) => void;
  private readonly onError: ((error: unknown) => void) | null;
  private readonly publisher: { authorityId: string; revision: number } | null;
  private readonly contentPublisher: { sourceId: string; sequence: number } | null;
  private readonly requesterId: string | null;
  private readonly scheduler: PaneScheduler | null;
  private readonly lastAcceptedContentSequenceBySource: Map<string, number> | null;
  private authoritativeSnapshot: PaneSnapshotEnvelope | null = null;
  private pendingAuthoritativeSnapshot: PaneSnapshotEnvelope | null = null;
  private authoritativeFlushScheduled = false;
  private highestAuthoritativeTransportRevision = 0;
  private acceptedSnapshot: PaneSnapshotEnvelope | null = null;
  private acceptedSnapshotSource: 'cache' | 'live' | null = null;
  private liveAuthorityId: string | null = null;
  private unlisten: PaneUnlisten | null = null;
  private started = false;
  private disposed = false;

  constructor(options: PaneReplicationOptions) {
    this.cache = options.cache;
    this.transport = options.transport;
    this.observe = options.observe;
    this.onError = options.onError ?? null;
    this.publisher = options.role === 'main'
      ? { authorityId: options.authorityId, revision: 0 }
      : null;
    this.contentPublisher = options.role === 'editor-popout'
      ? { sourceId: options.sourceId, sequence: 0 }
      : null;
    this.requesterId = options.role === 'main' ? null : options.requesterId;
    this.scheduler = options.role === 'main' ? options.scheduler ?? immediatePaneScheduler : null;
    this.lastAcceptedContentSequenceBySource = options.role === 'main'
      ? new Map()
      : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.observeCachedInput(this.cache.read());
    const unlistenPromise = this.transport.listen((input) => this.observeLiveInput(input));
    void unlistenPromise.then((unlisten) => {
      if (this.disposed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      this.requestSnapshot();
    }).catch((error: unknown) => {
      if (!this.disposed) this.reportError(error);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pendingAuthoritativeSnapshot = null;
    this.authoritativeFlushScheduled = false;
    const unlisten = this.unlisten;
    this.unlisten = null;
    unlisten?.();
  }

  publishAuthoritativeState(state: PaneReplicatedState): void {
    if (this.disposed || !this.publisher || !this.scheduler) return;

    this.publisher.revision += 1;
    const snapshot: PaneSnapshotEnvelope = {
      protocolVersion: PANE_PROTOCOL_VERSION,
      authorityId: this.publisher.authorityId,
      revision: this.publisher.revision,
      documentId: state.documentId,
      documentEpoch: state.documentEpoch,
      state,
    };
    this.authoritativeSnapshot = snapshot;
    this.enqueueAuthoritativeSnapshot(snapshot);
  }

  publishEditorContent(content: string): void {
    if (
      this.disposed
      || !this.contentPublisher
      || !this.acceptedSnapshot
      || !snapshotAcceptsEditorContent(this.acceptedSnapshot)
    ) return;

    this.contentPublisher.sequence += 1;
    this.transport.emit({
      protocolVersion: PANE_PROTOCOL_VERSION,
      authorityId: this.acceptedSnapshot.authorityId,
      sourceId: this.contentPublisher.sourceId,
      sequence: this.contentPublisher.sequence,
      documentId: this.acceptedSnapshot.documentId,
      documentEpoch: this.acceptedSnapshot.documentEpoch,
      content,
    });
  }

  requestSnapshot(): void {
    if (this.disposed || !this.requesterId) return;
    const request: PaneSnapshotRequestEnvelope = {
      protocolVersion: PANE_PROTOCOL_VERSION,
      requesterId: this.requesterId,
    };
    this.transport.emit(request);
  }

  private observeCachedInput(input: unknown): void {
    const snapshot = decodePaneSnapshotEnvelope(input);
    if (snapshot) {
      if (isBinaryDocumentSnapshot(snapshot)) {
        this.cache.remove();
        return;
      }
      this.acceptSnapshot(
        snapshot.state.authorityStatus === 'committed'
          ? {
              ...snapshot,
              state: { ...snapshot.state, authorityStatus: 'unknown' },
            }
          : snapshot,
        'cache',
      );
      return;
    }
    if (input === null || input === undefined) return;
    this.cache.remove();
  }

  private observeLiveInput(input: unknown): void {
    if (this.disposed) return;
    const snapshot = decodePaneSnapshotEnvelope(input);
    if (snapshot) {
      this.acceptSnapshot(snapshot, 'live');
      return;
    }

    const contentEnvelope = decodePaneContentEnvelope(input);
    if (contentEnvelope) {
      this.acceptContent(contentEnvelope);
      return;
    }

    if (
      decodePaneSnapshotRequestEnvelope(input)
      && this.publisher
      && this.authoritativeSnapshot
    ) {
      this.highestAuthoritativeTransportRevision = Math.max(
        this.highestAuthoritativeTransportRevision,
        this.authoritativeSnapshot.revision,
      );
      this.transport.emit(this.authoritativeSnapshot);
    }
  }

  private acceptSnapshot(snapshot: PaneSnapshotEnvelope, source: 'cache' | 'live'): void {
    if (this.publisher) return;
    if (!this.snapshotAuthorityMatches(snapshot, source)) return;
    if (this.acceptedSnapshot?.authorityId === snapshot.authorityId
      && !snapshotSupersedesAccepted(snapshot, this.acceptedSnapshot, {
        source,
        acceptedSource: this.acceptedSnapshotSource ?? 'cache',
      })) return;

    this.acceptedSnapshot = snapshot;
    this.acceptedSnapshotSource = source;
    this.observe(snapshot);
  }

  private snapshotAuthorityMatches(snapshot: PaneSnapshotEnvelope, source: 'cache' | 'live'): boolean {
    if (source !== 'live') return true;
    if (this.liveAuthorityId === null) {
      this.liveAuthorityId = snapshot.authorityId;
      return true;
    }
    return snapshot.authorityId === this.liveAuthorityId;
  }

  private acceptContent(contentEnvelope: PaneContentEnvelope): void {
    if (!this.publisher || !this.lastAcceptedContentSequenceBySource || !this.authoritativeSnapshot) return;
    if (!snapshotAcceptsEditorContent(this.authoritativeSnapshot)) return;
    if (
      contentEnvelope.authorityId !== this.authoritativeSnapshot.authorityId
      || contentEnvelope.documentId !== this.authoritativeSnapshot.documentId
      || contentEnvelope.documentEpoch !== this.authoritativeSnapshot.documentEpoch
    ) return;

    const previousSequence = this.lastAcceptedContentSequenceBySource.get(contentEnvelope.sourceId);
    if (previousSequence !== undefined && contentEnvelope.sequence <= previousSequence) return;

    this.publisher.revision += 1;
    const updatedSnapshot: PaneSnapshotEnvelope = {
      ...this.authoritativeSnapshot,
      revision: this.publisher.revision,
      state: {
        ...this.authoritativeSnapshot.state,
        content: contentEnvelope.content,
      },
    };
    this.authoritativeSnapshot = updatedSnapshot;
    this.lastAcceptedContentSequenceBySource.set(contentEnvelope.sourceId, contentEnvelope.sequence);
    this.observe(updatedSnapshot);
    this.enqueueAuthoritativeSnapshot(updatedSnapshot);
  }

  private enqueueAuthoritativeSnapshot(snapshot: PaneSnapshotEnvelope): void {
    if (!this.scheduler) return;
    this.pendingAuthoritativeSnapshot = snapshot;
    if (this.authoritativeFlushScheduled) return;
    this.authoritativeFlushScheduled = true;
    this.scheduler.schedule(() => this.flushAuthoritativeSnapshot());
  }

  private flushAuthoritativeSnapshot(): void {
    this.authoritativeFlushScheduled = false;
    if (this.disposed) {
      this.pendingAuthoritativeSnapshot = null;
      return;
    }
    let snapshot = this.pendingAuthoritativeSnapshot;
    this.pendingAuthoritativeSnapshot = null;
    if (!snapshot) return;
    if (snapshot.revision <= this.highestAuthoritativeTransportRevision && this.publisher) {
      const revision = this.highestAuthoritativeTransportRevision + 1;
      snapshot = { ...snapshot, revision };
      this.publisher.revision = revision;
      this.authoritativeSnapshot = snapshot;
    }
    if (isBinaryDocumentSnapshot(snapshot)) this.cache.remove();
    else this.cache.write(snapshot);
    this.highestAuthoritativeTransportRevision = Math.max(
      this.highestAuthoritativeTransportRevision,
      snapshot.revision,
    );
    this.transport.emit(snapshot);
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Error observers must not alter replication lifecycle.
    }
  }
}
