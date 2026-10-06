import { useEffect } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import { isTauriRuntime } from '../../lib/activeDocumentWatch';
import { adaptBackendOpenIntent } from '../../lib/openIntent';
import type { OpenIntentCoordinator } from '../../lib/openIntentCoordinator';
import { peekOpenIntent, type PackagedOpenE2eConfig } from '../../lib/tauriCommands';
import { syncOpenIntentCoordinatorModalState } from './appOpenIntentModalSync';

export function useOpenIntentPeek(deps: {
  coordinator: OpenIntentCoordinator;
  evidenceEnabled: boolean;
  isPopout: boolean;
  locale: EffectiveLocale;
  modalActive: boolean;
  openConfig: PackagedOpenE2eConfig | null | undefined;
  pollRevision: number;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}): void {
  useEffect(() => {
    if (
      deps.isPopout
      || !isTauriRuntime()
      || typeof peekOpenIntent !== 'function'
      || (deps.evidenceEnabled && deps.openConfig === undefined)
      || deps.modalActive
    ) return undefined;
    let disposed = false;
    void Promise.resolve().then(() => peekOpenIntent()).then((preview) => {
      if (disposed) return;
      if (preview) deps.coordinator.enqueue(adaptBackendOpenIntent(preview));
    }).catch((err: unknown) => {
      if (disposed) return;
      deps.setError(normalizeAppError(err, deps.locale));
      deps.setNotice(null);
    });
    return () => {
      disposed = true;
    };
  }, [deps]);
}

export function useOpenIntentModalSync(deps: {
  barrierRef: { current: boolean };
  coordinator: OpenIntentCoordinator;
  modalActive: boolean;
}): void {
  const { barrierRef, coordinator, modalActive } = deps;
  useEffect(() => {
    syncOpenIntentCoordinatorModalState(coordinator, modalActive, barrierRef);
  }, [barrierRef, coordinator, modalActive]);
}
