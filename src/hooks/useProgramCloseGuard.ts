import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect } from 'react';
import { shouldBlockProgramCloseOnPopoutCloseFailure, shouldPreventDefaultProgramClose } from '../lib/closeGuard';
import { normalizeAppError } from '../lib/appFeedback';

interface UseProgramCloseGuardInput {
  closePopoutWindows: () => Promise<void>;
  dirty: boolean;
  flushWorkspaceSession: () => Promise<void>;
  isPopout: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setShowUnsavedExitPrompt: (show: boolean) => void;
}

export function useProgramCloseGuard({ closePopoutWindows, dirty, flushWorkspaceSession, isPopout, setError, setNotice, setShowUnsavedExitPrompt }: UseProgramCloseGuardInput) {
  const cleanupPopoutsBeforeDefaultClose = useCallback(async () => {
    const closeTimeout = new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    await Promise.race([closePopoutWindows(), closeTimeout]);
  }, [closePopoutWindows]);

  const flushWorkspaceSessionBeforeClose = useCallback(async () => {
    if (isPopout) return;
    await flushWorkspaceSession();
  }, [flushWorkspaceSession, isPopout]);

  const forceCloseProgram = useCallback(async () => {
    await flushWorkspaceSessionBeforeClose();
    await cleanupPopoutsBeforeDefaultClose();
    await getCurrentWindow().destroy();
  }, [cleanupPopoutsBeforeDefaultClose, flushWorkspaceSessionBeforeClose]);

  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async (event) => {
      if (shouldPreventDefaultProgramClose({ dirty, isPopout })) {
        event.preventDefault();
        setError(null);
        setNotice(null);
        setShowUnsavedExitPrompt(true);
        return;
      }

      // Do not prevent the event here: Tauri's onCloseRequested wrapper
      // destroys the current window after the handler resolves.
      try {
        await flushWorkspaceSessionBeforeClose();
      } catch (err) {
        event.preventDefault();
        setError(normalizeAppError(err));
        return;
      }
      try {
        await cleanupPopoutsBeforeDefaultClose();
      } catch (err) {
        if (shouldBlockProgramCloseOnPopoutCloseFailure()) {
          event.preventDefault();
          setError(normalizeAppError(err));
        }
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [cleanupPopoutsBeforeDefaultClose, dirty, flushWorkspaceSessionBeforeClose, isPopout, setError, setNotice, setShowUnsavedExitPrompt]);

  useEffect(() => {
    if (!dirty) setShowUnsavedExitPrompt(false);
  }, [dirty, setShowUnsavedExitPrompt]);

  return { forceCloseProgram };
}
