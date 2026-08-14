import { describe, expect, it } from 'vitest';
import canonicalWireFixture from '../../test-fixtures/tauri-wire/canonical.json';
import malformedWireFixture from '../../test-fixtures/tauri-wire/malformed.json';
import {
  decodeOpenCommitResult,
  decodeOpenCommitStatus,
  decodePreparedOpenFileResponse,
  decodeRecentFilesSnapshot,
} from './recentFiles';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid fixture record');
  }
  return value as Record<string, unknown>;
}

describe('recent file wire decoding', () => {
  it('decodes the canonical prepared response, recent snapshot, result, and status fixtures', () => {
    const canonical = record(canonicalWireFixture);
    expect(decodePreparedOpenFileResponse(canonical.prepared_open_file_response)).toEqual(
      canonical.prepared_open_file_response,
    );
    expect(decodeRecentFilesSnapshot(canonical.recent_files_snapshot)).toEqual(
      canonical.recent_files_snapshot,
    );

    const results = record(canonical.open_commit_results);
    expect(decodeOpenCommitResult(results.committed)).toEqual(results.committed);
    expect(decodeOpenCommitResult(results.not_committed)).toEqual(results.not_committed);

    const statuses = record(canonical.open_commit_statuses);
    for (const key of ['pending', 'committed', 'not_committed', 'unknown']) {
      expect(decodeOpenCommitStatus(statuses[key])).toEqual(statuses[key]);
    }
  });

  it('rejects extra fields, path disclosure, duplicate IDs, and invalid tagged branches', () => {
    const malformed = record(malformedWireFixture);
    expect(() => decodePreparedOpenFileResponse(malformed.prepared_open_with_extra_field)).toThrow(
      'Invalid prepared open file response',
    );
    expect(() => decodePreparedOpenFileResponse(malformed.prepared_open_with_invalid_receipt)).toThrow(
      'Invalid prepared open file response',
    );
    expect(() => decodeRecentFilesSnapshot(malformed.recent_snapshot_with_path)).toThrow(
      'Invalid recent files snapshot',
    );
    expect(() => decodeRecentFilesSnapshot(malformed.recent_snapshot_with_duplicate_id)).toThrow(
      'Invalid recent files snapshot',
    );
    expect(() => decodeOpenCommitResult(malformed.committed_result_without_recent_files)).toThrow(
      'Invalid open commit result',
    );
    expect(() => decodeOpenCommitResult(malformed.not_committed_result_with_recent_files)).toThrow(
      'Invalid open commit result',
    );
    expect(() => decodeOpenCommitStatus(malformed.unknown_status_with_message)).toThrow(
      'Invalid open commit status',
    );
  });
});
