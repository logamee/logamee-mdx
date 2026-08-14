import { describe, expect, it } from 'vitest';
import {
  createWorkspaceIndexOperationId,
  decodeWorkspaceIndexDiscardResponse,
  decodeWorkspaceIndexQueryResponse,
  decodeWorkspaceIndexRebuildResponse,
} from './workspaceSearch';

const skipCounts = {
  unsupported: 0,
  invalidRelativePath: 0,
  duplicatePath: 0,
  oversized: 0,
  aggregateLimit: 0,
  fileCountLimit: 0,
};

const report = {
  implementationId: 'mmd-memory-substring-v1',
  schemaId: 'mmd-workspace-index-v1',
  corpusDigest: 'a'.repeat(64),
  limits: {
    maxFiles: 100000,
    maxFileBytes: 1048576,
    maxAggregateBytes: 268435456,
    maxResults: 100,
    maxQueryChars: 256,
    maxSnippetChars: 240,
  },
  inputFiles: 2,
  indexedFiles: 2,
  indexedBytes: 22,
  estimatedIndexBytes: 46,
  skipped: skipCounts,
};

describe('workspace index response decoders', () => {
  it('decodes a rebuild response only when its identity matches the production report', () => {
    const response = {
      status: 'ready',
      workspaceToken: 'workspace-7',
      indexGeneration: 4,
      implementationId: 'mmd-memory-substring-v1',
      schemaId: 'mmd-workspace-index-v1',
      report,
      scanReport: {
        scannedFiles: 2,
        collectedFiles: 2,
        collectedBytes: 22,
        readErrors: 0,
        skipped: skipCounts,
      },
    };

    expect(decodeWorkspaceIndexRebuildResponse(response)).toMatchObject({
      status: 'ready',
      indexGeneration: 4,
      report: { implementationId: 'mmd-memory-substring-v1' },
    });
    expect(() => decodeWorkspaceIndexRebuildResponse({
      ...response,
      implementationId: 'a-different-index',
    })).toThrow('Invalid workspace index rebuild response');
  });

  it('does not surface stale or cancelled search results', () => {
    const response = {
      status: 'ready',
      workspaceToken: 'workspace-7',
      indexGeneration: 4,
      implementationId: 'mmd-memory-substring-v1',
      schemaId: 'mmd-workspace-index-v1',
      truncated: false,
      results: [{
        relativePath: 'notes/plan.md',
        snippet: 'A search hit',
        location: { line: 3, utf8ByteOffset: 17 },
      }],
    };

    expect(decodeWorkspaceIndexQueryResponse(response)).toMatchObject({
      results: [{ relativePath: 'notes/plan.md', location: { line: 3 } }],
    });
    expect(() => decodeWorkspaceIndexQueryResponse({ ...response, status: 'cancelled' })).toThrow(
      'Invalid workspace index query response',
    );
  });

  it('requires an exact discard response and makes opaque operation IDs distinct', () => {
    expect(decodeWorkspaceIndexDiscardResponse({ discarded: true, indexGeneration: null })).toEqual({
      discarded: true,
      indexGeneration: null,
    });
    expect(() => decodeWorkspaceIndexDiscardResponse({ discarded: true })).toThrow(
      'Invalid workspace index discard response',
    );
    expect(createWorkspaceIndexOperationId('query')).not.toBe(createWorkspaceIndexOperationId('query'));
  });
});
