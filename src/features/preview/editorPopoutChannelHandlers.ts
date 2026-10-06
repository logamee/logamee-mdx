import { listen } from '@tauri-apps/api/event';
import { normalizeAppError } from '../../lib/appFeedback';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import {
  decodeMarkdownMediaInsertionHandshake,
  decodeMarkdownMediaInsertionReady,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
  MARKDOWN_MEDIA_INSERTION_READY_EVENT,
  type MarkdownMediaCursorInsertion,
  type MarkdownMediaInsertionHandshake,
  type MarkdownMediaInsertionReady } from '../../lib/markdownMedia';
import {
  cancelMarkdownMediaInsertionHandshake,
  createEditorPopoutHandshakeCoordinator,
  MEDIA_INSERTION_HANDSHAKE_ATTEMPTS,
  type PendingMarkdownMediaCursorInsertion,
  type PendingMarkdownMediaInsertionHandshake } from './editorPopoutHandshakeProtocol';
import type { EditorPopoutChannelContext } from './editorPopoutChannelTypes';
import type { WorkspaceFileKind } from '../../types';

function editorPopoutStartHandshake(
  ctx: EditorPopoutChannelContext,
  coordinator: ReturnType<typeof createEditorPopoutHandshakeCoordinator>,
  ready: MarkdownMediaInsertionReady,
): void {
  if (!ctx.editorPopoutOpenRef.current) return;
  const current = ctx.editorPopoutHandshakeRef.current;
  if (
    current
    && coordinator.isHandshakeCurrent(current)
    && current.handshake.documentId === ready.documentId
    && current.handshake.documentEpoch === ready.documentEpoch
    && current.handshake.popoutInstanceId === ready.popoutInstanceId
  ) {
    if (current.sending || current.attempt >= MEDIA_INSERTION_HANDSHAKE_ATTEMPTS) return;
    cancelMarkdownMediaInsertionHandshake(current);
    current.attempt += 1;
    coordinator.sendHandshake(current);
    return;
  }
  cancelMarkdownMediaInsertionHandshake(ctx.editorPopoutHandshakeRef.current);
  ctx.editorPopoutReadyRef.current = null;
  const { readyRequestId: _readyRequestId, ...handshakeReady } = ready;
  const pending: PendingMarkdownMediaInsertionHandshake = {
    attempt: 1,
    generation: ctx.popoutMediaInsertionGenerationRef.current,
    handshake: {
      ...handshakeReady,
      handshakeId: createPaneProtocolId('markdown-media-handshake') },
    retryTimer: null,
    sending: false };
  ctx.editorPopoutHandshakeRef.current = pending;
  coordinator.sendHandshake(pending);
}

function editorPopoutReadyMatches(
  ready: MarkdownMediaInsertionReady,
  ctx: EditorPopoutChannelContext,
): boolean {
  return ready.documentId === ctx.documentId
    && ready.documentEpoch === ctx.documentEpoch
    && ctx.editorPopoutOpenRef.current;
}

function onEditorPopoutMediaInsertionReady(
  ctx: EditorPopoutChannelContext,
  startHandshake: (ready: MarkdownMediaInsertionReady) => void,
  event: { payload: unknown },
): void {
  const ready = decodeMarkdownMediaInsertionReady(event.payload);
  if (!ready || !editorPopoutReadyMatches(ready, ctx)) return;
  const expectedInstanceId = ctx.expectedEditorPopoutInstanceIdRef.current;
  const pendingReadyRequestId = ctx.pendingEditorPopoutReadyRequestIdRef.current;
  if (expectedInstanceId && ready.popoutInstanceId !== expectedInstanceId) return;
  if (pendingReadyRequestId && ready.readyRequestId !== pendingReadyRequestId) return;
  if (!expectedInstanceId) ctx.expectedEditorPopoutInstanceIdRef.current = ready.popoutInstanceId;
  if (pendingReadyRequestId) ctx.pendingEditorPopoutReadyRequestIdRef.current = null;
  startHandshake(ready);
}

function handshakeAckMatches(
  handshake: MarkdownMediaInsertionHandshake,
  pendingHandshake: PendingMarkdownMediaInsertionHandshake,
  ctx: EditorPopoutChannelContext,
): boolean {
  return ctx.editorPopoutOpenRef.current
    && pendingHandshake.generation === ctx.popoutMediaInsertionGenerationRef.current
    && handshake.handshakeId === pendingHandshake.handshake.handshakeId
    && handshake.documentId === pendingHandshake.handshake.documentId
    && handshake.documentEpoch === pendingHandshake.handshake.documentEpoch
    && handshake.popoutInstanceId === pendingHandshake.handshake.popoutInstanceId
    && handshake.popoutInstanceId === ctx.expectedEditorPopoutInstanceIdRef.current
    && handshake.documentId === ctx.documentId
    && handshake.documentEpoch === ctx.documentEpoch;
}

function onEditorPopoutHandshakeAck(
  ctx: EditorPopoutChannelContext,
  deliverCursorInsertion: (insertion: MarkdownMediaCursorInsertion) => void,
  event: { payload: unknown },
): void {
  const handshake = decodeMarkdownMediaInsertionHandshake(event.payload);
  const pendingHandshake = ctx.editorPopoutHandshakeRef.current;
  if (!handshake || !pendingHandshake) return;
  if (!handshakeAckMatches(handshake, pendingHandshake, ctx)) return;
  cancelMarkdownMediaInsertionHandshake(pendingHandshake);
  ctx.editorPopoutHandshakeRef.current = null;
  ctx.editorPopoutReadyRef.current = {
    documentId: handshake.documentId,
    documentEpoch: handshake.documentEpoch,
    popoutInstanceId: handshake.popoutInstanceId };
  const pending = ctx.pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
    insertion.documentId === handshake.documentId && insertion.documentEpoch === handshake.documentEpoch
  ));
  ctx.pendingPopoutMediaInsertionsRef.current = ctx.pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
    insertion.documentId !== handshake.documentId || insertion.documentEpoch !== handshake.documentEpoch
  ));
  for (const insertion of pending) {
    deliverCursorInsertion({
      ...insertion,
      popoutInstanceId: handshake.popoutInstanceId });
  }
}

function registrationOutcome(
  registrations: PromiseSettledResult<() => void>[],
): { registered: Array<() => void>; failure?: PromiseRejectedResult } {
  const registered = registrations.flatMap((registration) => (
    registration.status === 'fulfilled' ? [registration.value] : []
  ));
  const failure = registrations.find((registration) => registration.status === 'rejected');
  return { registered, failure: failure as PromiseRejectedResult | undefined };
}

export function settleListenerRegistrations(deps: {
  failureLabel: (failure: PromiseRejectedResult) => void;
  registrations: PromiseSettledResult<() => void>[];
  registered: Array<() => void>;
  onRegistered: () => void;
  disposed: boolean;
}): void {
  const { registered, failure } = registrationOutcome(deps.registrations);
  if (deps.disposed || failure) {
    for (const unlisten of registered) unlisten();
  } else {
    deps.registered.push(...registered);
    deps.onRegistered();
  }
  if (!deps.disposed && failure) deps.failureLabel(failure);
}

function mainChannelCoordinatorContext(
  ctx: EditorPopoutChannelContext,
  translate: (key: 'popoutInsertionUnavailable') => string,
) {
  return {
    disposed: false,
    documentEpoch: ctx.documentEpoch,
    documentId: ctx.documentId,
    editorPopoutHandshakeRef: ctx.editorPopoutHandshakeRef,
    editorPopoutOpenRef: ctx.editorPopoutOpenRef,
    expectedEditorPopoutInstanceIdRef: ctx.expectedEditorPopoutInstanceIdRef,
    popoutMediaInsertionGenerationRef: ctx.popoutMediaInsertionGenerationRef,
    setError: ctx.setError,
    setNotice: ctx.setNotice,
    translate };
}

export function registerMainWindowEditorPopoutChannel(deps: {
  deliverCursorInsertion: (insertion: MarkdownMediaCursorInsertion) => void;
  startHandshakeRef: React.MutableRefObject<((ready: MarkdownMediaInsertionReady) => void) | null>;
  translate: (key: 'popoutInsertionUnavailable') => string;
  ctx: EditorPopoutChannelContext;
}): () => void {
  const { ctx } = deps;
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const coordinator = createEditorPopoutHandshakeCoordinator(
    mainChannelCoordinatorContext(ctx, deps.translate));
  const startHandshake = (ready: MarkdownMediaInsertionReady) => {
    if (disposed) return;
    editorPopoutStartHandshake(ctx, coordinator, ready);
  };
  deps.startHandshakeRef.current = startHandshake;
  void Promise.allSettled([
    listen<unknown>(MARKDOWN_MEDIA_INSERTION_READY_EVENT, (event) => {
      if (disposed) return;
      onEditorPopoutMediaInsertionReady(ctx, startHandshake, event);
    }),
    listen<unknown>(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT, (event) => {
      if (disposed) return;
      onEditorPopoutHandshakeAck(ctx, deps.deliverCursorInsertion, event);
    }),
  ]).then((registrations) => {
    settleListenerRegistrations({
      disposed,
      failureLabel: reportRegistrationFailure(ctx),
      onRegistered: () => resumePendingPopoutInsertions(ctx, startHandshake),
      registered: unlisteners,
      registrations });
  });
  return () => {
    disposed = true;
    if (deps.startHandshakeRef.current === startHandshake) {
      deps.startHandshakeRef.current = null;
    }
    cancelSettledHandshake(ctx);
    for (const unlisten of unlisteners) unlisten();
  };
}

export function reportRegistrationFailure(ctx: EditorPopoutChannelContext) {
  return (failure: PromiseRejectedResult) => {
    ctx.setError(normalizeAppError(failure.reason, ctx.locale));
    ctx.setNotice(null);
  };
}

function cancelSettledHandshake(ctx: EditorPopoutChannelContext): void {
  const pendingHandshake = ctx.editorPopoutHandshakeRef.current;
  if (
    pendingHandshake
    && pendingHandshake.handshake.documentId === ctx.documentId
    && pendingHandshake.handshake.documentEpoch === ctx.documentEpoch
  ) {
    cancelMarkdownMediaInsertionHandshake(pendingHandshake);
    ctx.editorPopoutHandshakeRef.current = null;
  }
}

function resumePendingPopoutInsertions(
  ctx: EditorPopoutChannelContext,
  startHandshake: (ready: MarkdownMediaInsertionReady) => void,
): void {
  if (
    !ctx.editorPopoutOpenRef.current
    || !ctx.pendingPopoutMediaInsertionsRef.current.some((insertion) => (
      insertion.documentId === ctx.documentId && insertion.documentEpoch === ctx.documentEpoch
    ))
  ) return;
  const expectedInstanceId = ctx.expectedEditorPopoutInstanceIdRef.current;
  if (expectedInstanceId) {
    startHandshake({
      documentEpoch: ctx.documentEpoch as number,
      documentId: ctx.documentId as string,
      popoutInstanceId: expectedInstanceId });
  }
}

export function pendingCursorInsertionFrom(
  asset: { kind: WorkspaceFileKind; name: string; relative_path: string },
  documentRelativePath: string,
  insertion: { documentEpoch: number; documentId: string; requestId: number },
): PendingMarkdownMediaCursorInsertion {
  return {
    asset: {
      kind: asset.kind,
      name: asset.name,
      relative_path: asset.relative_path },
    documentRelativePath,
    documentEpoch: insertion.documentEpoch,
    documentId: insertion.documentId,
    requestId: insertion.requestId };
}
