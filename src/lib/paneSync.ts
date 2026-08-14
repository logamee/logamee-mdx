import type { WorkspaceFileKind } from '../types';
import type { DocumentAuthorityStatus } from './documentSession';

export const PANE_STATE_EVENT = 'mmd-pane-state';
export const PANE_STATE_REQUEST_EVENT = 'mmd-pane-state-request';
export const PANE_CONTENT_CHANGE_EVENT = 'mmd-pane-content-change';
export const PANE_PROTOCOL_VERSION = 2;
export const PANE_BINARY_SOURCE_LIMITS = Object.freeze({
  pdf: 64 * 1024 * 1024,
  docx: 32 * 1024 * 1024,
});

export interface PaneStatePayload {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  bytesBase64?: string | null;
  content: string;
  lastSavedContent: string;
  previewRevision: number;
  authorityStatus?: DocumentAuthorityStatus;
  workspaceRoot: string | null;
}

export interface PaneContentChangePayload {
  content: string;
}

export interface PaneDocumentIdentity {
  documentId: string;
  documentEpoch: number;
}

export type PaneReplicatedState = PaneStatePayload & PaneDocumentIdentity;

export interface PaneSnapshotEnvelope extends PaneDocumentIdentity {
  protocolVersion: 2;
  authorityId: string;
  revision: number;
  state: PaneReplicatedState;
}

export interface PaneContentEnvelope extends PaneDocumentIdentity {
  protocolVersion: 2;
  authorityId: string;
  sourceId: string;
  sequence: number;
  content: string;
}

export interface PaneSnapshotRequestEnvelope {
  protocolVersion: 2;
  requesterId: string;
}

export type ReplicaRole = 'main' | 'editor-popout' | 'preview-popout';
export type PaneUnlisten = () => void;

export interface PaneTransport {
  listen(listener: (input: unknown) => void): Promise<PaneUnlisten>;
  emit(input: unknown): void;
}

export interface PaneCache {
  read(): unknown;
  remove(): void;
  write(snapshot: PaneSnapshotEnvelope): void;
}

export interface PaneScheduler {
  schedule(task: () => void): void;
}

const immediatePaneScheduler: PaneScheduler = {
  schedule: (task) => task(),
};

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasExactEnumerableKeys(input: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const enumerableKeys = Reflect.ownKeys(input).filter((key) => (
    Object.prototype.propertyIsEnumerable.call(input, key)
  ));
  return enumerableKeys.length === expectedKeys.length
    && enumerableKeys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

function isNullableString(input: unknown): input is string | null {
  return typeof input === 'string' || input === null;
}

function isWorkspaceFileKind(input: unknown): input is WorkspaceFileKind {
  return input === 'markdown'
    || input === 'html'
    || input === 'excalidraw'
    || input === 'image'
    || input === 'video'
    || input === 'audio'
    || input === 'pdf'
    || input === 'docx';
}

function isBinaryDocumentKind(input: WorkspaceFileKind): input is 'pdf' | 'docx' {
  return input === 'pdf' || input === 'docx';
}

const BINARY_DOCUMENT_MIME_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isCanonicalBase64WithinLimit(input: unknown, byteLimit: number): input is string {
  if (typeof input !== 'string' || input.length === 0 || input.length % 4 !== 0) return false;

  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const decodedLength = (input.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > byteLimit) return false;

  const dataLength = input.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(input[index]!) < 0) return false;
  }
  for (let index = dataLength; index < input.length; index += 1) {
    if (input[index] !== '=') return false;
  }
  if (padding === 2) {
    const finalSextet = BASE64_ALPHABET.indexOf(input[dataLength - 1]!);
    if (finalSextet < 0 || (finalSextet & 0x0f) !== 0) return false;
  } else if (padding === 1) {
    const finalSextet = BASE64_ALPHABET.indexOf(input[dataLength - 1]!);
    if (finalSextet < 0 || (finalSextet & 0x03) !== 0) return false;
  }
  return true;
}

function hasValidBinaryDocumentState(input: Record<string, unknown>): boolean {
  const kind = input.activeFileKind as WorkspaceFileKind;
  if (!isBinaryDocumentKind(kind)) {
    return input.bytesBase64 === undefined || input.bytesBase64 === null;
  }
  return input.activeMimeType === BINARY_DOCUMENT_MIME_TYPES[kind]
    && input.content === ''
    && input.lastSavedContent === ''
    && isCanonicalBase64WithinLimit(input.bytesBase64, PANE_BINARY_SOURCE_LIMITS[kind]);
}

function isBinaryDocumentSnapshot(snapshot: PaneSnapshotEnvelope): boolean {
  return isBinaryDocumentKind(snapshot.state.activeFileKind);
}

function isDocumentAuthorityStatus(input: unknown): input is DocumentAuthorityStatus {
  return input === 'committed'
    || input === 'provisional'
    || input === 'unknown'
    || input === 'failed';
}

function snapshotAcceptsEditorContent(snapshot: PaneSnapshotEnvelope): boolean {
  return snapshot.state.authorityStatus === 'committed'
    && (
      snapshot.state.activeFileKind === 'markdown'
      || snapshot.state.activeFileKind === 'html'
      || snapshot.state.activeFileKind === 'excalidraw'
    );
}

function isProtocolId(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input);
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function isPositiveSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) > 0;
}

function decodePaneReplicatedState(input: unknown): PaneReplicatedState | null {
  const baseKeys = [
    'activeFileKind',
    'activeMimeType',
    'activePath',
    'content',
    'lastSavedContent',
    'previewRevision',
    'workspaceRoot',
    'documentId',
    'documentEpoch',
  ];
  const currentKeys = [...baseKeys, 'authorityStatus'];
  const binaryKeys = [...currentKeys, 'bytesBase64'];
  if (
    !isRecord(input)
    || (!hasExactEnumerableKeys(input, baseKeys)
      && !hasExactEnumerableKeys(input, currentKeys)
      && !hasExactEnumerableKeys(input, binaryKeys))
    || !isWorkspaceFileKind(input.activeFileKind)
    || !isNullableString(input.activeMimeType)
    || !isNullableString(input.activePath)
    || typeof input.content !== 'string'
    || typeof input.lastSavedContent !== 'string'
    || !isNonNegativeSafeInteger(input.previewRevision)
    || !isNullableString(input.workspaceRoot)
    || (Object.prototype.hasOwnProperty.call(input, 'bytesBase64')
      && !isNullableString(input.bytesBase64))
    || !isProtocolId(input.documentId)
    || !isNonNegativeSafeInteger(input.documentEpoch)
    || (Object.prototype.hasOwnProperty.call(input, 'authorityStatus')
      && !isDocumentAuthorityStatus(input.authorityStatus))
    || !hasValidBinaryDocumentState(input)
  ) return null;

  return {
    activeFileKind: input.activeFileKind,
    activeMimeType: input.activeMimeType,
    activePath: input.activePath,
    ...(Object.prototype.hasOwnProperty.call(input, 'bytesBase64')
      ? { bytesBase64: input.bytesBase64 as string | null }
      : {}),
    content: input.content,
    lastSavedContent: input.lastSavedContent,
    previewRevision: input.previewRevision,
    ...(isDocumentAuthorityStatus(input.authorityStatus)
      ? { authorityStatus: input.authorityStatus }
      : {}),
    workspaceRoot: input.workspaceRoot,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
  };
}

export function decodePaneSnapshotEnvelope(input: unknown): PaneSnapshotEnvelope | null {
  if (
    !isRecord(input)
    || !hasExactEnumerableKeys(input, [
      'protocolVersion',
      'authorityId',
      'revision',
      'documentId',
      'documentEpoch',
      'state',
    ])
    || input.protocolVersion !== PANE_PROTOCOL_VERSION
    || !isProtocolId(input.authorityId)
    || !isNonNegativeSafeInteger(input.revision)
    || !isProtocolId(input.documentId)
    || !isNonNegativeSafeInteger(input.documentEpoch)
  ) return null;

  const state = decodePaneReplicatedState(input.state);
  if (
    !state
    || state.documentId !== input.documentId
    || state.documentEpoch !== input.documentEpoch
  ) return null;

  return {
    protocolVersion: PANE_PROTOCOL_VERSION,
    authorityId: input.authorityId,
    revision: input.revision,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
    state,
  };
}

export function decodePaneContentEnvelope(input: unknown): PaneContentEnvelope | null {
  if (
    !isRecord(input)
    || !hasExactEnumerableKeys(input, [
      'protocolVersion',
      'authorityId',
      'sourceId',
      'sequence',
      'documentId',
      'documentEpoch',
      'content',
    ])
    || input.protocolVersion !== PANE_PROTOCOL_VERSION
    || !isProtocolId(input.authorityId)
    || !isProtocolId(input.sourceId)
    || !isPositiveSafeInteger(input.sequence)
    || !isProtocolId(input.documentId)
    || !isNonNegativeSafeInteger(input.documentEpoch)
    || typeof input.content !== 'string'
  ) return null;

  return {
    protocolVersion: PANE_PROTOCOL_VERSION,
    authorityId: input.authorityId,
    sourceId: input.sourceId,
    sequence: input.sequence,
    documentId: input.documentId,
    documentEpoch: input.documentEpoch,
    content: input.content,
  };
}

export function decodePaneSnapshotRequestEnvelope(input: unknown): PaneSnapshotRequestEnvelope | null {
  if (
    !isRecord(input)
    || !hasExactEnumerableKeys(input, ['protocolVersion', 'requesterId'])
    || input.protocolVersion !== PANE_PROTOCOL_VERSION
    || !isProtocolId(input.requesterId)
  ) return null;
  return { protocolVersion: PANE_PROTOCOL_VERSION, requesterId: input.requesterId };
}

type PaneReplicationOptions = {
  cache: PaneCache;
  transport: PaneTransport;
  observe: (snapshot: PaneSnapshotEnvelope) => void;
  onError?: (error: unknown) => void;
} & (
  | { role: 'main'; authorityId: string; requesterId?: never; scheduler?: PaneScheduler; sourceId?: never }
  | { role: 'editor-popout'; authorityId?: never; requesterId: string; scheduler?: never; sourceId: string }
  | { role: 'preview-popout'; authorityId?: never; requesterId: string; scheduler?: never; sourceId?: never }
);

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
    if (source === 'live') {
      if (this.liveAuthorityId === null) this.liveAuthorityId = snapshot.authorityId;
      else if (snapshot.authorityId !== this.liveAuthorityId) return;
    }
    if (this.acceptedSnapshot?.authorityId === snapshot.authorityId) {
      if (
        snapshot.revision <= this.acceptedSnapshot.revision
        && !(source === 'live'
          && this.acceptedSnapshotSource === 'cache'
          && snapshot.revision === this.acceptedSnapshot.revision)
      ) return;
      if (snapshot.documentEpoch < this.acceptedSnapshot.documentEpoch) return;
      if (
        snapshot.documentEpoch === this.acceptedSnapshot.documentEpoch
        && (snapshot.documentId !== this.acceptedSnapshot.documentId
          || snapshot.state.previewRevision < this.acceptedSnapshot.state.previewRevision)
      ) return;
    }

    this.acceptedSnapshot = snapshot;
    this.acceptedSnapshotSource = source;
    this.observe(snapshot);
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
