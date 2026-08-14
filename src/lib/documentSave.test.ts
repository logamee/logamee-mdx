import { describe, expect, it } from 'vitest';
import { decodeDocumentSaveResponse, decodeOverwriteTokenResponse } from './documentSave';

const version = {
  canonicalPath: '/workspace/note.md',
  platformIdentity: '1:2',
  length: '4',
  modifiedNanos: '12',
  sha256: 'b'.repeat(64),
};

describe('document save wire decoding', () => {
  it('preserves every save disposition as data', () => {
    const dispositions = [
      { status: 'confirmed_committed', path: '/workspace/note.md', version },
      {
        status: 'confirmed_committed',
        path: '/workspace/note.md',
        version,
        cleanup_repair_receipt: `cleanup-${'1'.repeat(64)}`,
      },
      {
        status: 'confirmed_not_committed',
        path: '/workspace/note.md',
        current_version: version,
        message: 'Write was rejected.',
      },
      {
        status: 'conflict',
        path: '/workspace/note.md',
        current_version: version,
        message: 'The file changed on disk.',
      },
      {
        status: 'conflict',
        path: '/workspace/note.md',
        overwrite_token: 'e'.repeat(64),
        message: 'The file disappeared.',
      },
      { status: 'indeterminate', path: '/workspace/note.md', message: 'Inspect the file.' },
    ] as const;

    for (const disposition of dispositions) {
      expect(decodeDocumentSaveResponse(disposition)).toEqual(disposition);
    }
  });

  it('rejects malformed, camelCase, and extra save fields', () => {
    for (const response of [
      null,
      { status: 'confirmed-committed', path: '/workspace/note.md', version },
      { status: 'confirmed_committed', path: '/workspace/note.md' },
      { status: 'conflict', path: '/workspace/note.md', currentVersion: version, message: 'changed' },
      { status: 'indeterminate', path: '/workspace/note.md', message: 'inspect', extra: true },
      { status: 'confirmed_committed', path: '/workspace/note.md', version, cleanup_repair_receipt: 'cleanup-short' },
      { status: 'conflict', path: '/workspace/note.md', message: 'changed', overwrite_token: 'short' },
    ]) {
      expect(() => decodeDocumentSaveResponse(response)).toThrow('Invalid document save response');
    }
  });

  it('decodes the current Rust camelCase overwrite-token response exactly', () => {
    const overwriteToken = 'c'.repeat(64);
    expect(decodeOverwriteTokenResponse({ overwriteToken })).toEqual({
      overwriteToken,
    });
    expect(() => decodeOverwriteTokenResponse({ overwrite_token: overwriteToken })).toThrow(
      'Invalid overwrite token response',
    );
    expect(() => decodeOverwriteTokenResponse({ overwriteToken: 'short' })).toThrow(
      'Invalid overwrite token response',
    );
    expect(() => decodeOverwriteTokenResponse({ overwriteToken: 'C'.repeat(64) })).toThrow(
      'Invalid overwrite token response',
    );
  });
});
