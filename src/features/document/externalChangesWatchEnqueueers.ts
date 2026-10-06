/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import { translate } from '../../lib/i18n';
import type { ActiveDocumentWatchEvent, ActiveDocumentWatchSnapshotEnvelope } from '../../lib/activeDocumentWatch';
import type { ExternalChangesDeps } from './externalChangesTypes';
import type { AcceptedActiveDocumentWatch } from './sessionTypes';
import { watchEnvelopeQueueOperation } from './externalChangesWatchQueue';
import type { useExternalChangesWatchHandlers } from './externalChangesWatchHandlers';
import type { WatchEnvelopeEnqueuer } from './externalChangesWatchQueue';

type WatchHandlers = ReturnType<typeof useExternalChangesWatchHandlers>;

export function useWatchEnqueueers(deps: ExternalChangesDeps, handlers: WatchHandlers) {
  const {
    activeFileVersionRef, activePathRef,
    currentDocumentSessionState, documentGenerationRef, localeRef, paneStateRef,
    sessionQueue, setError } = deps;
  const {
    applyExternalDocumentDecision,
    envelopeMatchesAcceptedPath,
    isAcceptedWatchCurrent } = handlers;

    const enqueueActiveDocumentWatchEnvelope = useCallback(async (
      accepted: AcceptedActiveDocumentWatch,
      envelope: ActiveDocumentWatchSnapshotEnvelope,
      registration = false,
    ): Promise<boolean> => {
      try {
        const result = await sessionQueue.enqueue(watchEnvelopeQueueOperation({
          accepted,
          envelope,
          registration,
          activeFileVersionRef,
          activePathRef,
          currentDocumentSessionState,
          documentGenerationRef,
          paneStateRef,
          applyExternalDocumentDecision,
          envelopeMatchesAcceptedPath,
          isAcceptedWatchCurrent }));
        return result.status === 'applied';
      } catch (watchError) {
        setError(normalizeAppError(watchError, localeRef.current));
        return false;
      }
    }, [
      applyExternalDocumentDecision,
      currentDocumentSessionState,
      envelopeMatchesAcceptedPath,
      isAcceptedWatchCurrent,
      sessionQueue,
    ]);

    const health = useWatchHealthHandlers(deps, handlers, enqueueActiveDocumentWatchEnvelope);
  return {
    enqueueActiveDocumentWatchEnvelope,
    ...health };
}

function useWatchHealthHandlers(
  deps: Parameters<typeof useWatchEnqueueers>[0],
  guards: Parameters<typeof useWatchEnqueueers>[1],
  enqueueActiveDocumentWatchEnvelope: WatchEnvelopeEnqueuer,
) {
  const { localeRef, sessionQueue, setError, setNotice } = deps;
  const { isAcceptedWatchCurrent } = guards;

  const enqueueActiveDocumentWatchHealth = useCallback(async (
      accepted: AcceptedActiveDocumentWatch,
      event: ActiveDocumentWatchEvent & { event: { kind: 'health' } },
    ) => {
      try {
        await sessionQueue.enqueue({
          run: async () => event,
          isCurrent: () => isAcceptedWatchCurrent(accepted, event.sequence),
          apply: (currentEvent) => {
            if (!isAcceptedWatchCurrent(accepted, currentEvent.sequence)) return;
            accepted.highestAppliedSequence = currentEvent.sequence;
            if (currentEvent.event.status === 'failed') {
              setError(translate(localeRef.current, 'watchStopped'));
              setNotice(null);
            } else {
              setNotice(translate(localeRef.current, 'watchInterrupted'));
            }
          },
        });
      } catch (watchError) {
        setError(normalizeAppError(watchError, localeRef.current));
      }
    }, [isAcceptedWatchCurrent, sessionQueue]);

    const handleActiveDocumentWatchEvent = useCallback(
    createWatchEventHandler(deps, {
      enqueueActiveDocumentWatchEnvelope,
      enqueueActiveDocumentWatchHealth }),
    [enqueueActiveDocumentWatchEnvelope, enqueueActiveDocumentWatchHealth]);
  return { enqueueActiveDocumentWatchHealth, handleActiveDocumentWatchEvent };
}

function createWatchEventHandler(
  deps: ExternalChangesDeps,
  enqueueers: {
    enqueueActiveDocumentWatchEnvelope: WatchEnvelopeEnqueuer;
    enqueueActiveDocumentWatchHealth: (
      accepted: AcceptedActiveDocumentWatch,
      event: ActiveDocumentWatchEvent & { event: { kind: 'health' } },
    ) => Promise<void>;
  },
) {
  const { activeDocumentWatchRef } = deps;
  const { enqueueActiveDocumentWatchEnvelope, enqueueActiveDocumentWatchHealth } = enqueueers;
  return (event: ActiveDocumentWatchEvent) => {
      const accepted = activeDocumentWatchRef.current;
      if (!accepted
        || event.watch_id !== accepted.watchId
        || event.document_id !== accepted.documentId
        || event.document_generation !== accepted.documentGeneration
        || event.sequence <= accepted.highestAppliedSequence
        || event.sequence <= accepted.resolvedThroughSequence) {
        return;
      }
      if (event.event.kind === 'health') {
        void enqueueActiveDocumentWatchHealth(accepted, event as ActiveDocumentWatchEvent & {
          event: { kind: 'health' };
        });
        return;
      }
      void enqueueActiveDocumentWatchEnvelope(accepted, {
        protocol_version: event.protocol_version,
        watch_id: event.watch_id,
        document_id: event.document_id,
        document_generation: event.document_generation,
        sequence: event.sequence,
        reason: event.event.reason,
        previous_path: event.event.previous_path,
        snapshot: event.event.snapshot,
      });
    }
  };
