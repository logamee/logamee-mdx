/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useEffect } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { ActiveDocumentWatchEvent } from '../../lib/activeDocumentWatch';
import type { ExternalChangesDeps } from './externalChangesTypes';
import type { WatchEnvelopeEnqueuer } from './externalChangesWatchQueue';
import { startWatchSession } from './externalChangesWatchStart';

export function useExternalChangesWatchEffects(
  deps: ExternalChangesDeps,
  enqueueers: {
    enqueueActiveDocumentWatchEnvelope: WatchEnvelopeEnqueuer;
    handleActiveDocumentWatchEvent: (event: ActiveDocumentWatchEvent) => void;
  },
) {
  const {
    activeDocumentWatchTransport, 
    isPopout, localeRef,
    setError } = deps;
  const { handleActiveDocumentWatchEvent } = enqueueers;

    useEffect(() => {
      if (isPopout || !activeDocumentWatchTransport) return undefined;
      let disposed = false;
      let unlisten: (() => void) | undefined;
      activeDocumentWatchTransport.listen(handleActiveDocumentWatchEvent).then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      }).catch((watchError: unknown) => setError(normalizeAppError(watchError, localeRef.current)));
      return () => {
        disposed = true;
        unlisten?.();
      };
    }, [activeDocumentWatchTransport, handleActiveDocumentWatchEvent, isPopout]);
  useWatchStartEffect(deps, enqueueers.enqueueActiveDocumentWatchEnvelope);
}

function useWatchStartEffect(
  deps: Parameters<typeof useExternalChangesWatchEffects>[0],
  enqueueActiveDocumentWatchEnvelope: WatchEnvelopeEnqueuer,
) {
  const {
    activeDocumentWatchRef, activeDocumentWatchTransport, activePath, activePathRef, authorityStatus,
    documentIdentity, isPopout, 
 } = deps;

  useEffect(() => {
    const request = watchStartRequest(deps);
    if (!request) return undefined;
    const { existing, requestedPath, requestedDocumentId, requestedDocumentGeneration, transport } = request;
    const activeDocumentWatchTransport = transport;
      let disposed = false;
      const startedWatchIdRef = { current: null as string | null };

      const cleanup = buildWatchCleanup({
        activeDocumentWatchRef, activeDocumentWatchTransport, activePathRef,
        requestedDocumentGeneration, requestedDocumentId, requestedPath, startedWatchIdRef });
      if (existingWatchReusable(existing, request)) {
        startedWatchIdRef.current = existing?.watchId ?? null;
        return cleanup;
      }

      launchWatchSession(deps, {
        activeDocumentWatchTransport,
        enqueueActiveDocumentWatchEnvelope,
        isDisposed: () => disposed,
        onWatchIdAssigned: (watchId) => {
          startedWatchIdRef.current = watchId;
        },
        request });

      return cleanup;
    }, [
      activeDocumentWatchTransport,
      activePath,
      authorityStatus,
      documentIdentity.documentId,
      enqueueActiveDocumentWatchEnvelope,
      isPopout,
    ]);

}


function buildWatchCleanup(input: {
  activeDocumentWatchRef: ExternalChangesDeps['activeDocumentWatchRef'];
  activeDocumentWatchTransport: ExternalChangesDeps['activeDocumentWatchTransport'];
  activePathRef: ExternalChangesDeps['activePathRef'];
  requestedDocumentGeneration: number;
  requestedDocumentId: string;
  requestedPath: string;
  startedWatchIdRef: { current: string | null };
}) {
  return () => {
    const current = input.activeDocumentWatchRef.current;
    if (!current || (input.startedWatchIdRef.current && current.watchId !== input.startedWatchIdRef.current)) return;
    const renameHandoff = current.documentId === input.requestedDocumentId
      && current.documentGeneration === input.requestedDocumentGeneration
      && current.path !== input.requestedPath
      && current.path === input.activePathRef.current;
    if (renameHandoff) return;
    input.activeDocumentWatchRef.current = null;
    void input.activeDocumentWatchTransport?.stop(current.watchId).catch(() => false);
  };
}

function watchStartRequest(deps: Parameters<typeof useExternalChangesWatchEffects>[0]) {
  const { activeDocumentWatchRef, activeDocumentWatchTransport, activePath, authorityStatus, documentGenerationRef, documentIdentity, isPopout } = deps;
  if (isPopout
    || !activeDocumentWatchTransport
    || authorityStatus !== 'committed'
    || !activePath) {
    return null;
  }
  return {
    existing: activeDocumentWatchRef.current,
    requestedPath: activePath,
    requestedDocumentId: documentIdentity.documentId,
    requestedDocumentGeneration: documentGenerationRef.current,
    transport: activeDocumentWatchTransport };
}

function existingWatchReusable(
  existing: import('./sessionTypes').AcceptedActiveDocumentWatch | null,
  request: NonNullable<ReturnType<typeof watchStartRequest>>,
): boolean {
  return Boolean(existing
    && existing.documentId === request.requestedDocumentId
    && existing.documentGeneration === request.requestedDocumentGeneration
    && existing.path === request.requestedPath);
}

function launchWatchSession(
  deps: Parameters<typeof useExternalChangesWatchEffects>[0],
  input: {
    activeDocumentWatchTransport: NonNullable<ExternalChangesDeps['activeDocumentWatchTransport']>;
    enqueueActiveDocumentWatchEnvelope: WatchEnvelopeEnqueuer;
    isDisposed: () => boolean;
    onWatchIdAssigned: (watchId: string) => void;
    request: NonNullable<ReturnType<typeof watchStartRequest>>;
  },
) {
  const { activeDocumentWatchRef, activePathRef, documentGenerationRef, externalFileActionRef, localeRef, paneStateRef, setError } = deps;
  const { existing, requestedPath, requestedDocumentId, requestedDocumentGeneration } = input.request;
  void existing;
  void requestedPath;
  void startWatchSession(
    {
      activeDocumentWatchRef,
      activeDocumentWatchTransport: input.activeDocumentWatchTransport,
      activePathRef,
      documentGenerationRef,
      enqueueActiveDocumentWatchEnvelope: input.enqueueActiveDocumentWatchEnvelope,
      externalFileActionRef,
      isDisposed: input.isDisposed,
      localeRef,
      paneStateRef,
      requestedDocumentId,
      requestedDocumentGeneration,
      requestedPath,
      setError },
    input.onWatchIdAssigned);
}
