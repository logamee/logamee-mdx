import { emitTo } from '@tauri-apps/api/event';
import { MEDIA_EVENT_RETRY_DELAYS_MS } from './mediaRetry';
import { getPanePopoutLabel } from '../../lib/paneLayout';
import {
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
  type MarkdownMediaCursorInsertion,
  type MarkdownMediaInsertionHandshake } from '../../lib/markdownMedia';

export const MEDIA_INSERTION_HANDSHAKE_ATTEMPTS = 3;
const MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS = 250;
export const MAIN_WINDOW_LABEL = 'main';

export interface PendingMarkdownMediaInsertionHandshake {
  attempt: number;
  generation: number;
  handshake: MarkdownMediaInsertionHandshake;
  retryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  sending: boolean;
}

export type PendingMarkdownMediaCursorInsertion = Omit<MarkdownMediaCursorInsertion, 'popoutInstanceId'>;

export function cancelMarkdownMediaInsertionHandshake(
  pending: PendingMarkdownMediaInsertionHandshake | null,
): void {
  if (pending?.retryTimer !== null && pending?.retryTimer !== undefined) {
    globalThis.clearTimeout(pending.retryTimer);
    pending.retryTimer = null;
  }
}

export function getWorkspaceRelativePath(workspaceRoot: string | null, path: string | null): string | null {
  if (!workspaceRoot || !path) return null;
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const normalizedPath = path.replace(/\\/g, '/');
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  const relativePath = normalizedPath.slice(prefix.length);
  if (!relativePath || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return relativePath;
}

export interface EditorPopoutHandshakeContext {
  disposed: boolean;
  documentEpoch: number | null;
  documentId: string | null;
  editorPopoutHandshakeRef: React.MutableRefObject<PendingMarkdownMediaInsertionHandshake | null>;
  editorPopoutOpenRef: React.RefObject<boolean>;
  expectedEditorPopoutInstanceIdRef: React.RefObject<string | null>;
  popoutMediaInsertionGenerationRef: React.MutableRefObject<number>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  translate: (key: 'popoutInsertionUnavailable') => string;
}

function handshakeIsCurrent(
  ctx: EditorPopoutHandshakeContext,
  pending: PendingMarkdownMediaInsertionHandshake,
): boolean {
  return !ctx.disposed
    && ctx.editorPopoutOpenRef.current
    && pending.generation === ctx.popoutMediaInsertionGenerationRef.current
    && ctx.editorPopoutHandshakeRef.current === pending
    && pending.handshake.documentId === ctx.documentId
    && pending.handshake.documentEpoch === ctx.documentEpoch
    && pending.handshake.popoutInstanceId === ctx.expectedEditorPopoutInstanceIdRef.current;
}

function failHandshake(
  ctx: EditorPopoutHandshakeContext,
  pending: PendingMarkdownMediaInsertionHandshake,
): void {
  cancelMarkdownMediaInsertionHandshake(pending);
  ctx.editorPopoutHandshakeRef.current = null;
  ctx.setError(ctx.translate('popoutInsertionUnavailable'));
  ctx.setNotice(null);
}

function scheduleHandshakeRetry(
  ctx: EditorPopoutHandshakeContext,
  pending: PendingMarkdownMediaInsertionHandshake,
  delayMs: number,
  _failure: unknown,
): void {
  cancelMarkdownMediaInsertionHandshake(pending);
  pending.retryTimer = globalThis.setTimeout(() => {
    pending.retryTimer = null;
    if (!handshakeIsCurrent(ctx, pending)) return;
    if (pending.attempt >= MEDIA_INSERTION_HANDSHAKE_ATTEMPTS) {
      failHandshake(ctx, pending);
      return;
    }
    pending.attempt += 1;
    sendHandshake(ctx, pending);
  }, delayMs);
}

function sendHandshake(
  ctx: EditorPopoutHandshakeContext,
  pending: PendingMarkdownMediaInsertionHandshake,
): void {
  if (!handshakeIsCurrent(ctx, pending) || pending.sending) return;
  pending.sending = true;
  void emitTo(
    getPanePopoutLabel('editor'),
    MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
    pending.handshake,
  ).then(() => {
    pending.sending = false;
    if (!handshakeIsCurrent(ctx, pending)) return;
    scheduleHandshakeRetry(
      ctx,
      pending,
      MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS,
      new Error('Markdown media insertion handshake timed out'),
    );
  }).catch((err: unknown) => {
    pending.sending = false;
    if (!handshakeIsCurrent(ctx, pending)) return;
    scheduleHandshakeRetry(
      ctx,
      pending,
      MEDIA_EVENT_RETRY_DELAYS_MS[pending.attempt] ?? MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS,
      err,
    );
  });
}

export function createEditorPopoutHandshakeCoordinator(ctx: EditorPopoutHandshakeContext) {
  return {
    isHandshakeCurrent: (pending: PendingMarkdownMediaInsertionHandshake) => handshakeIsCurrent(ctx, pending),
    failHandshake: (pending: PendingMarkdownMediaInsertionHandshake) => {
      if (handshakeIsCurrent(ctx, pending)) failHandshake(ctx, pending);
    },
    scheduleHandshakeRetry: (pending: PendingMarkdownMediaInsertionHandshake, delayMs: number, failure: unknown) => {
      scheduleHandshakeRetry(ctx, pending, delayMs, failure);
    },
    sendHandshake: (pending: PendingMarkdownMediaInsertionHandshake) => {
      sendHandshake(ctx, pending);
    } };
}
