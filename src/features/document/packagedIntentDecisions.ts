import { useCallback, useEffect, useRef } from 'react';
import type { AppOpenIntent } from '../../lib/openIntent';
import type { PackagedOpenAppEventType, PackagedOpenE2eConfig } from '../../lib/tauriCommands';
import { pollPackagedUnicodeReady } from './packagedOpenSteps';

// 打包开箱的脏决策闸门：unicode-rename 就绪轮询 + restore-cancel/discard 自动决策。
// 每个意图只决策一次；等待重命名期间不弹共享脏模态。
function usePackagedUnicodeRenamePoll(
  deps: Parameters<typeof usePackagedIntentDecisions>[0],
  unicodeRenamePending: boolean,
): void {
  useEffect(() => {
    if (!unicodeRenamePending || deps.dirty || deps.unsavedFileSwitchPromptActive) return undefined;
    const pollHandle = pollPackagedUnicodeReady(deps.setOpenConfig);
    return pollHandle.cancel;
  }, [deps.dirty, deps.setOpenConfig, deps.unsavedFileSwitchPromptActive, unicodeRenamePending]);
}

export function packagedUnicodeRenameIsPending(
  pendingOpenIntent: AppOpenIntent | null,
  openConfig: PackagedOpenE2eConfig | null | undefined,
): boolean {
  return pendingOpenIntent?.origin === 'backend'
    && openConfig != null
    && pendingOpenIntent.displayPath === openConfig.paths.unicodeFile
    && !openConfig.unicodeRenameReady;
}

export function usePackagedIntentDecisions(deps: {
  dirty: boolean;
  onCancelFileSwitch: () => void;
  onFileSwitchWithoutSaving: () => void;
  openConfig: PackagedOpenE2eConfig | null | undefined;
  pendingOpenIntent: AppOpenIntent | null;
  setOpenConfig: (config: PackagedOpenE2eConfig) => void;
  unsavedFileSwitchPromptActive: boolean;
}) {
  const automatedDecisionRef = useRef(new Set<string>());
  const intent = deps.pendingOpenIntent;
  const unicodeRenamePending = packagedUnicodeRenameIsPending(deps.pendingOpenIntent, deps.openConfig);
  usePackagedUnicodeRenamePoll(deps, unicodeRenamePending);

  const decideRef = useRef<(config: PackagedOpenE2eConfig) => void>(() => undefined);
  decideRef.current = (config) => {
    if (!intent || intent.origin !== 'backend') return;
    if (automatedDecisionRef.current.has(intent.id)) return;
    automatedDecisionRef.current.add(intent.id);
    if (config.profile === 'restore-cancel' && intent.source === 'session_restore') {
      deps.onCancelFileSwitch();
    } else {
      deps.onFileSwitchWithoutSaving();
    }
  };

  const { openConfig, setOpenConfig, unsavedFileSwitchPromptActive } = deps;
  useEffect(() => {
    if (
      intent?.origin !== 'backend'
      || !openConfig
      || !unsavedFileSwitchPromptActive
      || automatedDecisionRef.current.has(intent.id)
    ) return undefined;
    const waitsForUnicodeRename = intent.displayPath === openConfig.paths.unicodeFile
      && !openConfig.unicodeRenameReady;
    if (!waitsForUnicodeRename) {
      decideRef.current(openConfig);
      return undefined;
    }
    const pollHandle = pollPackagedUnicodeReady((config) => {
      setOpenConfig(config);
      decideRef.current(config);
    });
    return pollHandle.cancel;
  }, [intent, openConfig, setOpenConfig, unsavedFileSwitchPromptActive]);

  return { unicodeRenamePending };
}

export function useOpenIntentDirtyModalHandlers(deps: {
  activeOpenIntentIdRef: React.RefObject<string | null>;
  cancelOpenIntent: () => Promise<void>;
  pendingOpenIntent: AppOpenIntent | null;
  processOpenIntent: (saveBeforeOpen: boolean) => Promise<void>;
  recordEvidence: (
    intent: Extract<AppOpenIntent, { origin: 'backend' }>,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  reportEvidenceFailure: (err: unknown) => void;
}) {
  const recordDirtyDecision = useCallback((decision: 'cancel' | 'discard') => {
    const intent = deps.pendingOpenIntent;
    if (!intent || intent.origin !== 'backend' || deps.activeOpenIntentIdRef.current !== intent.id) return;
    void deps.recordEvidence(intent, 'dirty_decision', { decision })
      .catch(deps.reportEvidenceFailure);
  }, [deps]);

  const handleCancelFileSwitch = useCallback(() => {
    const intent = deps.pendingOpenIntent;
    if (intent && deps.activeOpenIntentIdRef.current === intent.id) {
      recordDirtyDecision('cancel');
      void deps.cancelOpenIntent();
    }
  }, [deps, recordDirtyDecision]);

  const handleFileSwitchWithoutSaving = useCallback(() => {
    const intent = deps.pendingOpenIntent;
    if (intent && deps.activeOpenIntentIdRef.current === intent.id) {
      recordDirtyDecision('discard');
      void deps.processOpenIntent(false);
    }
  }, [deps, recordDirtyDecision]);

  const handleSaveAndSwitchFile = useCallback(async () => {
    if (deps.pendingOpenIntent) {
      await deps.processOpenIntent(true);
    }
  }, [deps]);

  return { handleCancelFileSwitch, handleFileSwitchWithoutSaving, handleSaveAndSwitchFile };
}
