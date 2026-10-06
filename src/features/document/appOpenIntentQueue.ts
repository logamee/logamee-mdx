import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import { isTauriRuntime } from '../../lib/activeDocumentWatch';
import {
  createLocalOpenIntent,
  OPEN_INTENT_FOCUS_EVENT,
  OPEN_INTENT_PENDING_EVENT,
  type AppOpenIntent,
  type LocalOpenIntentAction,
  type LocalOpenIntentSource } from '../../lib/openIntent';
import { OpenIntentCoordinator } from '../../lib/openIntentCoordinator';
import {
  focusMainWindow,
  peekOpenIntent,
  requestSessionRestore } from '../../lib/tauriCommands';

export interface OpenIntentQueueSession {
  settleSessionRestore: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

// 打开意图队列核心：coordinator、pending 状态与后端事件轮询。
// packagedSettlementSink 在渲染期由调用方注入（打包证据钩子的 setState 稳定）。

function createOpenIntentCoordinator(handles: {
  activeOpenIntentIdRef: React.RefObject<string | null>;
  bumpPollRevision: () => void;
  evidenceEnabled: boolean;
  openIntentSettlementRef: React.RefObject<Set<string>>;
  packagedSettlementSinkRef: React.RefObject<((settlement: {
    intent: Extract<AppOpenIntent, { origin: 'backend' }>;
    status: 'accepted' | 'cancelled' | 'failed';
  }) => void) | null>;
  setPendingOpenIntent: React.Dispatch<React.SetStateAction<AppOpenIntent | null>>;
}): OpenIntentCoordinator {
  return new OpenIntentCoordinator({
    onActivate: (intent) => {
      handles.activeOpenIntentIdRef.current = intent.id;
      handles.setPendingOpenIntent(intent);
      if (intent.origin === 'backend') void focusMainWindow(intent.id, false).catch(() => undefined);
    },
    onSettle: (intent, settlement) => {
      if (handles.activeOpenIntentIdRef.current === intent.id) handles.activeOpenIntentIdRef.current = null;
      handles.openIntentSettlementRef.current.delete(intent.id);
      if (intent.origin === 'backend' && handles.evidenceEnabled) {
        handles.packagedSettlementSinkRef.current?.({ intent, status: settlement.kind });
      } else {
        handles.bumpPollRevision();
      }
      handles.setPendingOpenIntent((current) => current?.id === intent.id ? null : current);
    } });
}

function useLocalOpenIntentEnqueue(
  openIntentCoordinator: OpenIntentCoordinator,
  sequenceRef: React.RefObject<number>,
) {
  return useCallback((
    source: LocalOpenIntentSource,
    displayPath: string,
    action: LocalOpenIntentAction,
  ) => {
    sequenceRef.current += 1;
    openIntentCoordinator.enqueue(createLocalOpenIntent(
      `local-open-intent-${sequenceRef.current}`,
      source,
      displayPath,
      action,
    ));
  }, [openIntentCoordinator, sequenceRef]);
}

function useOpenIntentBackendEvents(
  deps: Parameters<typeof useOpenIntentQueue>[0],
  refs: {
    activeOpenIntentIdRef: React.RefObject<string | null>;
    bumpPollRevision: () => void;
    sessionRestoreRequestStateRef: React.MutableRefObject<'pending' | 'requested' | 'failed'>;
  },
): void {
  useEffect(() => {
    if (deps.isPopout || !isTauriRuntime() || typeof peekOpenIntent !== 'function') return undefined;
    return registerOpenIntentBackendEvents({
      activeOpenIntentIdRef: refs.activeOpenIntentIdRef,
      bumpPollRevision: refs.bumpPollRevision,
      locale: deps.locale,
      mountedRef: deps.mountedRef,
      session: deps.session,
      sessionRestoreRequestStateRef: refs.sessionRestoreRequestStateRef });
  }, [deps, refs]);
}

export function useOpenIntentQueue(deps: {
  evidenceEnabled: boolean;
  isPopout: boolean;
  locale: EffectiveLocale;
  mountedRef: React.RefObject<boolean>;
  session: OpenIntentQueueSession;
}) {
  const [pendingOpenIntent, setPendingOpenIntent] = useState<AppOpenIntent | null>(null);
  const [openIntentPollRevision, setOpenIntentPollRevision] = useState(0);
  const activeOpenIntentIdRef = useRef<string | null>(null);
  const localOpenIntentSequenceRef = useRef(0);
  const openIntentSettlementRef = useRef(new Set<string>());
  const sessionRestoreRequestStateRef = useRef<'pending' | 'requested' | 'failed'>('pending');
  const packagedSettlementSinkRef = useRef<
    ((settlement: {
      intent: Extract<AppOpenIntent, { origin: 'backend' }>;
      status: 'accepted' | 'cancelled' | 'failed';
    }) => void) | null
  >(null);

  const bumpPollRevision = useCallback(() => {
    setOpenIntentPollRevision((revision) => revision + 1);
  }, []);

  const coordinatorRef = useRef<OpenIntentCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createOpenIntentCoordinator({
      activeOpenIntentIdRef,
      evidenceEnabled: deps.evidenceEnabled,
      openIntentSettlementRef,
      packagedSettlementSinkRef,
      bumpPollRevision,
      setPendingOpenIntent });
  }
  const openIntentCoordinator = coordinatorRef.current;

  const enqueueLocalOpenIntent = useLocalOpenIntentEnqueue(openIntentCoordinator, localOpenIntentSequenceRef);
  useOpenIntentBackendEvents(deps, {
    activeOpenIntentIdRef,
    bumpPollRevision,
    sessionRestoreRequestStateRef });

  return {
    activeOpenIntentIdRef, bumpPollRevision, enqueueLocalOpenIntent, openIntentCoordinator,
    openIntentPollRevision, openIntentSettlementRef, packagedSettlementSinkRef, pendingOpenIntent };
}

interface BackendEventRegistration {
  activeOpenIntentIdRef: React.RefObject<string | null>;
  bumpPollRevision: () => void;
  locale: EffectiveLocale;
  mountedRef: React.RefObject<boolean>;
  session: OpenIntentQueueSession;
  sessionRestoreRequestStateRef: React.MutableRefObject<'pending' | 'requested' | 'failed'>;
}

function registerOpenIntentBackendEvents(reg: BackendEventRegistration): () => void {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  Promise.all([
    listen<unknown>(OPEN_INTENT_PENDING_EVENT, () => {
      if (!disposed) reg.bumpPollRevision();
    }),
    listen<unknown>(OPEN_INTENT_FOCUS_EVENT, () => {
      if (!disposed) {
        void focusMainWindow(reg.activeOpenIntentIdRef.current ?? undefined, true).catch(() => undefined);
      }
    }),
  ]).then((cleanups) => {
    if (disposed) cleanups.forEach((cleanup) => cleanup());
    else {
      unlisteners.push(...cleanups);
      requestSessionRestoreWhenReady(reg);
    }
  }).catch((err: unknown) => {
    if (disposed) return;
    if (reg.sessionRestoreRequestStateRef.current === 'pending') {
      reg.sessionRestoreRequestStateRef.current = 'failed';
      reg.session.settleSessionRestore();
    }
    reg.session.setError(normalizeAppError(err, reg.locale));
    reg.session.setNotice(null);
  });
  return () => {
    disposed = true;
    unlisteners.forEach((unlisten) => unlisten());
  };
}

function requestSessionRestoreWhenReady(reg: BackendEventRegistration): void {
  if (reg.sessionRestoreRequestStateRef.current !== 'pending') return;
  reg.sessionRestoreRequestStateRef.current = 'requested';
  void requestSessionRestore().then((restoreRequested) => {
    if (!restoreRequested) reg.session.settleSessionRestore();
    if (reg.mountedRef.current) reg.bumpPollRevision();
  }).catch((err: unknown) => {
    reg.sessionRestoreRequestStateRef.current = 'failed';
    reg.session.settleSessionRestore();
    if (reg.mountedRef.current) {
      reg.session.setError(normalizeAppError(err, reg.locale));
      reg.session.setNotice(null);
    }
  });
}
