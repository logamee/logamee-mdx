import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import {
  getPackagedOpenE2eConfig,
  recordPackagedOpenAppEvent,
  type PackagedOpenAppEventType,
  type PackagedOpenE2eConfig } from '../../lib/tauriCommands';
import type { AppOpenIntent } from '../../lib/openIntent';
import { isTauriRuntime } from '../../lib/activeDocumentWatch';
import {
  getPackagedOpenStep,
  releasePackagedSettlement,
  runPackagedSettlement,
  type BackendOpenIntent,
  type PackagedEvidenceSession,
  type PendingPackagedSettlement,
  updatePackagedSettlementBarrier } from './packagedOpenSteps';

export { updatePackagedSettlementBarrier } from './packagedOpenSteps';

function usePackagedOpenEvidenceConfig(evidenceEnabled: boolean, isPopout: boolean) {
  const [packagedOpenConfig, setPackagedOpenConfig] = useState<PackagedOpenE2eConfig | null | undefined>(
    () => evidenceEnabled ? undefined : null,
  );
  useEffect(() => {
    if (!evidenceEnabled || isPopout || !isTauriRuntime()) {
      setPackagedOpenConfig(null);
      return;
    }
    let disposed = false;
    void getPackagedOpenE2eConfig().then((config) => {
      if (!disposed) setPackagedOpenConfig(config);
    }).catch(() => {
      if (!disposed) setPackagedOpenConfig(null);
    });
    return () => {
      disposed = true;
    };
  }, [evidenceEnabled, isPopout]);
  return { packagedOpenConfig, setPackagedOpenConfig };
}

export type PackagedEvidenceRecorder = {
  isMounted: () => boolean;
  packagedEvidenceTailRef: React.RefObject<Promise<void>>;
  recordPackagedEvidence: (
    intent: BackendOpenIntent,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  reportPackagedEvidenceFailure: (err: unknown) => void;
};

function usePackagedEvidenceRecorder(
  packagedOpenConfig: PackagedOpenE2eConfig | null | undefined,
  locale: EffectiveLocale,
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
): PackagedEvidenceRecorder {
  const mountedRef = useRef(true);
  const packagedEvidenceTailRef = useRef(Promise.resolve());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const recordPackagedEvidence = useCallback((
    intent: BackendOpenIntent,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    if (!packagedOpenConfig) return Promise.resolve();
    const step = getPackagedOpenStep(intent, packagedOpenConfig);
    if (!step) return Promise.resolve();
    const record = packagedEvidenceTailRef.current
      .catch(() => undefined)
      .then(() => recordPackagedOpenAppEvent({ type, intentId: intent.id, step, fields }));
    packagedEvidenceTailRef.current = record;
    return record;
  }, [packagedOpenConfig]);
  const reportPackagedEvidenceFailure = useCallback((err: unknown) => {
    if (!mountedRef.current) return;
    setError(normalizeAppError(err, locale));
    setNotice(null);
  }, [locale, setError, setNotice]);
  return {
    isMounted: () => mountedRef.current,
    packagedEvidenceTailRef,
    recordPackagedEvidence,
    reportPackagedEvidenceFailure };
}

function usePackagedSettlementBarrier() {
  const [packagedSettlementBarrierActive, setPackagedSettlementBarrierState] = useState(false);
  const packagedSettlementBarrierRef = useRef(false);
  const setPackagedSettlementBarrierActive = useCallback((active: boolean) => {
    updatePackagedSettlementBarrier(
      packagedSettlementBarrierRef,
      setPackagedSettlementBarrierState,
      active,
    );
  }, []);
  return { packagedSettlementBarrierActive, packagedSettlementBarrierRef, setPackagedSettlementBarrierActive };
}

function usePackagedSettlementLifecycle(deps: {
  currentContentRef: React.RefObject<string>;
  onSettlementReleased: () => void;
  packagedOpenConfig: PackagedOpenE2eConfig | null | undefined;
  recorder: PackagedEvidenceRecorder;
  session: PackagedEvidenceSession;
  setPackagedSettlementBarrierActive: (active: boolean) => void;
}) {
  const [pendingPackagedSettlement, setPendingPackagedSettlement] = useState<PendingPackagedSettlement | null>(null);
  const [packagedDirtySeedPending, setPackagedDirtySeedPending] = useState(false);
  const packagedDirtySeededRef = useRef(false);
  const { session, recorder } = deps;
  useEffect(() => {
    const settlement = pendingPackagedSettlement;
    if (!settlement || deps.packagedOpenConfig === undefined) return;
    setPendingPackagedSettlement(null);
    runPackagedSettlement({
      config: deps.packagedOpenConfig,
      currentContentRef: deps.currentContentRef,
      dirtySeededRef: packagedDirtySeededRef,
      isMounted: recorder.isMounted,
      onDirtySeedPending: () => setPackagedDirtySeedPending(true),
      onSettlementReleased: deps.onSettlementReleased,
      record: recorder.recordPackagedEvidence,
      reportFailure: recorder.reportPackagedEvidenceFailure,
      session,
      setBarrier: deps.setPackagedSettlementBarrierActive,
      settlement });
  }, [deps, pendingPackagedSettlement, recorder, session]);

  useEffect(() => {
    if (!packagedDirtySeedPending || !session.dirty) return;
    setPackagedDirtySeedPending(false);
    releasePackagedSettlement(deps.setPackagedSettlementBarrierActive, deps.onSettlementReleased);
  }, [deps, packagedDirtySeedPending, session]);

  return { setPendingPackagedSettlement };
}

function usePackagedIntentEvidence(deps: {
  packagedOpenConfig: PackagedOpenE2eConfig | null | undefined;
  pendingOpenIntent: AppOpenIntent | null;
  recorder: PackagedEvidenceRecorder;
  session: PackagedEvidenceSession;
  unsavedFileSwitchPromptActive: boolean;
}) {
  const activationEvidenceRef = useRef(new Set<string>());
  const modalEvidenceRef = useRef(new Set<string>());
  const { recorder, session } = deps;
  useEffect(() => {
    const intent = deps.pendingOpenIntent;
    if (
      intent?.origin !== 'backend'
      || !deps.packagedOpenConfig
      || activationEvidenceRef.current.has(intent.id)
    ) return;
    activationEvidenceRef.current.add(intent.id);
    void recorder.recordPackagedEvidence(intent, 'app_activated', {
      dirty: session.dirty,
      activeFileBefore: session.activePath }).catch(recorder.reportPackagedEvidenceFailure);
  }, [deps, recorder, session]);

  useEffect(() => {
    const intent = deps.pendingOpenIntent;
    if (
      intent?.origin !== 'backend'
      || !deps.unsavedFileSwitchPromptActive
      || !deps.packagedOpenConfig
      || modalEvidenceRef.current.has(intent.id)
    ) return;
    modalEvidenceRef.current.add(intent.id);
    void recorder.recordPackagedEvidence(intent, 'dirty_modal_opened', {
      modalId: `dirty-${intent.id}` }).catch(recorder.reportPackagedEvidenceFailure);
  }, [deps, recorder]);
}

export function usePackagedOpenEvidence(deps: {
  currentContentRef: React.RefObject<string>;
  evidenceEnabled: boolean;
  isPopout: boolean;
  locale: EffectiveLocale;
  onSettlementReleased: () => void;
  pendingOpenIntent: AppOpenIntent | null;
  session: PackagedEvidenceSession;
  unsavedFileSwitchPromptActive: boolean;
}) {
  const { session } = deps;
  const { setError, setNotice } = session;
  const { packagedOpenConfig, setPackagedOpenConfig } = usePackagedOpenEvidenceConfig(
    deps.evidenceEnabled, deps.isPopout);
  const recorder = usePackagedEvidenceRecorder(
    packagedOpenConfig, deps.locale, setError, setNotice);
  const barrier = usePackagedSettlementBarrier();
  const { setPendingPackagedSettlement } = usePackagedSettlementLifecycle({
    currentContentRef: deps.currentContentRef,
    onSettlementReleased: deps.onSettlementReleased,
    packagedOpenConfig,
    recorder,
    session,
    setPackagedSettlementBarrierActive: barrier.setPackagedSettlementBarrierActive });
  usePackagedIntentEvidence({
    packagedOpenConfig,
    pendingOpenIntent: deps.pendingOpenIntent,
    recorder,
    session,
    unsavedFileSwitchPromptActive: deps.unsavedFileSwitchPromptActive });

  return {
    packagedEvidenceTailRef: recorder.packagedEvidenceTailRef,
    packagedOpenConfig,
    packagedSettlementBarrierActive: barrier.packagedSettlementBarrierActive,
    packagedSettlementBarrierRef: barrier.packagedSettlementBarrierRef,
    recordPackagedEvidence: recorder.recordPackagedEvidence,
    reportPackagedEvidenceFailure: recorder.reportPackagedEvidenceFailure,
    setPackagedOpenConfig,
    setPackagedSettlementBarrierActive: barrier.setPackagedSettlementBarrierActive,
    setPendingPackagedSettlement };
}
