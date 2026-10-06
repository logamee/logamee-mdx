import { useCallback, useEffect, useRef } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import type { OpenIntentCoordinator } from '../../lib/openIntentCoordinator';
import type { AppOpenIntent, LocalOpenIntentAction } from '../../lib/openIntent';
import {
  discardOpenIntent,
  type PackagedOpenAppEventType,
  type PackagedOpenE2eConfig } from '../../lib/tauriCommands';

type CrashDraftPayload = Extract<LocalOpenIntentAction, { kind: 'crash_draft' }>['draft'];
type BackendOpenIntent = Extract<AppOpenIntent, { origin: 'backend' }>;

export interface OpenIntentProcessingSession {
  handleNew: () => Promise<void>;
  settleSessionRestore: () => void;
  handleOpenDirectory: () => Promise<void>;
  handleOpenFile: () => Promise<void>;
  handleOpenRecent: (entryId: string) => Promise<void>;
  openWorkspaceFilePath: (path: string) => Promise<void>;
  openWorkspaceIndexResult: (
    workspaceToken: string,
    workspaceRoot: string,
    indexGeneration: number,
    relativePath: string,
  ) => Promise<void>;
  recoverCrashDraft: (draft: CrashDraftPayload) => Promise<void>;
  resolveOpenIntentRequest: (
    intentId: string,
    targetKind: AppOpenIntent['targetKind'],
    treatDirtyAsBlocked?: boolean,
  ) => Promise<'accepted' | 'blocked' | 'failed'>;
  saveCurrentDocument: () => Promise<boolean>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export interface OpenIntentPackagedBridge {
  evidenceEnabled: boolean;
  evidenceTailRef: React.RefObject<Promise<void>>;
  openConfig: PackagedOpenE2eConfig | null | undefined;
  recordEvidence: (
    intent: BackendOpenIntent,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  reportEvidenceFailure: (err: unknown) => void;
  setOpenConfig: (config: PackagedOpenE2eConfig) => void;
  setSettlementBarrierActive: (active: boolean) => void;
}

async function applyLocalOpenIntentAction(
  action: LocalOpenIntentAction,
  session: OpenIntentProcessingSession,
): Promise<void> {
  if (action.kind === 'new_document') await session.handleNew();
  else if (action.kind === 'open_file') await session.handleOpenFile();
  else if (action.kind === 'open_directory') await session.handleOpenDirectory();
  else if (action.kind === 'open_recent') await session.handleOpenRecent(action.entryId);
  else if (action.kind === 'workspace_file') await session.openWorkspaceFilePath(action.path);
  else if (action.kind === 'workspace_search_result') {
    const { selection } = action;
    await session.openWorkspaceIndexResult(
      selection.workspaceToken,
      selection.workspaceRoot,
      selection.indexGeneration,
      selection.relativePath,
    );
  } else {
    await session.recoverCrashDraft(action.draft);
  }
}

function settleWithCoordinator(
  coordinator: OpenIntentCoordinator,
  intent: AppOpenIntent,
  settlement: 'accepted' | 'cancelled' | 'failed',
  error?: unknown,
): boolean {
  if (settlement === 'accepted') return coordinator.acceptActive(intent.id);
  if (settlement === 'cancelled') return coordinator.cancelActive(intent.id);
  return coordinator.failActive(intent.id, error ?? new Error('Open request failed'));
}

export function useOpenIntentSettlement(deps: {
  coordinator: OpenIntentCoordinator;
  evidenceEnabled: boolean;
  setSettlementBarrierActive: (active: boolean) => void;
}) {
  return useCallback((
    intent: AppOpenIntent,
    settlement: 'accepted' | 'cancelled' | 'failed',
    error?: unknown,
  ) => {
    const deferSuccessor = deps.evidenceEnabled && intent.origin === 'backend';
    if (deferSuccessor) {
      deps.setSettlementBarrierActive(true);
      deps.coordinator.setModalActive(true);
    }
    const settled = settleWithCoordinator(deps.coordinator, intent, settlement, error);
    if (!settled && deferSuccessor) deps.setSettlementBarrierActive(false);
  }, [deps]);
}

interface OpenIntentRunnerDeps {
  dirty: boolean;
  locale: EffectiveLocale;
  openIntentSettlementRef: React.RefObject<Set<string>>;
  packaged: OpenIntentPackagedBridge;
  session: OpenIntentProcessingSession;
  settleOpenIntent: ReturnType<typeof useOpenIntentSettlement>;
}

async function resolveBackendOpenIntent(
  intent: BackendOpenIntent,
  saveBeforeOpen: boolean,
  deps: OpenIntentRunnerDeps,
): Promise<void> {
  const outcome = !saveBeforeOpen && deps.dirty
    ? await deps.session.resolveOpenIntentRequest(intent.id, intent.targetKind, true)
    : await deps.session.resolveOpenIntentRequest(intent.id, intent.targetKind);
  if (outcome === 'accepted') {
    await deps.packaged.recordEvidence(intent, 'app_applied', {
      status: 'accepted',
      targetKind: intent.targetKind });
    deps.settleOpenIntent(intent, 'accepted');
  } else if (outcome === 'blocked') {
    // A concurrent external/save-conflict modal owns the decision for now.
    deps.openIntentSettlementRef.current.delete(intent.id);
  } else {
    deps.settleOpenIntent(intent, 'failed', new Error('The requested file or directory could not be opened.'));
  }
}

async function runOpenIntent(
  intent: AppOpenIntent,
  saveBeforeOpen: boolean,
  deps: OpenIntentRunnerDeps,
): Promise<void> {
  try {
    if (intent.origin === 'backend') await deps.packaged.evidenceTailRef.current;
    if (saveBeforeOpen) {
      const saved = await deps.session.saveCurrentDocument();
      if (!saved) {
        deps.openIntentSettlementRef.current.delete(intent.id);
        return;
      }
      if (intent.origin === 'backend') {
        await deps.packaged.recordEvidence(intent, 'dirty_decision', { decision: 'save' });
      }
    }
    if (intent.origin === 'local') {
      await applyLocalOpenIntentAction(intent.action, deps.session);
      deps.settleOpenIntent(intent, 'accepted');
    } else {
      await resolveBackendOpenIntent(intent, saveBeforeOpen, deps);
    }
  } catch (err) {
    deps.openIntentSettlementRef.current.delete(intent.id);
    deps.session.setError(normalizeAppError(err, deps.locale));
    deps.session.setNotice(null);
    deps.settleOpenIntent(intent, 'failed', err);
  }
}

function openIntentIsActionable(
  intent: AppOpenIntent | null,
  activeOpenIntentIdRef: React.RefObject<string | null>,
  openIntentSettlementRef: React.RefObject<Set<string>>,
): boolean {
  return Boolean(
    intent
    && activeOpenIntentIdRef.current === intent.id
    && !openIntentSettlementRef.current.has(intent.id));
}

export function useOpenIntentExecution(deps: {
  activeOpenIntentIdRef: React.RefObject<string | null>;
  coordinator: OpenIntentCoordinator;
  dirty: boolean;
  isPopout: boolean;
  locale: EffectiveLocale;
  openIntentModalActive: boolean;
  openIntentSettlementRef: React.RefObject<Set<string>>;
  packaged: OpenIntentPackagedBridge;
  pendingOpenIntent: AppOpenIntent | null;
  session: OpenIntentProcessingSession;
  unicodeRenamePending: boolean;
}) {
  const settleOpenIntent = useOpenIntentSettlement({
    coordinator: deps.coordinator,
    evidenceEnabled: deps.packaged.evidenceEnabled,
    setSettlementBarrierActive: deps.packaged.setSettlementBarrierActive });

  const runnerDepsRef = useRef<OpenIntentRunnerDeps | null>(null);
  runnerDepsRef.current = {
    dirty: deps.dirty,
    locale: deps.locale,
    openIntentSettlementRef: deps.openIntentSettlementRef,
    packaged: deps.packaged,
    session: deps.session,
    settleOpenIntent };

  const processOpenIntent = useCallback(async (saveBeforeOpen: boolean): Promise<void> => {
    const intent = deps.pendingOpenIntent;
    if (!intent || !openIntentIsActionable(intent, deps.activeOpenIntentIdRef, deps.openIntentSettlementRef)) return;
    deps.openIntentSettlementRef.current.add(intent.id);
    await runOpenIntent(intent, saveBeforeOpen, runnerDepsRef.current as OpenIntentRunnerDeps);
  }, [deps]);

  const cancelOpenIntent = useOpenIntentCancellation(deps, settleOpenIntent);
  useOpenIntentAutoProcess(deps, processOpenIntent);

  return { cancelOpenIntent, processOpenIntent, settleOpenIntent };
}

function useOpenIntentAutoProcess(
  deps: Parameters<typeof useOpenIntentExecution>[0],
  processOpenIntent: (saveBeforeOpen: boolean) => Promise<void>,
): void {
  useEffect(() => {
    // A clean document can accept an active request without showing a dialog. Dirty
    // requests remain active until one of the explicit save/switch/cancel actions runs.
    if (
      deps.isPopout
      || !deps.pendingOpenIntent
      || deps.dirty
      || deps.openIntentModalActive
      || deps.unicodeRenamePending
      || deps.openIntentSettlementRef.current.has(deps.pendingOpenIntent.id)
    ) return;
    void processOpenIntent(false);
  }, [deps, processOpenIntent]);
}

function useOpenIntentCancellation(
  deps: Parameters<typeof useOpenIntentExecution>[0],
  settleOpenIntent: ReturnType<typeof useOpenIntentSettlement>,
) {
  return useCallback(async (): Promise<void> => {
    const intent = deps.pendingOpenIntent;
    if (!intent || !openIntentIsActionable(intent, deps.activeOpenIntentIdRef, deps.openIntentSettlementRef)) return;
    deps.openIntentSettlementRef.current.add(intent.id);
    try {
      if (intent.origin === 'backend' && typeof discardOpenIntent === 'function') {
        await deps.packaged.evidenceTailRef.current;
        await discardOpenIntent(intent.id);
      }
      if (intent.origin === 'backend' && intent.targetKind === 'session_restore') deps.session.settleSessionRestore();
      settleOpenIntent(intent, 'cancelled');
    } catch (err) {
      deps.openIntentSettlementRef.current.delete(intent.id);
      deps.session.setError(normalizeAppError(err, deps.locale));
      deps.session.setNotice(null);
    }
  }, [deps, settleOpenIntent]);
}
