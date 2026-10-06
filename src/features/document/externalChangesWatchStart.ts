import type { RefObject } from 'react';
import {
  type ActiveDocumentWatchSnapshotEnvelope,
  type ActiveDocumentWatchTransport } from '../../lib/activeDocumentWatch';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import { translate } from '../../lib/i18n';
import type { AcceptedActiveDocumentWatch, ExternalFileActionState } from './sessionTypes';
import type { } from '../../types';

export interface WatchStartContext {
  activeDocumentWatchRef: RefObject<AcceptedActiveDocumentWatch | null>;
  activeDocumentWatchTransport: ActiveDocumentWatchTransport;
  activePathRef: RefObject<string | null>;
  documentGenerationRef: RefObject<number>;
  enqueueActiveDocumentWatchEnvelope: (
    accepted: AcceptedActiveDocumentWatch,
    envelope: ActiveDocumentWatchSnapshotEnvelope,
    registration?: boolean,
  ) => Promise<boolean>;
  externalFileActionRef: RefObject<ExternalFileActionState | null>;
  isDisposed: () => boolean;
  localeRef: RefObject<EffectiveLocale>;
  paneStateRef: RefObject<{ documentId: string }>;
  requestedDocumentId: string;
  requestedDocumentGeneration: number;
  requestedPath: string;
  setError: (message: string | null) => void;
}

// 监视会话启动的异步主体：注册 → 首信封入队 → 接受 → 激活；任一身份检查失败即停表。
// isDisposed 由效果闭包提供；onWatchIdAssigned 回写效果级 startedWatchId。
export async function startWatchSession(
  ctx: WatchStartContext,
  onWatchIdAssigned: (watchId: string) => void,
): Promise<void> {
  const { activeDocumentWatchTransport } = ctx;
  try {
    const registration = await activeDocumentWatchTransport.start(
      ctx.requestedPath,
      ctx.requestedDocumentId,
      ctx.requestedDocumentGeneration,
    );
    onWatchIdAssigned(registration.watch_id);
    if (sessionStale(ctx)) {
      await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
      return;
    }

    const accepted: AcceptedActiveDocumentWatch = {
      documentGeneration: ctx.requestedDocumentGeneration,
      documentId: ctx.requestedDocumentId,
      highestAppliedSequence: 0,
      path: ctx.requestedPath,
      resolvedThroughSequence: 0,
      watchId: registration.watch_id,
    };
    const envelope: ActiveDocumentWatchSnapshotEnvelope = {
      protocol_version: registration.protocol_version,
      watch_id: registration.watch_id,
      document_id: registration.document_id,
      document_generation: registration.document_generation,
      sequence: registration.sequence,
      reason: registration.snapshot.status === 'missing' ? 'missing' : 'resync',
      previous_path: null,
      snapshot: registration.snapshot,
    };
    await acceptWatchRegistration(ctx, registration, accepted, envelope);
  } catch (watchError) {
    if (watchErrorStillCurrent(ctx)) {
      ctx.setError(normalizeAppError(watchError, ctx.localeRef.current));
    }
  }
}

async function acceptWatchRegistration(
  ctx: WatchStartContext,
  registration: Awaited<ReturnType<WatchStartContext['activeDocumentWatchTransport']['start']>>,
  accepted: AcceptedActiveDocumentWatch,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
): Promise<void> {
  const { activeDocumentWatchTransport } = ctx;
  const applied = await ctx.enqueueActiveDocumentWatchEnvelope(accepted, envelope, true);
  if (!applied || registrationAbandoned(ctx)) {
    await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
    return;
  }
  accepted.highestAppliedSequence = registration.sequence;
  accepted.path = registration.snapshot.status === 'present'
    ? registration.snapshot.file.path
    : registration.snapshot.path;
  ctx.activeDocumentWatchRef.current = accepted;
  const activated = await activeDocumentWatchTransport.activate(
    registration.watch_id,
    ctx.requestedDocumentId,
    ctx.requestedDocumentGeneration,
    registration.sequence,
  );
  if (activationRejected(ctx, activated, registration.watch_id)) {
    ctx.activeDocumentWatchRef.current = null;
    await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
    ctx.setError(translate(ctx.localeRef.current, 'watchUnavailable'));
  }
}

function sessionStale(ctx: WatchStartContext): boolean {
  return ctx.isDisposed()
    || ctx.documentGenerationRef.current !== ctx.requestedDocumentGeneration
    || ctx.paneStateRef.current.documentId !== ctx.requestedDocumentId
    || ctx.activePathRef.current !== ctx.requestedPath;
}

function registrationAbandoned(ctx: WatchStartContext): boolean {
  return sessionStale(ctx)
    || !ctx.activePathRef.current
    || ctx.externalFileActionRef.current?.kind === 'deleted-draft';
}

function activationRejected(
  ctx: WatchStartContext,
  activated: boolean,
  watchId: string,
): boolean {
  return !activated && ctx.activeDocumentWatchRef.current?.watchId === watchId;
}

function watchErrorStillCurrent(ctx: WatchStartContext): boolean {
  return !ctx.isDisposed()
    && ctx.documentGenerationRef.current === ctx.requestedDocumentGeneration
    && ctx.paneStateRef.current.documentId === ctx.requestedDocumentId
    && ctx.activePathRef.current === ctx.requestedPath;
}

