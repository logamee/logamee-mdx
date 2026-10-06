import type { CrashDraftRecoverResponse } from '../../lib/crashDrafts';

export interface CrashDraftRecoveryCommands {
  list(): Promise<unknown>;
  recover(documentId: string, expectedEntryToken: string): Promise<unknown>;
  discard(documentId: string, expectedEntryToken: string): Promise<unknown>;
  reset(expectedCatalogToken: string): Promise<unknown>;
  resetOverflowBatch?(expectedRepairReceipt: string): Promise<unknown>;
}

export interface CrashDraftRecoveryDependencies {
  enabled?: boolean;
  commands: CrashDraftRecoveryCommands;
  onRecoverDraft: (draft: CrashDraftRecoverResponse) => Promise<void> | void;
  seedRevision?: (documentId: string, revision: number, entryToken: string) => void;
  getStoredEntryToken?: (documentId: string) => string | null;
  confirmDiscarded?: (documentId: string, expectedEntryToken: string) => void;
}
