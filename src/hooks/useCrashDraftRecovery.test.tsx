// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrashDraftRecoverResponse } from '../lib/crashDrafts';
import { useCrashDraftRecovery, type CrashDraftRecoveryCommands } from './useCrashDraftRecovery';

const documentId = '1'.repeat(32);
const catalogToken = 'a'.repeat(64);
const entryToken = 'b'.repeat(64);

const entry = {
  status: 'recoverable' as const,
  documentId,
  draftRevision: 4,
  updatedAtUnixMs: 1_800_000_000_000,
  contentBytes: 7,
  pathHint: null,
  baseVersionToken: null,
  fileKind: 'markdown' as const,
  entryToken,
};

const catalog = {
  schemaVersion: 1 as const,
  catalogToken,
  totalBytes: 7,
  entries: [entry],
  limits: { maxDraftBytes: 1024, maxDrafts: 8, maxStoreBytes: 8192 },
};

const recovered: CrashDraftRecoverResponse = {
  documentId,
  draftRevision: 4,
  fileKind: 'markdown',
  pathHint: null,
  baseVersionToken: null,
  content: '# Draft',
  updatedAtUnixMs: 1_800_000_000_000,
  entryToken,
};

function Harness({
  enabled,
  commands,
  onRecoverDraft,
  seedRevision,
  getStoredEntryToken,
  confirmDiscarded,
  observe,
}: {
  enabled?: boolean;
  commands: CrashDraftRecoveryCommands;
  onRecoverDraft: (draft: CrashDraftRecoverResponse) => Promise<void>;
  seedRevision?: (documentId: string, revision: number, entryToken: string) => void;
  getStoredEntryToken?: (documentId: string) => string | null;
  confirmDiscarded?: (documentId: string, expectedEntryToken: string) => void;
  observe: (value: ReturnType<typeof useCrashDraftRecovery>) => void;
}) {
  const value = useCrashDraftRecovery({
    enabled,
    commands,
    onRecoverDraft,
    seedRevision,
    getStoredEntryToken,
    confirmDiscarded,
  });
  useEffect(() => observe(value), [observe, value]);
  return <output>{value.catalog?.entries.length ?? 'loading'}</output>;
}

function createCommands(overrides: Partial<CrashDraftRecoveryCommands> = {}): CrashDraftRecoveryCommands {
  return {
    list: vi.fn<CrashDraftRecoveryCommands['list']>(async () => catalog),
    recover: vi.fn<CrashDraftRecoveryCommands['recover']>(async () => recovered),
    discard: vi.fn<CrashDraftRecoveryCommands['discard']>(async () => ({ status: 'confirmedDiscarded' })),
    reset: vi.fn<CrashDraftRecoveryCommands['reset']>(async () => ({ status: 'confirmedReset' })),
    ...overrides,
  };
}

describe('useCrashDraftRecovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('strictly loads the flat catalog and seeds each recoverable revision once', async () => {
    const seedRevision = vi.fn<(documentId: string, revision: number, entryToken: string) => void>();
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={createCommands()}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        seedRevision={seedRevision}
        observe={(value) => { current = value; }}
      />,
    ));
    expect(current?.catalog).toEqual(catalog);
    expect(seedRevision).toHaveBeenCalledWith(documentId, 4, entryToken);
    expect(seedRevision).toHaveBeenCalledTimes(1);
  });

  it('does not list or own recovery state when disabled for a popout', async () => {
    const api = createCommands();
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
        enabled={false}
      />,
    ));
    expect(api.list).not.toHaveBeenCalled();
    expect(current?.busy).toBe(false);
    expect(current?.catalog).toBeNull();
  });

  it('opens recovered content as dirty work and discards storage only after confirmed save', async () => {
    const api = createCommands({
      list: vi.fn<CrashDraftRecoveryCommands['list']>()
        .mockResolvedValueOnce(catalog)
        .mockResolvedValueOnce({ ...catalog, entries: [], totalBytes: 0 }),
    });
    const onRecoverDraft = vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined);
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness commands={api} onRecoverDraft={onRecoverDraft} observe={(value) => { current = value; }} />,
    ));

    await act(async () => current?.recover(entry));
    expect(onRecoverDraft).toHaveBeenCalledWith(recovered);
    expect(api.discard).not.toHaveBeenCalled();
    expect(current?.catalog?.entries).toEqual([]);

    await act(async () => current?.afterConfirmedSave(documentId));
    expect(api.discard).toHaveBeenCalledWith(documentId, entryToken);
    expect(current?.catalog?.entries).toEqual([]);
  });

  it('retains the stored draft when confirmed-save cleanup is indeterminate', async () => {
    const api = createCommands({
      discard: vi.fn<CrashDraftRecoveryCommands['discard']>(async () => ({ status: 'indeterminate' })),
    });
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
      />,
    ));
    await act(async () => current?.recover(entry));
    let cleaned = true;
    await act(async () => { cleaned = await current!.afterConfirmedSave(documentId); });
    expect(cleaned).toBe(false);
    expect(current?.error).toEqual(expect.objectContaining({ code: 'indeterminate' }));
    expect(JSON.stringify(current?.error)).not.toContain('/');
  });

  it('cleans a scheduler-written draft only after the caller reports a confirmed save', async () => {
    const emptyCatalog = { ...catalog, entries: [], totalBytes: 0 };
    const api = createCommands({
      list: vi.fn<CrashDraftRecoveryCommands['list']>(async () => emptyCatalog),
    });
    const confirmDiscarded = vi.fn<(documentId: string, expectedEntryToken: string) => void>();
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        getStoredEntryToken={() => entryToken}
        confirmDiscarded={confirmDiscarded}
        observe={(value) => { current = value; }}
      />,
    ));
    expect(api.discard).not.toHaveBeenCalled();
    await act(async () => current?.afterConfirmedSave(documentId));
    expect(api.discard).toHaveBeenCalledWith(documentId, entryToken);
    expect(confirmDiscarded).toHaveBeenCalledWith(documentId, entryToken);
  });

  it('rejects nested backend DTOs without leaking their path or content', async () => {
    const api = createCommands({
      list: vi.fn<CrashDraftRecoveryCommands['list']>(async () => ({
        catalogToken,
        entries: [{ status: 'supported', draft: { ...entry, content: 'private' } }],
      })),
    });
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
      />,
    ));
    expect(current?.catalog).toBeNull();
    expect(current?.error).toEqual(expect.objectContaining({ code: 'persistence' }));
    expect(JSON.stringify(current?.error)).not.toContain('private');
  });

  it('consumes exactly one bounded overflow batch per explicit call and refreshes only after completion', async () => {
    const firstReceipt = 'f'.repeat(64);
    const secondReceipt = 'e'.repeat(64);
    const overflowError = { code: 'storeFull', message: 'overflow at /private/path', repairReceipt: firstReceipt };
    const resetOverflowBatch = vi.fn<NonNullable<CrashDraftRecoveryCommands['resetOverflowBatch']>>()
      .mockResolvedValueOnce({
        removedEntries: 16, blockedEntries: 2, moreWorkRemaining: true, repairReceipt: secondReceipt,
      })
      .mockResolvedValueOnce({ removedEntries: 4, blockedEntries: 1, moreWorkRemaining: false });
    const list = vi.fn<CrashDraftRecoveryCommands['list']>()
      .mockRejectedValueOnce(overflowError)
      .mockResolvedValueOnce({ ...catalog, entries: [], totalBytes: 0 });
    const api = createCommands({ list, resetOverflowBatch });
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
      />,
    ));
    expect(current?.canRepairOverflow).toBe(true);
    expect(JSON.stringify(current?.error)).not.toContain('/private/path');

    await act(async () => current?.repairOverflowBatch());
    expect(resetOverflowBatch).toHaveBeenCalledTimes(1);
    expect(resetOverflowBatch).toHaveBeenCalledWith(firstReceipt);
    expect(current?.overflowRepairProgress).toEqual(expect.objectContaining({ blockedEntries: 2 }));
    expect(current?.canRepairOverflow).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => current?.repairOverflowBatch());
    expect(resetOverflowBatch).toHaveBeenCalledTimes(2);
    expect(resetOverflowBatch).toHaveBeenLastCalledWith(secondReceipt);
    expect(list).toHaveBeenCalledTimes(2);
    expect(current?.overflowRepairProgress).toEqual(expect.objectContaining({
      removedEntries: 4, blockedEntries: 1, moreWorkRemaining: false,
    }));
    expect(current?.canRepairOverflow).toBe(false);
  });

  it.each([
    { removedEntries: 1, blockedEntries: 0, moreWorkRemaining: true },
    { removedEntries: 1, blockedEntries: 0, moreWorkRemaining: true, repairReceipt: 'f'.repeat(64), extra: true },
  ])('consumes the receipt and rejects malformed or replayed overflow progress', async (response) => {
    const receipt = 'f'.repeat(64);
    const resetOverflowBatch = vi.fn<NonNullable<CrashDraftRecoveryCommands['resetOverflowBatch']>>(async () => response);
    const api = createCommands({
      list: vi.fn<CrashDraftRecoveryCommands['list']>(async () => Promise.reject({
        code: 'storeFull', message: '/private', repairReceipt: receipt,
      })),
      resetOverflowBatch,
    });
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
      />,
    ));
    await act(async () => current?.repairOverflowBatch());
    expect(current?.canRepairOverflow).toBe(false);
    expect(current?.error).toEqual(expect.objectContaining({ code: 'persistence' }));
    await act(async () => current?.repairOverflowBatch());
    expect(resetOverflowBatch).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale in-flight batch response after retry installs a newer repair receipt', async () => {
    const firstReceipt = 'f'.repeat(64);
    const staleNextReceipt = 'e'.repeat(64);
    const currentReceipt = 'd'.repeat(64);
    let resolveFirst!: (value: unknown) => void;
    const resetOverflowBatch = vi.fn<NonNullable<CrashDraftRecoveryCommands['resetOverflowBatch']>>()
      .mockImplementationOnce(async () => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ removedEntries: 1, blockedEntries: 0, moreWorkRemaining: false });
    const list = vi.fn<CrashDraftRecoveryCommands['list']>()
      .mockRejectedValueOnce({ code: 'storeFull', repairReceipt: firstReceipt })
      .mockRejectedValueOnce({ code: 'storeFull', repairReceipt: currentReceipt })
      .mockResolvedValueOnce({ ...catalog, entries: [], totalBytes: 0 });
    const api = createCommands({ list, resetOverflowBatch });
    let current: ReturnType<typeof useCrashDraftRecovery> | undefined;
    await act(async () => root.render(
      <Harness
        commands={api}
        onRecoverDraft={vi.fn<(draft: CrashDraftRecoverResponse) => Promise<void>>(async () => undefined)}
        observe={(value) => { current = value; }}
      />,
    ));

    let staleBatch!: Promise<unknown>;
    await act(async () => {
      staleBatch = current!.repairOverflowBatch();
      await Promise.resolve();
    });
    await act(async () => current?.retry());
    resolveFirst({
      removedEntries: 16,
      blockedEntries: 0,
      moreWorkRemaining: true,
      repairReceipt: staleNextReceipt,
    });
    await act(async () => staleBatch);

    await act(async () => current?.repairOverflowBatch());
    expect(resetOverflowBatch.mock.calls.map(([receipt]) => receipt)).toEqual([firstReceipt, currentReceipt]);
    expect(list).toHaveBeenCalledTimes(3);
  });
});
