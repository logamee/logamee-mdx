import type {
  WorkspaceIndexBuildReport,
  WorkspaceIndexDiscardResponse,
  WorkspaceIndexQueryLocation,
  WorkspaceIndexQueryResponse,
  WorkspaceIndexQueryResult,
  WorkspaceIndexRebuildResponse,
  WorkspaceIndexScanReport,
  WorkspaceIndexSkipCounts,
  WorkspaceIndexStatus,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is WorkspaceIndexStatus {
  return value === 'ready' || value === 'cancelled' || value === 'invalidated';
}

function invalidResponse(kind: string): never {
  throw new Error(`Invalid workspace index ${kind} response`);
}

function decodeNonNegativeInteger(value: unknown, kind: string): number {
  if (!isNonNegativeInteger(value)) return invalidResponse(kind);
  return value;
}

function decodeSkipCounts(value: unknown): WorkspaceIndexSkipCounts {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'unsupported', 'invalidRelativePath', 'duplicatePath', 'oversized', 'aggregateLimit', 'fileCountLimit',
    ])
  ) return invalidResponse('skip counts');
  return {
    unsupported: decodeNonNegativeInteger(value.unsupported, 'skip counts'),
    invalidRelativePath: decodeNonNegativeInteger(value.invalidRelativePath, 'skip counts'),
    duplicatePath: decodeNonNegativeInteger(value.duplicatePath, 'skip counts'),
    oversized: decodeNonNegativeInteger(value.oversized, 'skip counts'),
    aggregateLimit: decodeNonNegativeInteger(value.aggregateLimit, 'skip counts'),
    fileCountLimit: decodeNonNegativeInteger(value.fileCountLimit, 'skip counts'),
  };
}

function decodeBuildReport(value: unknown): WorkspaceIndexBuildReport {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'implementationId', 'schemaId', 'corpusDigest', 'limits', 'inputFiles', 'indexedFiles',
      'indexedBytes', 'estimatedIndexBytes', 'skipped',
    ])
    || !isNonBlankString(value.implementationId)
    || !isNonBlankString(value.schemaId)
    || typeof value.corpusDigest !== 'string'
    || !isRecord(value.limits)
    || !hasExactKeys(value.limits, [
      'maxFiles', 'maxFileBytes', 'maxAggregateBytes', 'maxResults', 'maxQueryChars', 'maxSnippetChars',
    ])
  ) return invalidResponse('build report');

  return {
    implementationId: value.implementationId,
    schemaId: value.schemaId,
    corpusDigest: value.corpusDigest,
    limits: {
      maxFiles: decodeNonNegativeInteger(value.limits.maxFiles, 'build report'),
      maxFileBytes: decodeNonNegativeInteger(value.limits.maxFileBytes, 'build report'),
      maxAggregateBytes: decodeNonNegativeInteger(value.limits.maxAggregateBytes, 'build report'),
      maxResults: decodeNonNegativeInteger(value.limits.maxResults, 'build report'),
      maxQueryChars: decodeNonNegativeInteger(value.limits.maxQueryChars, 'build report'),
      maxSnippetChars: decodeNonNegativeInteger(value.limits.maxSnippetChars, 'build report'),
    },
    inputFiles: decodeNonNegativeInteger(value.inputFiles, 'build report'),
    indexedFiles: decodeNonNegativeInteger(value.indexedFiles, 'build report'),
    indexedBytes: decodeNonNegativeInteger(value.indexedBytes, 'build report'),
    estimatedIndexBytes: decodeNonNegativeInteger(value.estimatedIndexBytes, 'build report'),
    skipped: decodeSkipCounts(value.skipped),
  };
}

function decodeScanReport(value: unknown): WorkspaceIndexScanReport {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['scannedFiles', 'collectedFiles', 'collectedBytes', 'readErrors', 'skipped'])
  ) return invalidResponse('scan report');
  return {
    scannedFiles: decodeNonNegativeInteger(value.scannedFiles, 'scan report'),
    collectedFiles: decodeNonNegativeInteger(value.collectedFiles, 'scan report'),
    collectedBytes: decodeNonNegativeInteger(value.collectedBytes, 'scan report'),
    readErrors: decodeNonNegativeInteger(value.readErrors, 'scan report'),
    skipped: decodeSkipCounts(value.skipped),
  };
}

function decodeLocation(value: unknown): WorkspaceIndexQueryLocation | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['line', 'utf8ByteOffset'])
    || !isNonNegativeInteger(value.line)
    || value.line === 0
    || !isNonNegativeInteger(value.utf8ByteOffset)
  ) return invalidResponse('query location');
  return { line: value.line, utf8ByteOffset: value.utf8ByteOffset };
}

function decodeResult(value: unknown): WorkspaceIndexQueryResult {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['relativePath', 'snippet', 'location'])
    || !isNonBlankString(value.relativePath)
    || (value.snippet !== null && typeof value.snippet !== 'string')
  ) return invalidResponse('query result');
  return {
    relativePath: value.relativePath,
    snippet: value.snippet,
    location: decodeLocation(value.location),
  };
}

export function decodeWorkspaceIndexRebuildResponse(value: unknown): WorkspaceIndexRebuildResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'status', 'workspaceToken', 'indexGeneration', 'implementationId', 'schemaId', 'report', 'scanReport',
    ])
    || !isStatus(value.status)
    || !isNonBlankString(value.workspaceToken)
    || !isNonNegativeInteger(value.indexGeneration)
    || !isNonBlankString(value.implementationId)
    || !isNonBlankString(value.schemaId)
  ) return invalidResponse('rebuild');
  const report = decodeBuildReport(value.report);
  if (report.implementationId !== value.implementationId || report.schemaId !== value.schemaId) {
    return invalidResponse('rebuild');
  }
  return {
    status: value.status,
    workspaceToken: value.workspaceToken,
    indexGeneration: value.indexGeneration,
    implementationId: value.implementationId,
    schemaId: value.schemaId,
    report,
    scanReport: decodeScanReport(value.scanReport),
  };
}

export function decodeWorkspaceIndexQueryResponse(value: unknown): WorkspaceIndexQueryResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'status', 'workspaceToken', 'indexGeneration', 'implementationId', 'schemaId', 'truncated', 'results',
    ])
    || !isStatus(value.status)
    || !isNonBlankString(value.workspaceToken)
    || !isNonNegativeInteger(value.indexGeneration)
    || !isNonBlankString(value.implementationId)
    || !isNonBlankString(value.schemaId)
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.results)
  ) return invalidResponse('query');
  const results = value.results.map(decodeResult);
  if (value.status !== 'ready' && results.length !== 0) return invalidResponse('query');
  return {
    status: value.status,
    workspaceToken: value.workspaceToken,
    indexGeneration: value.indexGeneration,
    implementationId: value.implementationId,
    schemaId: value.schemaId,
    truncated: value.truncated,
    results,
  };
}

export function decodeWorkspaceIndexDiscardResponse(value: unknown): WorkspaceIndexDiscardResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['discarded', 'indexGeneration'])
    || typeof value.discarded !== 'boolean'
    || (value.indexGeneration !== null && !isNonNegativeInteger(value.indexGeneration))
  ) return invalidResponse('discard');
  return { discarded: value.discarded, indexGeneration: value.indexGeneration };
}

let nextOperationSequence = 0;

export function createWorkspaceIndexOperationId(prefix: 'rebuild' | 'query'): string {
  nextOperationSequence = (nextOperationSequence + 1) % Number.MAX_SAFE_INTEGER;
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    ?? `${Date.now().toString(36)}${nextOperationSequence.toString(36)}`;
  return `workspace-index-${prefix}-${random}`;
}
