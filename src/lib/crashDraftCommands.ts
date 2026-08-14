import { invoke } from '@tauri-apps/api/core';
import type { CrashDraftWriteRequest } from './crashDrafts';

export function listCrashDrafts(): Promise<unknown> {
  return invoke<unknown>('list_crash_drafts');
}

export function writeCrashDraft(request: CrashDraftWriteRequest): Promise<unknown> {
  return invoke<unknown>('write_crash_draft', { request });
}

export function recoverCrashDraft(documentId: string, expectedEntryToken: string): Promise<unknown> {
  return invoke<unknown>('recover_crash_draft', { documentId, expectedEntryToken });
}

export function discardCrashDraft(documentId: string, expectedEntryToken: string): Promise<unknown> {
  return invoke<unknown>('discard_crash_draft', { documentId, expectedEntryToken });
}

export function resetCrashDrafts(expectedCatalogToken: string): Promise<unknown> {
  return invoke<unknown>('reset_crash_drafts', { expectedCatalogToken });
}

export function resetCrashDraftOverflowBatch(expectedRepairReceipt: string): Promise<unknown> {
  return invoke<unknown>('reset_crash_draft_overflow_batch', { expectedRepairReceipt });
}

export const crashDraftCommands = {
  list: listCrashDrafts,
  write: writeCrashDraft,
  recover: recoverCrashDraft,
  discard: discardCrashDraft,
  reset: resetCrashDrafts,
  resetOverflowBatch: resetCrashDraftOverflowBatch,
};
