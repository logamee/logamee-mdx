import { useCallback } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';

// 未保存退出与反馈关闭动作：保存后退出、直接退出、取消，以及反馈对话框关闭。
export function useAppExitFlows(deps: {
  forceCloseProgram: () => Promise<void>;
  locale: EffectiveLocale;
  saveCurrentDocument: () => Promise<boolean>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setShowUnsavedExitPrompt: (show: boolean) => void;
}) {
  const { forceCloseProgram, locale, saveCurrentDocument, setError, setNotice, setShowUnsavedExitPrompt } = deps;
  const closeAfter = useCallback(async (action: () => Promise<boolean>) => {
    if (!await action()) return;
    setShowUnsavedExitPrompt(false);
    void forceCloseProgram().catch((err: unknown) => setError(normalizeAppError(err, locale)));
  }, [forceCloseProgram, locale, setError, setShowUnsavedExitPrompt]);

  const handleSaveAndQuit = useCallback(
    () => closeAfter(() => saveCurrentDocument()),
    [closeAfter, saveCurrentDocument]);

  const handleCancelExit = useCallback(() => {
    setShowUnsavedExitPrompt(false);
  }, [setShowUnsavedExitPrompt]);

  const handleQuitWithoutSaving = useCallback(
    () => closeAfter(async () => true),
    [closeAfter]);

  const dismissFeedbackDialog = useCallback(() => {
    setError(null);
    setNotice(null);
  }, [setError, setNotice]);

  return { dismissFeedbackDialog, handleCancelExit, handleQuitWithoutSaving, handleSaveAndQuit };
}
