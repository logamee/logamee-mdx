import type { CrashDraftScheduler, CrashDraftSchedulerOptions, SchedulerState } from './decode';
import { isSafeInteger } from './decode';
import type { CrashDraftSnapshot } from './types';
import {
  clearScheduledTimer,
  flushDraft,
  notifyStateChanged,
  scheduleSnapshotBody,
  seedRevisionBody,
  type SchedulerContext,
} from './scheduler';

// 读侧操作：作废、待写查询、令牌读取/确认与销毁。
function crashDraftReadOps(ctx: SchedulerContext) {
  return {
    confirmDiscarded(documentId: string, expectedEntryToken: string) {
      const state = ctx.states.get(documentId);
      if (!state || state.entryToken !== expectedEntryToken) return;
      state.entryToken = null;
      state.latestIdentity = null;
    },
    dispose() {
      ctx.disposed.current = true;
      for (const state of ctx.states.values()) {
        clearScheduledTimer(state);
        notifyStateChanged(state);
      }
      ctx.states.clear();
    },
    getStoredEntryToken(documentId: string) {
      return ctx.states.get(documentId)?.entryToken ?? null;
    },
    hasPending(documentId: string) {
      const state = ctx.states.get(documentId);
      return Boolean(state && (state.pending !== null || state.inflight || state.ready));
    },
    invalidate(documentId: string) {
      const state = ctx.states.get(documentId);
      if (!state) return;
      state.epoch += 1;
      clearScheduledTimer(state);
      state.pending = null;
      state.firstPendingAt = null;
      state.latestIdentity = null;
      state.ready = false;
      state.failure = { status: 'none' };
      notifyStateChanged(state);
    },
  };
}

// 写侧操作：revision 种子、快照排程与冲刷。
function crashDraftWriteOps(ctx: SchedulerContext) {
  return {
    flush: (documentId: string) => flushDraft(ctx, documentId),
    async flushBefore<T>(documentId: string, action: () => T | Promise<T>): Promise<T> {
      await flushDraft(ctx, documentId);
      return action();
    },
    schedule: (snapshot: CrashDraftSnapshot) => scheduleSnapshotBody(ctx, snapshot),
    seedRevision: (documentId: string, draftRevision: number, entryToken?: string) => (
      seedRevisionBody(ctx, documentId, draftRevision, entryToken)
    ),
  };
}

export function createCrashDraftScheduler(options: CrashDraftSchedulerOptions): CrashDraftScheduler {
  const debounceMs = options.debounceMs ?? 500;
  const maxLatencyMs = options.maxLatencyMs ?? 2000;
  if (!isSafeInteger(debounceMs, 1) || !isSafeInteger(maxLatencyMs, debounceMs)) {
    throw new Error('Invalid crash draft scheduler timing');
  }
  const ctx: SchedulerContext = {
    activeWrite: { current: null },
    debounceMs,
    disposed: { current: false },
    maxLatencyMs,
    now: options.now ?? Date.now,
    options,
    readyQueue: [],
    states: new Map<string, SchedulerState>(),
  };
  return { ...crashDraftReadOps(ctx), ...crashDraftWriteOps(ctx) };
}
