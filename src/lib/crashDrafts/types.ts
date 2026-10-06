export type CrashDraftFileKind = 'markdown' | 'html' | 'excalidraw';

export interface CrashDraftLimits {
  maxDraftBytes: number;
  maxDrafts: number;
  maxStoreBytes: number;
}

export interface RecoverableCrashDraftEntry {
  status: 'recoverable';
  documentId: string;
  draftRevision: number;
  updatedAtUnixMs: number;
  contentBytes: number;
  pathHint: string | null;
  baseVersionToken: string | null;
  fileKind: CrashDraftFileKind;
  entryToken: string;
}

export interface CorruptCrashDraftEntry {
  status: 'corrupt';
  documentId: string;
  rawBytes: number;
  reason: 'malformed' | 'invalidMetadata' | 'checksumMismatch' | 'oversized';
  entryToken: string;
}

export interface UnsupportedCrashDraftEntry {
  status: 'unsupportedVersion';
  documentId: string;
  rawBytes: number;
  schemaVersion: number;
  entryToken: string;
}

export type CrashDraftCatalogEntry =
  | RecoverableCrashDraftEntry
  | CorruptCrashDraftEntry
  | UnsupportedCrashDraftEntry;

export interface CrashDraftCatalog {
  schemaVersion: 1;
  catalogToken: string;
  totalBytes: number;
  entries: CrashDraftCatalogEntry[];
  limits: CrashDraftLimits;
}

export interface CrashDraftSnapshot {
  documentId: string;
  fileKind: CrashDraftFileKind;
  pathHint: string | null;
  baseVersionToken: string | null;
  content: string;
}

export interface CrashDraftWriteRequest extends CrashDraftSnapshot {
  draftRevision: number;
}

export interface CrashDraftWriteResponse {
  status: 'stored' | 'unchanged';
  documentId: string;
  draftRevision: number;
  entryToken: string;
  updatedAtUnixMs: number;
  evictedDocumentIds: string[];
}

export interface CrashDraftRecoverResponse extends CrashDraftSnapshot {
  draftRevision: number;
  updatedAtUnixMs: number;
  entryToken: string;
}

export type CrashDraftDiscardResponse = {
  status: 'confirmedDiscarded' | 'conflict' | 'indeterminate';
};

export type CrashDraftResetResponse = {
  status: 'confirmedReset' | 'conflict' | 'indeterminate';
};

export type CrashDraftErrorCode =
  | 'invalidRequest'
  | 'oversized'
  | 'storeFull'
  | 'revisionConflict'
  | 'corrupt'
  | 'unsupportedVersion'
  | 'notFound'
  | 'persistence'
  | 'indeterminate'
  | 'notInitialized';

export interface ProjectedCrashDraftError {
  code: CrashDraftErrorCode;
  message: string;
  canReset: boolean;
  repairReceipt?: string;
}

export type CrashDraftOverflowResetProgress =
  | { removedEntries: number; blockedEntries: number; moreWorkRemaining: false }
  | { removedEntries: number; blockedEntries: number; moreWorkRemaining: true; repairReceipt: string };
