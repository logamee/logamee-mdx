import { listen } from '@tauri-apps/api/event';
import { normalizeAppError } from '../../lib/appFeedback';
import { createMarkdownMediaReference } from '../../lib/markdownMedia';
import {
  decodeMarkdownMediaCursorInsertion,
  decodeMarkdownMediaInsertionHandshake,
  decodeMarkdownMediaInsertionReadyRequest,
  MARKDOWN_MEDIA_INSERTION_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
  MARKDOWN_MEDIA_INSERTION_READY_EVENT,
  MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
  type MarkdownMediaCursorInsertion,
  type MarkdownMediaInsertionHandshake } from '../../lib/markdownMedia';
import { emitToWithRetry } from './mediaRetry';
import {
  getWorkspaceRelativePath,
  MAIN_WINDOW_LABEL } from './editorPopoutHandshakeProtocol';
import { reportRegistrationFailure, settleListenerRegistrations } from './editorPopoutChannelHandlers';
import type { EditorPopoutChannelContext } from './editorPopoutChannelTypes';

function announcePopoutReady(
  ctx: EditorPopoutChannelContext,
  popoutInstanceId: string,
  isAlive: () => boolean,
  readyRequestId?: string,
): Promise<void> {
  return emitToWithRetry(
    MAIN_WINDOW_LABEL,
    MARKDOWN_MEDIA_INSERTION_READY_EVENT,
    readyRequestId
      ? { documentEpoch: ctx.documentEpoch, documentId: ctx.documentId, popoutInstanceId, readyRequestId }
      : { documentEpoch: ctx.documentEpoch, documentId: ctx.documentId, popoutInstanceId },
    isAlive,
    ctx.markdownMediaRetryControllerRef.current,
  ).catch((err: unknown) => {
    if (!isAlive()) return;
    ctx.setError(normalizeAppError(err, ctx.locale));
    ctx.setNotice(null);
  });
}

export function registerEditorPopoutSideChannel(deps: {
  ctx: EditorPopoutChannelContext;
  onLocalMediaInsertion: (insertion: {
    documentEpoch: number;
    documentId: string;
    markdown: string;
    requestId: number;
  }) => void;
  popoutInstanceId: string;
}): () => void {
  const { ctx, popoutInstanceId } = deps;
  let disposed = false;
  let handshakeReceived = false;
  const unlisteners: Array<() => void> = [];
  const announceReady = (readyRequestId?: string) => announcePopoutReady(
    ctx, popoutInstanceId, () => !disposed, readyRequestId);
  void Promise.allSettled([
    listen<unknown>(MARKDOWN_MEDIA_INSERTION_EVENT, (event) => {
      if (disposed) return;
      onPopoutMediaInsertion(ctx, deps.onLocalMediaInsertion, event);
    }),
    listen<unknown>(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT, (event) => {
      if (disposed) return;
      handshakeReceived = onPopoutHandshake(ctx, () => !disposed, event) || handshakeReceived;
    }),
    listen<unknown>(MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT, (event) => {
      if (disposed) return;
      const request = decodeMarkdownMediaInsertionReadyRequest(event.payload);
      if (!request || request.documentId !== ctx.documentId || request.documentEpoch !== ctx.documentEpoch) return;
      void announceReady(request.readyRequestId);
    }),
  ]).then((registrations) => {
    settleListenerRegistrations({
      disposed,
      failureLabel: reportRegistrationFailure(ctx),
      onRegistered: () => {
        if (!handshakeReceived) void announceReady();
      },
      registered: unlisteners,
      registrations });
  });
  return () => {
    disposed = true;
    for (const unlisten of unlisteners) unlisten();
  };
}

function popoutInsertionMatches(
  insertion: MarkdownMediaCursorInsertion,
  ctx: EditorPopoutChannelContext,
): boolean {
  return insertion.documentId === ctx.documentId
    && insertion.documentEpoch === ctx.documentEpoch
    && insertion.popoutInstanceId === ctx.popoutInstanceId
    && ctx.activeFileKind === 'markdown'
    && ctx.authorityStatus === 'committed';
}

function onPopoutMediaInsertion(
  ctx: EditorPopoutChannelContext,
  onLocalMediaInsertion: (insertion: {
    documentEpoch: number;
    documentId: string;
    markdown: string;
    requestId: number;
  }) => void,
  event: { payload: unknown },
): void {
  const insertion = decodeMarkdownMediaCursorInsertion(event.payload);
  if (!insertion || !popoutInsertionMatches(insertion, ctx)) return;
  const requestKey = `${insertion.documentId}:${insertion.documentEpoch}`;
  const highestRequestId = ctx.mediaInsertionHighWaterRef.current.get(requestKey) ?? 0;
  const currentRelativePath = getWorkspaceRelativePath(ctx.workspaceRoot, ctx.activePath);
  if (insertion.requestId <= highestRequestId || currentRelativePath !== insertion.documentRelativePath) return;
  const markdown = createMarkdownMediaReference(insertion.asset, { relative_path: currentRelativePath });
  if (!markdown) return;
  ctx.mediaInsertionHighWaterRef.current.set(requestKey, insertion.requestId);
  onLocalMediaInsertion({
    documentEpoch: insertion.documentEpoch,
    documentId: insertion.documentId,
    markdown,
    requestId: insertion.requestId });
}

function popoutHandshakeMatches(
  handshake: MarkdownMediaInsertionHandshake,
  ctx: EditorPopoutChannelContext,
): boolean {
  return handshake.documentId === ctx.documentId
    && handshake.documentEpoch === ctx.documentEpoch
    && handshake.popoutInstanceId === ctx.popoutInstanceId
    && ctx.activeFileKind === 'markdown'
    && ctx.authorityStatus === 'committed';
}

function onPopoutHandshake(
  ctx: EditorPopoutChannelContext,
  isAlive: () => boolean,
  event: { payload: unknown },
): boolean {
  const handshake = decodeMarkdownMediaInsertionHandshake(event.payload);
  if (!handshake || !popoutHandshakeMatches(handshake, ctx)) return false;
  void emitToWithRetry(
    MAIN_WINDOW_LABEL,
    MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
    handshake,
    isAlive,
    ctx.markdownMediaRetryControllerRef.current,
  ).catch((err: unknown) => {
    if (!isAlive()) return;
    ctx.setError(normalizeAppError(err, ctx.locale));
    ctx.setNotice(null);
  });
  return true;
}

