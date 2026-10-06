import {
  getPackagedOpenE2eConfig,
  type PackagedOpenAppEventType,
  type PackagedOpenE2eConfig } from '../../lib/tauriCommands';
import type { AppOpenIntent } from '../../lib/openIntent';

const PACKAGED_UNICODE_READY_POLL_INTERVAL_MS = 50;
const PACKAGED_UNICODE_READY_MAX_ATTEMPTS = 200;
const PACKAGED_DIRTY_SEED = '<!-- mmd-packaged-open-dirty -->';

export interface MutableBooleanRef {
  current: boolean;
}

export type BackendOpenIntent = Extract<AppOpenIntent, { origin: 'backend' }>;

export interface PendingPackagedSettlement {
  intent: BackendOpenIntent;
  status: 'accepted' | 'cancelled' | 'failed';
}

export interface PackagedEvidenceSession {
  activePath: string | null;
  authorityStatus: string;
  dirty: boolean;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  updateContent: (content: string) => void;
  workspaceRoot: string | null;
  workspaceToken: string | null;
}

export function updatePackagedSettlementBarrier(
  barrierRef: MutableBooleanRef,
  setRenderedActive: (active: boolean) => void,
  active: boolean,
): void {
  barrierRef.current = active;
  setRenderedActive(active);
}

export function getPackagedOpenStep(
  intent: BackendOpenIntent,
  config: PackagedOpenE2eConfig,
): string | null {
  if (intent.source === 'session_restore') return 'session-restore';
  const { paths } = config;
  if (intent.displayPath === paths.primaryFile) return 'cli-primary';
  if (intent.displayPath === paths.unicodeFile) return 'cli-secondary-unicode';
  if (intent.displayPath === paths.workspaceDirectory) return 'cli-directory';
  if (intent.displayPath === paths.staleFile) return 'cli-stale';
  if (intent.displayPath === paths.associationFile) return 'file-association';
  return null;
}

function getPackagedSpellcheckEvidence() {
  const realEditors = [...document.querySelectorAll(
    '.editor-pane:not(.popout-pane) .editor-host .cm-content',
  )];
  const enabledRealEditors = realEditors.filter((editor) => editor.getAttribute('spellcheck') === 'true');
  const realEditorSet = new Set(realEditors);
  const enabledNonEditors = [...document.querySelectorAll('[spellcheck="true"]')]
    .filter((element) => !realEditorSet.has(element));
  return {
    realEditorCount: realEditors.length,
    enabledRealEditorCount: enabledRealEditors.length,
    enabledNonEditorCount: enabledNonEditors.length,
    dictionaryConsistency: 'not_claimed' };
}

// 轮询后端的 unicode-rename 就绪标记；瞬时读取失败不得绕过重命名闸门。
export function pollPackagedUnicodeReady(
  onConfig: (config: PackagedOpenE2eConfig) => void,
): { cancel: () => void } {
  let disposed = false;
  let attempts = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const poll = async () => {
    attempts += 1;
    try {
      const config = await getPackagedOpenE2eConfig();
      if (disposed || !config) return;
      if (config.unicodeRenameReady) {
        onConfig(config);
        return;
      }
    } catch {
      // A transient instrumentation read must not bypass the rename gate.
    }
    if (!disposed && attempts < PACKAGED_UNICODE_READY_MAX_ATTEMPTS) {
      timer = globalThis.setTimeout(poll, PACKAGED_UNICODE_READY_POLL_INTERVAL_MS);
    }
  };
  void poll();
  return {
    cancel: () => {
      disposed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    } };
}

export function releasePackagedSettlement(
  setBarrier: (active: boolean) => void,
  onSettlementReleased: () => void,
): void {
  setBarrier(false);
  onSettlementReleased();
}

function packagedSettlementEvidenceFields(
  settlement: PendingPackagedSettlement,
  session: PackagedEvidenceSession,
): Record<string, unknown> {
  return {
    status: settlement.status,
    app: {
      activeFile: session.activePath,
      workspaceRoot: session.workspaceRoot,
      workspaceToken: session.workspaceToken,
      authorityStatus: session.authorityStatus,
      dirty: session.dirty },
    spellcheck: getPackagedSpellcheckEvidence() };
}

export function runPackagedSettlement(deps: {
  config: PackagedOpenE2eConfig | null;
  currentContentRef: React.RefObject<string>;
  dirtySeededRef: React.RefObject<boolean>;
  onDirtySeedPending: () => void;
  onSettlementReleased: () => void;
  isMounted: () => boolean;
  record: (
    intent: BackendOpenIntent,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  reportFailure: (err: unknown) => void;
  session: PackagedEvidenceSession;
  setBarrier: (active: boolean) => void;
  settlement: PendingPackagedSettlement;
}) {
  const { session, settlement } = deps;
  let waitForDirtySeed = false;
  if (!deps.config) {
    releasePackagedSettlement(deps.setBarrier, deps.onSettlementReleased);
    return;
  }
  const packagedStep = getPackagedOpenStep(settlement.intent, deps.config);
  const shouldSeedDirty = settlement.status === 'accepted'
    && settlement.intent.targetKind === 'file'
    && (packagedStep === 'cli-primary' || packagedStep === 'file-association')
    && !deps.dirtySeededRef.current;
  void deps.record(
    settlement.intent,
    'app_settled',
    packagedSettlementEvidenceFields(settlement, session)).then(() => {
    if (!deps.isMounted()) return;
    if (settlement.status === 'failed') {
      session.setError(null);
      session.setNotice(null);
    }
    if (!shouldSeedDirty) return;
    deps.dirtySeededRef.current = true;
    const currentContent = deps.currentContentRef.current;
    session.updateContent(currentContent.includes(PACKAGED_DIRTY_SEED)
      ? currentContent
      : `${currentContent}\n\n${PACKAGED_DIRTY_SEED}`);
    waitForDirtySeed = true;
    deps.onDirtySeedPending();
  }).catch(deps.reportFailure).finally(() => {
    if (!deps.isMounted() || waitForDirtySeed) return;
    releasePackagedSettlement(deps.setBarrier, deps.onSettlementReleased);
  });
}

