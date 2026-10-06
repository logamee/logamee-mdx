import type { RefObject } from 'react';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import {
  discardOpenReceipt,
  getOpenCommitStatus,
  commitRecentOpen,
 } from '../../lib/tauriCommands';
import type { DocumentSessionState } from '../../lib/documentSession';
import type { FileVersion, OpenFileResponse, PreparedOpenFileResponse } from '../../types';

import {
  createProvisionalDocumentTransition,
  resolveOpenCommitOutcome,
  restoreDocumentSnapshot } from '../../lib/documentSession';


export type PreparedOpenApplyResult = 'committed' | 'not_committed' | 'stale' | 'indeterminate';

export interface PreparedOpenApplyDeps {
  activeFileVersionRef: RefObject<FileVersion | null>;
  advanceCrashDraftIdentity: (priorDocumentId: string) => void;
  afterConfirmedSave?: (documentId: string) => Promise<boolean>;
  applyDocumentSessionState: (state: DocumentSessionState) => void;
  crashDraftDocumentIdRef: RefObject<string>;
  crashDraftSchedulerRef: RefObject<{ flush: (id: string) => Promise<void> } | null>;
  currentDocumentSessionState: () => DocumentSessionState;
  documentGenerationRef: RefObject<number>;
  reportFailure?: boolean;
  editableFileVersion: (file: OpenFileResponse) => FileVersion | null;
  setError: (message: string | null) => void;
}

// 已备打开的落盘：冲崩溃草稿 → 临时态 → 提交/未提交/不确定三向结局。
export async function applyPreparedOpenBody(
  prepared: PreparedOpenFileResponse,
  requestedGeneration: number,
  deps: PreparedOpenApplyDeps,
  options: { reportFailure?: boolean; discardCurrentCrashDraft?: boolean } = {},
): Promise<PreparedOpenApplyResult> {
  const { reportFailure = true, discardCurrentCrashDraft = false } = options;
  const priorCrashDocumentId = deps.crashDraftDocumentIdRef.current;
  try {
    await deps.crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
  } catch {
    await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
    if (reportFailure) deps.setError('The recovery draft could not be saved. The current document remains open.');
    return 'not_committed';
  }
  const prior = deps.currentDocumentSessionState();
  const priorVersion = deps.activeFileVersionRef.current;
  const transition = createProvisionalDocumentTransition(
    prior,
    prepared.file,
    {
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: prior.documentEpoch + 1,
    },
  );
  deps.applyDocumentSessionState(transition.provisional);

  const outcome = await resolveOpenCommitOutcome(prepared, {
    commit: commitRecentOpen,
    getStatus: getOpenCommitStatus,
  });
  if (deps.documentGenerationRef.current !== requestedGeneration) return 'stale';

  return await applyCommitOutcome(outcome, deps, transition, {
    discardCurrentCrashDraft,
    priorCrashDocumentId,
    priorVersion,
    prepared,
    reportFailure,
  });
}


async function applyCommitOutcome(
  outcome: Awaited<ReturnType<typeof resolveOpenCommitOutcome>>,
  deps: PreparedOpenApplyDeps,
  transition: ReturnType<typeof createProvisionalDocumentTransition>,
  ctx: {
    discardCurrentCrashDraft: boolean;
    priorCrashDocumentId: string;
    priorVersion: FileVersion | null;
    prepared: PreparedOpenFileResponse;
    reportFailure: boolean;
  },
): Promise<PreparedOpenApplyResult> {
  if (outcome.status === 'committed') return await commitApplied(deps, transition, ctx);
  if (outcome.status === 'not_committed') return await commitRejected(deps, transition, ctx, outcome.message);
  deps.applyDocumentSessionState({
    ...transition.provisional,
    authorityStatus: 'unknown',
  });
  deps.activeFileVersionRef.current = ctx.priorVersion;
  if (ctx.reportFailure) {
    deps.setError('The file authorization result could not be confirmed. Open another file to continue.');
  }
  return 'indeterminate';
}

async function commitApplied(
  deps: PreparedOpenApplyDeps,
  transition: ReturnType<typeof createProvisionalDocumentTransition>,
  ctx: {
    discardCurrentCrashDraft: boolean;
    priorCrashDocumentId: string;
    prepared: PreparedOpenFileResponse;
  },
): Promise<PreparedOpenApplyResult> {
  deps.applyDocumentSessionState({
    ...transition.provisional,
    authorityStatus: 'committed',
  });
  deps.activeFileVersionRef.current = deps.editableFileVersion(ctx.prepared.file);
  deps.advanceCrashDraftIdentity(ctx.priorCrashDocumentId);
  if (ctx.discardCurrentCrashDraft) await deps.afterConfirmedSave?.(ctx.priorCrashDocumentId);
  return 'committed';
}

function commitRejected(
  deps: PreparedOpenApplyDeps,
  transition: ReturnType<typeof createProvisionalDocumentTransition>,
  ctx: { priorVersion: FileVersion | null; reportFailure: boolean },
  message: string,
): PreparedOpenApplyResult {
  try {
    deps.applyDocumentSessionState(restoreDocumentSnapshot(transition.prior));
    deps.activeFileVersionRef.current = ctx.priorVersion;
  } catch {
    deps.applyDocumentSessionState({
      ...transition.provisional,
      authorityStatus: 'failed',
    });
    deps.activeFileVersionRef.current = ctx.priorVersion;
  }
  if (ctx.reportFailure) deps.setError(message);
  return 'not_committed';
}
