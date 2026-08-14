import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCrashDraftScheduler,
  createCrashDraftDocumentId,
  decodeCrashDraftCatalog,
  decodeCrashDraftDiscardResponse,
  decodeCrashDraftRecoverResponse,
  decodeCrashDraftResetResponse,
  decodeCrashDraftOverflowResetProgress,
  decodeCrashDraftWriteResponse,
  projectCrashDraftError,
  type CrashDraftSnapshot,
  type CrashDraftWriteRequest,
} from './crashDrafts';

const documentId = '1'.repeat(32);
const otherDocumentId = '2'.repeat(32);
const catalogToken = 'a'.repeat(64);
const entryToken = 'b'.repeat(64);

it('creates distinct opaque crash document identifiers', () => {
  const first = createCrashDraftDocumentId();
  const second = createCrashDraftDocumentId();
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(second).not.toBe(first);
});
const baseVersionToken = 'c'.repeat(64);

const snapshot: CrashDraftSnapshot = {
  documentId,
  fileKind: 'markdown',
  pathHint: '/private/notes.md',
  baseVersionToken,
  content: '# Draft',
};

function stored(request: CrashDraftWriteRequest) {
  return {
    status: 'stored' as const,
    documentId: request.documentId,
    draftRevision: request.draftRevision,
    entryToken,
    updatedAtUnixMs: 1_800_000_000_000,
    evictedDocumentIds: [],
  };
}

describe('crash draft wire decoding', () => {
  it('decodes the exact catalog union without exposing content for catalog entries', () => {
    const catalog = {
      schemaVersion: 1,
      catalogToken,
      totalBytes: 900,
      limits: { maxDraftBytes: 1024, maxDrafts: 8, maxStoreBytes: 8192 },
      entries: [
        {
          status: 'recoverable', documentId, draftRevision: 3, updatedAtUnixMs: 1_800_000_000_000,
          contentBytes: 120, pathHint: '/private/notes.md', baseVersionToken, fileKind: 'markdown', entryToken,
        },
        {
          status: 'corrupt', documentId: otherDocumentId, rawBytes: 80,
          reason: 'checksumMismatch', entryToken: 'd'.repeat(64),
        },
        {
          status: 'unsupportedVersion', documentId: '3'.repeat(32), rawBytes: 100,
          schemaVersion: 2, entryToken: 'e'.repeat(64),
        },
      ],
    };

    expect(decodeCrashDraftCatalog(catalog)).toEqual(catalog);
  });

  it.each([
    { mutate: { extra: true } },
    { mutate: { catalogToken: 'A'.repeat(64) } },
    { mutate: { totalBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { mutate: { entries: [{ status: 'corrupt', documentId, rawBytes: 1, reason: 'malformed', entryToken, pathHint: '/leak' }] } },
    { mutate: { entries: [{ status: 'unsupportedVersion', documentId, rawBytes: 1, schemaVersion: 2, entryToken, content: 'leak' }] } },
    { mutate: { entries: [{ status: 'recoverable', documentId, draftRevision: 0, updatedAtUnixMs: 1, contentBytes: 1, pathHint: null, baseVersionToken, fileKind: 'markdown', entryToken }] } },
  ])('rejects malformed, unsafe, extra-key, and path/content-leaking catalog shapes', ({ mutate }) => {
    const value = {
      schemaVersion: 1,
      catalogToken,
      totalBytes: 10,
      entries: [],
      limits: { maxDraftBytes: 1024, maxDrafts: 8, maxStoreBytes: 8192 },
      ...mutate,
    };
    expect(() => decodeCrashDraftCatalog(value)).toThrow('Invalid crash draft catalog response');
  });

  it('strictly decodes write, recover, discard, and reset responses', () => {
    expect(decodeCrashDraftWriteResponse({
      status: 'unchanged', documentId, draftRevision: 2, entryToken,
      updatedAtUnixMs: 1_800_000_000_000, evictedDocumentIds: [otherDocumentId],
    }).status).toBe('unchanged');
    expect(decodeCrashDraftRecoverResponse({
      documentId, draftRevision: 2, fileKind: 'excalidraw', pathHint: null,
      baseVersionToken: null, content: '{}', updatedAtUnixMs: 1_800_000_000_000, entryToken,
    }).content).toBe('{}');
    expect(decodeCrashDraftDiscardResponse({ status: 'confirmedDiscarded' })).toEqual({ status: 'confirmedDiscarded' });
    expect(decodeCrashDraftResetResponse({ status: 'indeterminate' })).toEqual({ status: 'indeterminate' });

    expect(() => decodeCrashDraftWriteResponse({ ...stored({ ...snapshot, draftRevision: 1 }), path: '/leak' })).toThrow(
      'Invalid crash draft write response',
    );
    expect(() => decodeCrashDraftRecoverResponse({
      documentId, draftRevision: 2, fileKind: 'markdown', pathHint: null,
      baseVersionToken, content: 'x', updatedAtUnixMs: 1, entryToken,
    })).toThrow('Invalid crash draft recover response');
    expect(() => decodeCrashDraftDiscardResponse({ status: 'conflict', message: '/leak' })).toThrow(
      'Invalid crash draft discard response',
    );
    expect(() => decodeCrashDraftResetResponse({ status: 'confirmedDiscarded' })).toThrow(
      'Invalid crash draft reset response',
    );
  });

  it('normalizes stable errors without retaining backend messages, paths, or content', () => {
    const projected = projectCrashDraftError({
      code: 'persistence',
      message: 'failed at /Users/me/secret.md containing private draft text',
      canReset: true,
    });
    expect(projected).toEqual({
      code: 'persistence',
      message: 'Crash drafts could not be saved. Your current edits remain in the editor.',
      canReset: true,
    });
    expect(JSON.stringify(projected)).not.toContain('/Users/me');
    expect(projectCrashDraftError({ code: 'unsupportedVersion', message: '/secret', canReset: true })).toEqual({
      code: 'unsupportedVersion',
      message: 'Some drafts were created by a newer mdx version and were left unchanged.',
      canReset: false,
    });
    expect(projectCrashDraftError({ code: 'madeUp', message: '/secret', canReset: true })).toEqual({
      code: 'persistence',
      message: 'Crash drafts could not be saved. Your current edits remain in the editor.',
      canReset: false,
    });
    expect(projectCrashDraftError({
      code: 'storeFull', message: '/secret', canReset: true, repairReceipt: 'f'.repeat(64),
    })).toEqual({
      code: 'storeFull',
      message: 'Crash draft storage is full. Save important documents to keep their edits.',
      canReset: false,
      repairReceipt: 'f'.repeat(64),
    });
    expect(projectCrashDraftError({
      code: 'storeFull', message: '/secret', canReset: true, repairReceipt: 'INVALID/path',
    })).not.toHaveProperty('repairReceipt');
  });

  it('strictly decodes one bounded overflow repair batch', () => {
    expect(decodeCrashDraftOverflowResetProgress({
      removedEntries: 16,
      blockedEntries: 2,
      moreWorkRemaining: true,
      repairReceipt: 'e'.repeat(64),
    })).toEqual({
      removedEntries: 16,
      blockedEntries: 2,
      moreWorkRemaining: true,
      repairReceipt: 'e'.repeat(64),
    });
    expect(decodeCrashDraftOverflowResetProgress({
      removedEntries: 3,
      blockedEntries: 1,
      moreWorkRemaining: false,
    })).toEqual({ removedEntries: 3, blockedEntries: 1, moreWorkRemaining: false });

    for (const malformed of [
      { removedEntries: 1, blockedEntries: 0, moreWorkRemaining: true },
      { removedEntries: 1, blockedEntries: 0, moreWorkRemaining: false, repairReceipt: 'e'.repeat(64) },
      { removedEntries: -1, blockedEntries: 0, moreWorkRemaining: false },
      { removedEntries: 1, blockedEntries: Number.MAX_SAFE_INTEGER + 1, moreWorkRemaining: false },
      { removedEntries: 1, blockedEntries: 0, moreWorkRemaining: false, extra: true },
    ]) {
      expect(() => decodeCrashDraftOverflowResetProgress(malformed)).toThrow(
        'Invalid crash draft overflow reset response',
      );
    }
  });
});

describe('crash draft scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces to the latest snapshot with a trailing 500 ms debounce and monotonic revision', async () => {
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => { writes.push(request); return stored(request); },
    });

    expect(scheduler.schedule(snapshot)).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(scheduler.schedule({ ...snapshot, content: '# Latest' })).toBe(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ ...snapshot, content: '# Latest', draftRevision: 2 }]);
    expect(scheduler.schedule({ ...snapshot, content: '# Latest' })).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(1);
  });

  it('enforces two-second maximum latency under continuous edits', async () => {
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => { writes.push(request); return stored(request); },
    });
    scheduler.schedule(snapshot);
    for (let index = 1; index <= 4; index += 1) {
      await vi.advanceTimersByTimeAsync(400);
      scheduler.schedule({ ...snapshot, content: `edit-${index}` });
    }
    await vi.advanceTimersByTimeAsync(399);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes[0]).toMatchObject({ content: 'edit-4', draftRevision: 5 });
  });

  it('allows only one inflight write per document and retains exactly the latest trailing snapshot', async () => {
    let release!: () => void;
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => {
        writes.push(request);
        if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        return stored(request);
      },
    });
    scheduler.schedule(snapshot);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule({ ...snapshot, content: 'middle' });
    scheduler.schedule({ ...snapshot, content: 'latest' });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ content: 'latest', draftRevision: 3 });
  });

  it('allows only one global inflight write and preserves fair cross-document flush barriers', async () => {
    let releaseFirst!: () => void;
    const events: string[] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        events.push(`start:${request.documentId}`);
        if (events.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        events.push(`finish:${request.documentId}`);
        activeWrites -= 1;
        return stored(request);
      },
    });
    scheduler.schedule(snapshot);
    scheduler.schedule({ ...snapshot, documentId: otherDocumentId, pathHint: null, baseVersionToken: null });
    await vi.advanceTimersByTimeAsync(500);
    const secondBarrier = scheduler.flushBefore(otherDocumentId, async () => { events.push('switch:second'); });
    expect(maximumActiveWrites).toBe(1);
    expect(events).toEqual([`start:${documentId}`]);
    releaseFirst();
    await secondBarrier;
    expect(maximumActiveWrites).toBe(1);
    expect(events).toEqual([
      `start:${documentId}`, `finish:${documentId}`,
      `start:${otherDocumentId}`, `finish:${otherDocumentId}`, 'switch:second',
    ]);
  });

  it('runs a ready trailing write immediately when the global arbiter becomes free', async () => {
    let releaseFirst!: () => void;
    const starts: Array<{ documentId: string; at: number }> = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => {
        starts.push({ documentId: request.documentId, at: Date.now() });
        if (starts.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return stored(request);
      },
    });
    scheduler.schedule(snapshot);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule({ ...snapshot, documentId: otherDocumentId, pathHint: null, baseVersionToken: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(starts).toHaveLength(1);
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual([
      { documentId, at: 10_500 },
      { documentId: otherDocumentId, at: 11_000 },
    ]);
  });

  it('discards stale queued generations without moving a rescheduled document ahead of FIFO peers', async () => {
    const thirdDocumentId = '3'.repeat(32);
    let releaseFirst!: () => void;
    const order: string[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => {
        order.push(request.documentId);
        if (order.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return stored(request);
      },
    });
    scheduler.schedule(snapshot);
    scheduler.schedule({ ...snapshot, documentId: otherDocumentId, pathHint: null, baseVersionToken: null });
    await vi.advanceTimersByTimeAsync(500);
    scheduler.invalidate(otherDocumentId);
    scheduler.schedule({ ...snapshot, documentId: thirdDocumentId, pathHint: null, baseVersionToken: null });
    scheduler.schedule({ ...snapshot, documentId: otherDocumentId, pathHint: null, baseVersionToken: null });
    await vi.advanceTimersByTimeAsync(500);
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([documentId, thirdDocumentId, otherDocumentId]);
  });

  it('flushes before a caller-controlled action and retains pending dirty state after failure', async () => {
    const events: string[] = [];
    let shouldFail = true;
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => {
        events.push(`write:${request.draftRevision}`);
        if (shouldFail) throw new Error('private path /secret');
        return stored(request);
      },
    });
    scheduler.schedule(snapshot);
    await expect(scheduler.flushBefore(documentId, async () => { events.push('switch'); })).rejects.toThrow(
      'private path /secret',
    );
    expect(events).toEqual(['write:1']);
    expect(scheduler.hasPending(documentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual(['write:1']);

    shouldFail = false;
    await scheduler.flushBefore(documentId, async () => { events.push('switch'); });
    expect(events).toEqual(['write:1', 'write:1', 'switch']);
    expect(scheduler.hasPending(documentId)).toBe(false);
  });

  it.each([null, ''])('retains a falsy rejection without automatically retrying it (%j)', async (reason) => {
    const write = vi.fn<(request: CrashDraftWriteRequest) => Promise<ReturnType<typeof stored>>>(
      async () => Promise.reject(reason),
    );
    const scheduler = createCrashDraftScheduler({ isMainWindow: true, write });
    scheduler.schedule(snapshot);
    await expect(scheduler.flush(documentId)).rejects.toThrow('Crash draft write failed');
    expect(write).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending(documentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('invalidates stale timers by document and epoch and is inert outside the main window', async () => {
    const write = vi.fn<(request: CrashDraftWriteRequest) => Promise<ReturnType<typeof stored>>>(
      async (request) => stored(request),
    );
    const scheduler = createCrashDraftScheduler({ isMainWindow: true, write });
    scheduler.schedule(snapshot);
    scheduler.invalidate(documentId);
    scheduler.schedule({ ...snapshot, content: 'new epoch' });
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ content: 'new epoch', draftRevision: 2 });

    const popout = createCrashDraftScheduler({ isMainWindow: false, write });
    expect(popout.schedule(snapshot)).toBeNull();
    await popout.flush(documentId);
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('continues revisions from the catalog value after restart', async () => {
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => { writes.push(request); return stored(request); },
    });
    scheduler.seedRevision(documentId, 7);
    expect(scheduler.schedule(snapshot)).toBe(8);
    await scheduler.flush(documentId);
    expect(writes[0].draftRevision).toBe(8);
    expect(() => scheduler.seedRevision(documentId, 6)).toThrow('Invalid crash draft revision seed');
  });

  it('clears the dedupe identity when a completed document is reseeded forward', async () => {
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => { writes.push(request); return stored(request); },
    });
    scheduler.schedule(snapshot);
    await scheduler.flush(documentId);
    scheduler.seedRevision(documentId, 7);
    expect(scheduler.schedule(snapshot)).toBe(8);
    await scheduler.flush(documentId);
    expect(writes.map((request) => request.draftRevision)).toEqual([1, 8]);
  });

  it('fails closed without timers or writes when the revision cannot be incremented safely', async () => {
    const write = vi.fn<(request: CrashDraftWriteRequest) => Promise<ReturnType<typeof stored>>>(
      async (request) => stored(request),
    );
    const scheduler = createCrashDraftScheduler({ isMainWindow: true, write });
    scheduler.seedRevision(documentId, Number.MAX_SAFE_INTEGER);
    expect(() => scheduler.schedule(snapshot)).toThrow('Crash draft revision exhausted');
    expect(scheduler.hasPending(documentId)).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
  });

  it('strips runtime snapshot extras from the write request', async () => {
    const writes: CrashDraftWriteRequest[] = [];
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => { writes.push(request); return stored(request); },
    });
    scheduler.schedule({ ...snapshot, leakedRuntimePath: '/secret' } as CrashDraftSnapshot);
    await scheduler.flush(documentId);
    expect(writes).toEqual([{ ...snapshot, draftRevision: 1 }]);
    expect(writes[0]).not.toHaveProperty('leakedRuntimePath');
  });

  it('retains the confirmed entry token until exact successful-save cleanup is acknowledged', async () => {
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: async (request) => stored(request),
    });
    scheduler.schedule(snapshot);
    await scheduler.flush(documentId);
    expect(scheduler.getStoredEntryToken(documentId)).toBe(entryToken);
    scheduler.confirmDiscarded(documentId, 'd'.repeat(64));
    expect(scheduler.getStoredEntryToken(documentId)).toBe(entryToken);
    scheduler.confirmDiscarded(documentId, entryToken);
    expect(scheduler.getStoredEntryToken(documentId)).toBeNull();
    expect(scheduler.schedule(snapshot)).toBe(2);
  });
});
