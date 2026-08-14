import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrashDraftRecoveryCommands } from '../hooks/useCrashDraftRecovery';
import {
  crashDraftCommands,
  discardCrashDraft,
  listCrashDrafts,
  recoverCrashDraft,
  resetCrashDraftOverflowBatch,
  resetCrashDrafts,
  writeCrashDraft,
} from './crashDraftCommands';

const invokeMock = vi.hoisted(() => vi.fn<(command: string, payload?: unknown) => Promise<unknown>>());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('crash draft command transport', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ transport: 'opaque' });
  });

  it('uses exact command names and argument envelopes', async () => {
    const request = {
      documentId: 'a'.repeat(32),
      draftRevision: 4,
      fileKind: 'markdown' as const,
      pathHint: '/workspace/draft.md',
      baseVersionToken: 'b'.repeat(64),
      content: '# Draft',
    };

    await expect(listCrashDrafts()).resolves.toEqual({ transport: 'opaque' });
    await expect(writeCrashDraft(request)).resolves.toEqual({ transport: 'opaque' });
    await expect(recoverCrashDraft(request.documentId, 'c'.repeat(64))).resolves.toEqual({ transport: 'opaque' });
    await expect(discardCrashDraft(request.documentId, 'd'.repeat(64))).resolves.toEqual({ transport: 'opaque' });
    await expect(resetCrashDrafts('e'.repeat(64))).resolves.toEqual({ transport: 'opaque' });
    await expect(resetCrashDraftOverflowBatch('f'.repeat(64))).resolves.toEqual({ transport: 'opaque' });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'list_crash_drafts');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'write_crash_draft', { request });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'recover_crash_draft', {
      documentId: request.documentId,
      expectedEntryToken: 'c'.repeat(64),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'discard_crash_draft', {
      documentId: request.documentId,
      expectedEntryToken: 'd'.repeat(64),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'reset_crash_drafts', {
      expectedCatalogToken: 'e'.repeat(64),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'reset_crash_draft_overflow_batch', {
      expectedRepairReceipt: 'f'.repeat(64),
    });
  });

  it('exports the recovery command shape plus write', () => {
    const recoveryCommands: CrashDraftRecoveryCommands = crashDraftCommands;

    expect(recoveryCommands).toBe(crashDraftCommands);
    expect(crashDraftCommands).toEqual({
      list: listCrashDrafts,
      write: writeCrashDraft,
      recover: recoverCrashDraft,
      discard: discardCrashDraft,
      reset: resetCrashDrafts,
      resetOverflowBatch: resetCrashDraftOverflowBatch,
    });
  });
});
