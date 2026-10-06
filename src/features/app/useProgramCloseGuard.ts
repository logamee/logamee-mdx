import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect } from 'react';
import { shouldBlockProgramCloseOnPopoutCloseFailure, shouldPreventDefaultProgramClose } from '../../lib/closeGuard';
import { normalizeAppError } from '../../lib/appFeedback';

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

  useCloseRequestListener({
    cleanupPopoutsBeforeDefaultClose,
    dirty,
    flushWorkspaceSessionBeforeClose,
    isPopout,
    setError,
    setNotice,
    setShowUnsavedExitPrompt,
  });

  useEffect(() => {
    if (!dirty) setShowUnsavedExitPrompt(false);
  }, [dirty, setShowUnsavedExitPrompt]);

  return { forceCloseProgram };
}

// 关闭请求监听：脏文档先弹未保存提示；否则冲刷会话与清理弹窗后放行。
function useCloseRequestListener(deps: {
  cleanupPopoutsBeforeDefaultClose: () => Promise<void>;
  dirty: boolean;
  flushWorkspaceSessionBeforeClose: () => Promise<void>;
  isPopout: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setShowUnsavedExitPrompt: (show: boolean) => void;
}): void {
  const { cleanupPopoutsBeforeDefaultClose, dirty, flushWorkspaceSessionBeforeClose } = deps;
  const { isPopout, setError, setNotice, setShowUnsavedExitPrompt } = deps;
  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(handleCloseRequest({
      cleanupPopoutsBeforeDefaultClose,
      dirty,
      flushWorkspaceSessionBeforeClose,
      isPopout,
      setError,
      setNotice,
      setShowUnsavedExitPrompt,
    })).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [cleanupPopoutsBeforeDefaultClose, dirty, flushWorkspaceSessionBeforeClose, isPopout, setError, setNotice, setShowUnsavedExitPrompt]);
}

// 关闭请求处理器：脏文档提示；否则冲刷会话与清理弹窗，失败按平台门禁拦截。
function handleCloseRequest(deps: {
  cleanupPopoutsBeforeDefaultClose: () => Promise<void>;
  dirty: boolean;
  flushWorkspaceSessionBeforeClose: () => Promise<void>;
  isPopout: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setShowUnsavedExitPrompt: (show: boolean) => void;
}): (event: { preventDefault: () => void }) => Promise<void> {
  return async (event) => {
    if (shouldPreventDefaultProgramClose({ dirty: deps.dirty, isPopout: deps.isPopout })) {
      event.preventDefault();
      deps.setError(null);
      deps.setNotice(null);
      deps.setShowUnsavedExitPrompt(true);
      return;
    }

    // Do not prevent the event here: Tauri's onCloseRequested wrapper
    // destroys the current window after the handler resolves.
    try {
      await deps.flushWorkspaceSessionBeforeClose();
    } catch (err) {
      event.preventDefault();
      deps.setError(normalizeAppError(err));
      return;
    }
    try {
      await deps.cleanupPopoutsBeforeDefaultClose();
    } catch (err) {
      if (shouldBlockProgramCloseOnPopoutCloseFailure()) {
        event.preventDefault();
        deps.setError(normalizeAppError(err));
      }
    }
  };
}
