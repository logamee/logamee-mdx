import { useCallback, useEffect, useState } from 'react';
import { getPanePopoutButtonState, type PopoutCapablePane } from '../lib/paneLayout';
import { PanePopoutController, PaneWindowAdapter } from '../lib/paneWindow';
import type { PanePopoutOpenOutcome } from '../lib/paneWindow';
import { getPopoutOpenErrorMessage } from '../lib/popoutFeedback';
import { TauriPaneWindowBackend } from '../lib/tauriPaneWindowBackend';
import { useI18n } from '../lib/i18n';

const POP_OUT_PANES: PopoutCapablePane[] = ['editor', 'preview'];
const panePopoutController = new PanePopoutController(new PaneWindowAdapter(new TauriPaneWindowBackend()));

interface UsePanePopoutsInput {
  broadcastPaneState: () => Promise<void>;
  isPopout: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export function usePanePopouts({ broadcastPaneState, isPopout, setError, setNotice }: UsePanePopoutsInput) {
  const { locale } = useI18n();
  const [poppedOutPanes, setPoppedOutPanes] = useState<Set<PopoutCapablePane>>(() => new Set());

  const closePopoutWindows = useCallback(async () => {
    await panePopoutController.closeAll(POP_OUT_PANES);
    setPoppedOutPanes(new Set());
  }, []);

  const updatePopoutState = useCallback((pane: PopoutCapablePane, isOpen: boolean) => {
    setPoppedOutPanes((current) => {
      const next = new Set(current);
      if (isOpen) next.add(pane);
      else next.delete(pane);
      return next;
    });
  }, []);

  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void Promise.all(POP_OUT_PANES.map(async (pane) => {
      const tracking = await panePopoutController.track(pane, () => {
        updatePopoutState(pane, false);
      });
      if (tracking.status === 'failed') {
        if (!disposed) setError(tracking.failure.message);
        return;
      }
      if (disposed) tracking.value.unlisten();
      else {
        updatePopoutState(pane, tracking.value.isOpen);
        unlisteners.push(tracking.value.unlisten);
      }
    }));

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [isPopout, setError, updatePopoutState]);

  const openPanePopout = useCallback(async (
    pane: PopoutCapablePane,
    instanceId?: string,
  ): Promise<PanePopoutOpenOutcome> => {
    setError(null);
    setNotice(null);
    try {
      const outcome = await panePopoutController.open(pane, broadcastPaneState, instanceId);
      if (outcome.status === 'failed') {
        updatePopoutState(pane, false);
        setError(outcome.failure.message);
        return outcome;
      }
      updatePopoutState(pane, true);
      return outcome;
    } catch (err) {
      updatePopoutState(pane, false);
      const message = getPopoutOpenErrorMessage(pane, err, locale);
      setError(message);
      return {
        status: 'failed',
        failure: { operation: 'lookup-window', pane, message },
      };
    }
  }, [broadcastPaneState, locale, setError, setNotice, updatePopoutState]);

  return {
    closePopoutWindows,
    editorPopoutButton: getPanePopoutButtonState('editor', poppedOutPanes.has('editor'), locale),
    openPanePopout,
    previewPopoutButton: getPanePopoutButtonState('preview', poppedOutPanes.has('preview'), locale),
  };
}
