import { useCallback, useMemo, useRef } from 'react';
import { getFeedbackDialog } from '../../lib/appFeedback';
import { crashDraftCommands } from '../../lib/crashDraftCommands';
import { useDocumentSession } from './useDocumentSession';
import { useCrashDraftRecovery } from './useCrashDraftRecovery';
import type { LocalOpenIntentAction } from '../../lib/openIntent';
import type { AutosaveMode } from '../../types';


export interface AppSessionContextDeps {
  enqueueCrashDraftIntent: (
    source: 'crash_recovery',
    displayPath: string,
    action: Extract<LocalOpenIntentAction, { kind: 'crash_draft' }>,
  ) => void;
  isPopout: boolean;
  locale: Parameters<typeof getFeedbackDialog>[1];
  popoutPane: 'editor' | 'main' | 'preview';
  settings: {
    autosaveEnabled: boolean;
    autosaveDelayMs: number;
    autosaveMode: AutosaveMode;
  } | null;
}

// 文档会话上下文：useDocumentSession 全量结果 + 崩溃草稿恢复 + 反馈对话框派生。
// 调用方以 session.xxx 访问，避免在 App 中维护 60+ 行解构。
export function useAppSessionContext(deps: AppSessionContextDeps) {
  const afterConfirmedCrashDraftSaveRef = useRef<((documentId: string) => Promise<boolean>) | null>(null);
  const afterConfirmedCrashDraftSave = useCallback((documentId: string) => (
    afterConfirmedCrashDraftSaveRef.current?.(documentId) ?? Promise.resolve(true)
  ), []);

  const session = useDocumentSession({
    isPopout: deps.isPopout,
    popoutPane: deps.popoutPane,
    autosaveEnabled: deps.settings?.autosaveEnabled ?? false,
    autosaveDelayMs: deps.settings?.autosaveDelayMs ?? 1500,
    autosaveMode: deps.settings?.autosaveMode ?? 'afterDelay',
    afterConfirmedSave: afterConfirmedCrashDraftSave });

  const crashDraftRecovery = useCrashDraftRecovery({
    enabled: false,
    commands: crashDraftCommands,
    onRecoverDraft: (draft: Parameters<typeof session.recoverCrashDraft>[0]) => deps.enqueueCrashDraftIntent(
      'crash_recovery',
      draft.pathHint ?? draft.documentId,
      { kind: 'crash_draft', draft }),
    seedRevision: session.seedCrashDraftRevision,
    getStoredEntryToken: session.getCrashDraftStoredEntryToken,
    confirmDiscarded: session.confirmCrashDraftDiscarded });
  afterConfirmedCrashDraftSaveRef.current = crashDraftRecovery.afterConfirmedSave;

  const feedbackDialog = useMemo(
    () => getFeedbackDialog({ error: session.error, notice: session.notice }, deps.locale),
    [deps.locale, session.error, session.notice]);

  return { crashDraftRecovery, feedbackDialog, session };
}
