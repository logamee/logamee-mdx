import type { CrashDraftSnapshot } from './types';
import {
  decodeCrashDraftWriteResponse,
  hasValidPathAndBase,
  isDocumentId,
  isFileKind,
  isSafeInteger,
  isToken,
} from './decode';
import type { CrashDraftSchedulerOptions, SchedulerState } from './decode';

export interface SchedulerContext {
  activeWrite: { current: Promise<void> | null };
  debounceMs: number;
  disposed: { current: boolean };
  maxLatencyMs: number;
  now: () => number;
  options: CrashDraftSchedulerOptions;
  readyQueue: Array<{ documentId: string; epoch: number }>;
  states: Map<string, SchedulerState>;
}

function sameSnapshot(left: CrashDraftSnapshot | null, right: CrashDraftSnapshot): boolean {
  return left !== null
    && left.documentId === right.documentId
    && left.fileKind === right.fileKind
    && left.pathHint === right.pathHint
    && left.baseVersionToken === right.baseVersionToken
    && left.content === right.content;
}

function validateSnapshot(snapshot: CrashDraftSnapshot): void {
  if (
    !isDocumentId(snapshot.documentId)
    || !isFileKind(snapshot.fileKind)
    || !hasValidPathAndBase(snapshot.pathHint, snapshot.baseVersionToken)
    || typeof snapshot.content !== 'string'
  ) throw new Error('Invalid crash draft snapshot');
}

// 会话是否仍然活跃：未销毁、状态未被替换且世代一致。
function schedulerActive(
  ctx: SchedulerContext,
  documentId: string,
  state: SchedulerState,
  epoch: number,
): boolean {
  return !ctx.disposed.current
    && ctx.states.get(documentId) === state
    && state.epoch === epoch;
}

export function clearScheduledTimer(state: SchedulerState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
}

export function notifyStateChanged(state: SchedulerState): void {
  for (const resolve of state.waiters) resolve();
  state.waiters.clear();
}

function throwStoredFailure(state: SchedulerState): void {
  if (state.failure.status === 'failed') throw state.failure.error;
}

// 从就绪队列取出首个仍然有效的会话（未被作废且仍有待写请求）。
function takeReadyState(ctx: SchedulerContext): {
  documentId: string; state: SchedulerState;
} | null {
  let queued: { documentId: string; epoch: number } | undefined;
  let state: SchedulerState | undefined;
  while ((queued = ctx.readyQueue.shift()) !== undefined) {
    const candidate = ctx.states.get(queued.documentId);
    if (candidate?.ready && candidate.pending && candidate.epoch === queued.epoch) {
      state = candidate;
      break;
    }
  }
  if (!queued || !state || !state.pending) return null;
  return { documentId: queued.documentId, state };
}

// 写入回执落账：记录条目令牌并清空被驱逐文档的令牌。
function applyWriteResponse(
  ctx: SchedulerContext,
  state: SchedulerState,
  request: { documentId: string; draftRevision: number },
  response: { entryToken: string | null; evictedDocumentIds: string[] },
): void {
  state.entryToken = response.entryToken;
  for (const evictedDocumentId of response.evictedDocumentIds) {
    const evicted = ctx.states.get(evictedDocumentId);
    if (evicted) evicted.entryToken = null;
  }
}

// 写入失败回退：会话仍活跃且无新请求时，把请求重新挂起并登记失败。
function stageWriteFailure(
  ctx: SchedulerContext,
  documentId: string,
  state: SchedulerState,
  request: SchedulerState['pending'],
  epoch: number,
  error: unknown,
): void {
  if (!schedulerActive(ctx, documentId, state, epoch) || state.pending !== null) return;
  state.pending = request;
  state.firstPendingAt = ctx.now();
  state.failure = {
    status: 'failed',
    error: error ? error : new Error('Crash draft write failed'),
  };
}

async function runWriteCycle(
  ctx: SchedulerContext,
  documentId: string,
  state: SchedulerState,
  request: NonNullable<SchedulerState['pending']>,
  epoch: number,
): Promise<void> {
  try {
    const response = decodeCrashDraftWriteResponse(await ctx.options.write(request));
    if (response.documentId !== request.documentId || response.draftRevision !== request.draftRevision) {
      throw new Error('Crash draft write response did not match request');
    }
    applyWriteResponse(ctx, state, request, response);
  } catch (error) {
    stageWriteFailure(ctx, documentId, state, request, epoch, error);
  } finally {
    state.inflight = false;
    ctx.activeWrite.current = null;
    notifyStateChanged(state);
    pumpWrite(ctx);
  }
}

// 泵：空闲时从就绪队列取一个会话串行落盘（全局单写并发）。
function pumpWrite(ctx: SchedulerContext): void {
  if (ctx.disposed.current || ctx.activeWrite.current) return;
  const readied = takeReadyState(ctx);
  if (!readied) return;

  const { documentId, state } = readied;
  const request = state.pending!;
  const epoch = state.epoch;
  state.pending = null;
  state.firstPendingAt = null;
  state.ready = false;
  state.inflight = true;
  clearScheduledTimer(state);

  ctx.activeWrite.current = runWriteCycle(ctx, documentId, state, request, epoch);
}

function markReady(ctx: SchedulerContext, documentId: string, state: SchedulerState): void {
  clearScheduledTimer(state);
  if (!state.pending || state.ready) return;
  state.ready = true;
  ctx.readyQueue.push({ documentId, epoch: state.epoch });
  pumpWrite(ctx);
}

// 定时器：按防抖与最大时延取小值延迟就绪。
function scheduleTimer(ctx: SchedulerContext, documentId: string, state: SchedulerState): void {
  if (state.ready) return;
  clearScheduledTimer(state);
  const epoch = state.epoch;
  const elapsed = state.firstPendingAt === null ? 0 : Math.max(0, ctx.now() - state.firstPendingAt);
  const delay = Math.min(ctx.debounceMs, Math.max(0, ctx.maxLatencyMs - elapsed));
  state.timer = setTimeout(() => {
    if (!schedulerActive(ctx, documentId, state, epoch)) return;
    state.timer = null;
    markReady(ctx, documentId, state);
  }, delay);
}

function getState(ctx: SchedulerContext, documentId: string): SchedulerState {
  const existing = ctx.states.get(documentId);
  if (existing) return existing;
  const created: SchedulerState = {
    epoch: 0,
    nextRevision: 0,
    latestIdentity: null,
    pending: null,
    firstPendingAt: null,
    inflight: false,
    ready: false,
    failure: { status: 'none' },
    entryToken: null,
    waiters: new Set(),
    timer: null,
  };
  ctx.states.set(documentId, created);
  return created;
}

// 等待该文档的就绪/在途/挂起全部落定，期间持续把挂起提升为就绪。
async function awaitDraftSettled(ctx: SchedulerContext, documentId: string, state: SchedulerState): Promise<void> {
  while (state.inflight || state.pending || state.ready) {
    throwStoredFailure(state);
    if (state.pending && !state.ready && !state.inflight) markReady(ctx, documentId, state);
    await new Promise<void>((resolve) => state.waiters.add(resolve));
    if (ctx.disposed.current) return;
  }
  throwStoredFailure(state);
}

export async function flushDraft(ctx: SchedulerContext, documentId: string): Promise<void> {
  if (!ctx.options.isMainWindow || ctx.disposed.current) return;
  if (!isDocumentId(documentId)) throw new Error('Invalid crash draft document ID');
  const state = ctx.states.get(documentId);
  if (!state) return;
  state.failure = { status: 'none' };
  if (state.pending) markReady(ctx, documentId, state);
  await awaitDraftSettled(ctx, documentId, state);
}

function revisionSeedArgsInvalid(
  documentId: string,
  draftRevision: number,
  entryToken: string | undefined,
): boolean {
  return !isDocumentId(documentId)
    || !isSafeInteger(draftRevision, 1)
    || (entryToken !== undefined && !isToken(entryToken));
}

function revisionSeedStateConflicts(state: SchedulerState, draftRevision: number): boolean {
  return Boolean(state.pending || state.inflight || state.ready) || draftRevision < state.nextRevision;
}

export function seedRevisionBody(
  ctx: SchedulerContext,
  documentId: string,
  draftRevision: number,
  entryToken: string | undefined,
): void {
  if (!ctx.options.isMainWindow || ctx.disposed.current) return;
  if (revisionSeedArgsInvalid(documentId, draftRevision, entryToken)) {
    throw new Error('Invalid crash draft revision seed');
  }
  const state = getState(ctx, documentId);
  if (revisionSeedStateConflicts(state, draftRevision)) {
    throw new Error('Invalid crash draft revision seed');
  }
  state.nextRevision = draftRevision;
  state.latestIdentity = null;
  state.failure = { status: 'none' };
  if (entryToken !== undefined) state.entryToken = entryToken;
}

// 快照排程：同身份幂等返回，新身份推进 revision 并挂起写入。
export function scheduleSnapshotBody(ctx: SchedulerContext, snapshot: CrashDraftSnapshot): number | null {
  if (!ctx.options.isMainWindow || ctx.disposed.current) return null;
  validateSnapshot(snapshot);
  const state = getState(ctx, snapshot.documentId);
  if (sameSnapshot(state.latestIdentity, snapshot)) {
    if (state.failure.status === 'failed' && state.pending) {
      state.failure = { status: 'none' };
      state.firstPendingAt ??= ctx.now();
      scheduleTimer(ctx, snapshot.documentId, state);
    }
    return state.nextRevision;
  }
  if (state.nextRevision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Crash draft revision exhausted');
  }
  state.nextRevision += 1;
  state.latestIdentity = {
    documentId: snapshot.documentId,
    fileKind: snapshot.fileKind,
    pathHint: snapshot.pathHint,
    baseVersionToken: snapshot.baseVersionToken,
    content: snapshot.content,
  };
  state.pending = {
    documentId: snapshot.documentId,
    draftRevision: state.nextRevision,
    fileKind: snapshot.fileKind,
    pathHint: snapshot.pathHint,
    baseVersionToken: snapshot.baseVersionToken,
    content: snapshot.content,
  };
  state.failure = { status: 'none' };
  state.firstPendingAt ??= ctx.now();
  scheduleTimer(ctx, snapshot.documentId, state);
  return state.nextRevision;
}

