import { describe, expect, it } from 'vitest';
import canonicalWireFixture from '../../test-fixtures/tauri-wire/canonical.json';
import malformedWireFixture from '../../test-fixtures/tauri-wire/malformed.json';
import {
  decodeFileVersion,
  decodeMutationOutcome,
  decodeOpenFileResponse,
  decodeSnapshotReceipt,
  decodeWorkspaceFileKind,
  decodeWorkspaceSnapshot,
  getWorkspacePresentation,
} from './workspaceFileKind';
import type { WorkspaceFileKind } from '../types';

function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (!isFixtureRecord(value)) throw new Error('Invalid test fixture record');
  return value;
}

function fixtureArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid test fixture array');
  return value;
}

function decodeCommittedPath(value: unknown): { path: string } {
  const record = fixtureRecord(value);
  if (Object.keys(record).length !== 1 || typeof record.path !== 'string') {
    throw new Error('Invalid committed path fixture');
  }
  return { path: record.path };
}

describe('workspace file kind wire decoding', () => {
  const fileVersion = {
    canonicalPath: '/workspace/notes.md',
    platformIdentity: '1:2',
    length: '7',
    modifiedNanos: '123456789',
    sha256: 'a'.repeat(64),
  };

  it('decodes the strict camelCase file-version wire contract', () => {
    expect(decodeFileVersion(fileVersion)).toEqual(fileVersion);
    expect(decodeFileVersion({
      ...fileVersion,
      length: '18446744073709551615',
      modifiedNanos: '340282366920938463463374607431768211455',
    })).toMatchObject({
      length: '18446744073709551615',
      modifiedNanos: '340282366920938463463374607431768211455',
    });

    for (const invalid of [
      { ...fileVersion, canonicalPath: '' },
      { ...fileVersion, platformIdentity: '' },
      { ...fileVersion, length: 7 },
      { ...fileVersion, length: '07' },
      { ...fileVersion, length: '18446744073709551616' },
      { ...fileVersion, modifiedNanos: '340282366920938463463374607431768211456' },
      { ...fileVersion, sha256: 'A'.repeat(64) },
      { ...fileVersion, unexpected: true },
    ]) {
      expect(() => decodeFileVersion(invalid)).toThrow('Invalid file version');
    }
  });

  it('keeps the shared file-kind fixture exhaustive', () => {
    const allKinds = {
      markdown: 'text',
      html: 'text',
      excalidraw: 'text',
      image: 'binary',
      video: 'binary',
      audio: 'binary',
      pdf: 'binary',
      docx: 'binary',
    } as const satisfies Record<WorkspaceFileKind, 'text' | 'binary'>;

    expect(Object.keys(allKinds)).toEqual([
      'markdown',
      'html',
      'excalidraw',
      'image',
      'video',
      'audio',
      'pdf',
      'docx',
    ]);
  });

  it('decode_workspace_file_kind_rejects_unknown_missing_and_non_string_without_path_classification', () => {
    for (const kind of ['markdown', 'html', 'excalidraw', 'image', 'video', 'audio', 'pdf', 'docx'] as const) {
      expect(decodeWorkspaceFileKind(kind)).toBe(kind);
    }

    for (const value of [undefined, null, 42, {}, [], 'epub', 'Markdown', '/workspace/notes.md']) {
      expect(() => decodeWorkspaceFileKind(value)).toThrow('Invalid workspace file kind');
    }
  });

  it('decode_open_file_response_validates_content_mode_and_shape', () => {
    const validResponses = [
      {
        kind: 'markdown',
        path: '/workspace/notes.md',
        content_mode: 'text',
        content: '# Notes',
        file_version: fileVersion,
      },
      {
        kind: 'html',
        path: '/workspace/page.xhtml',
        content_mode: 'text',
        content: '<main>Page</main>',
        mime_type: 'application/xhtml+xml',
        file_version: fileVersion,
      },
      {
        kind: 'image',
        path: '/workspace/pixel.png',
        content_mode: 'binary',
        mime_type: 'image/png',
      },
      {
        kind: 'video',
        path: '/workspace/clip.mp4',
        content_mode: 'binary',
        mime_type: 'video/mp4',
      },
      {
        kind: 'audio',
        path: '/workspace/track.mp3',
        content_mode: 'binary',
        mime_type: 'audio/mpeg',
      },
    ];

    for (const response of validResponses) {
      expect(decodeOpenFileResponse(response)).toEqual(response);
    }

    const invalidResponses = [
      { kind: 'markdown', path: '/workspace/notes.md', content_mode: 'binary', content: '# Notes' },
      { kind: 'markdown', path: '/workspace/notes.md', content_mode: 'text' },
      { kind: 'markdown', path: '/workspace/notes.md', content_mode: 'text', content: '# Notes' },
      {
        kind: 'html',
        path: '/workspace/page.html',
        content_mode: 'text',
        content: '<main>Page</main>',
      },
      { kind: 'image', path: '/workspace/pixel.png', content_mode: 'text', mime_type: 'image/png' },
      {
        kind: 'image',
        path: '/workspace/pixel.png',
        content_mode: 'binary',
        content: 'not binary',
        mime_type: 'image/png',
      },
      { kind: 'video', path: '/workspace/clip.mp4', content_mode: 'binary' },
      { kind: 'audio', path: 42, content_mode: 'binary', mime_type: 'audio/mpeg' },
    ];

    for (const response of invalidResponses) {
      expect(() => decodeOpenFileResponse(response)).toThrow('Invalid open file response');
    }
  });

  it('decode_workspace_snapshot_rejects_unknown_entry_kind_before_state_application', () => {
    const validSnapshot = {
      workspace_token: 'workspace-7',
      root: '/workspace',
      files: [
        {
          kind: 'markdown',
          path: '/workspace/notes.md',
          relative_path: 'notes.md',
          name: 'notes.md',
        },
      ],
      directories: [
        {
          path: '/workspace/assets',
          relative_path: 'assets',
          name: 'assets',
        },
      ],
    };

    expect(decodeWorkspaceSnapshot(validSnapshot)).toEqual(validSnapshot);

    let applied = false;
    const decodeThenApply = (value: unknown) => {
      const snapshot = decodeWorkspaceSnapshot(value);
      applied = true;
      return snapshot;
    };

    expect(() =>
      decodeThenApply({
        ...validSnapshot,
        files: [
          {
            kind: 'epub',
            path: '/workspace/document.epub',
            relative_path: 'document.epub',
            name: 'document.epub',
          },
        ],
      }),
    ).toThrow('Invalid workspace snapshot');
    expect(applied).toBe(false);
  });

  it('workspace_presentation_is_exhaustive_for_all_decoded_kinds', () => {
    expect(getWorkspacePresentation('markdown')).toEqual({ editor: 'markdown', preview: 'jinxiu-markdown' });
    expect(getWorkspacePresentation('html')).toEqual({ editor: 'html', preview: 'html' });
    expect(getWorkspacePresentation('image')).toEqual({ preview: 'image' });
    expect(getWorkspacePresentation('video')).toEqual({ media_kind: 'video', preview: 'media' });
    expect(getWorkspacePresentation('audio')).toEqual({ media_kind: 'audio', preview: 'media' });
  });

  it('typescript_decoders_consume_rust_wire_fixtures_as_unknown', () => {
    const canonical = fixtureRecord(canonicalWireFixture);
    const openFileResponses = fixtureArray(canonical.open_file_responses);
    const versionedOpenFileResponses = openFileResponses.map((value) => {
      const response = fixtureRecord(value);
      return response.content_mode === 'text' ? { ...response, file_version: fileVersion } : response;
    });
    expect(versionedOpenFileResponses.map((value) => decodeOpenFileResponse(value))).toEqual(
      versionedOpenFileResponses,
    );

    const snapshotReceipts = fixtureRecord(canonical.snapshot_receipts);
    for (const key of ['fresh', 'stale', 'not_applicable']) {
      expect(decodeSnapshotReceipt(snapshotReceipts[key])).toEqual(snapshotReceipts[key]);
    }

    const mutationOutcomes = fixtureRecord(canonical.mutation_outcomes);
    for (const key of ['confirmed_not_committed', 'confirmed_committed', 'indeterminate']) {
      expect(decodeMutationOutcome(mutationOutcomes[key], decodeCommittedPath)).toEqual(mutationOutcomes[key]);
    }

    const malformed = fixtureRecord(malformedWireFixture);
    for (const key of [
      'externally_tagged_snapshot_receipt',
      'tuple_snapshot_receipt',
      'camel_case_stale_receipt',
    ]) {
      expect(() => decodeSnapshotReceipt(malformed[key])).toThrow('Invalid snapshot receipt');
    }

    for (const key of [
      'externally_tagged_mutation_outcome',
      'tuple_mutation_outcome',
      'camel_case_indeterminate_outcome',
      'missing_branch_field',
      'extra_branch_field',
    ]) {
      expect(() => decodeMutationOutcome(malformed[key], decodeCommittedPath)).toThrow('Invalid mutation outcome');
    }

    for (const key of ['text_without_content', 'binary_with_content', 'unknown_open_file_kind']) {
      expect(() => decodeOpenFileResponse(malformed[key])).toThrow('Invalid open file response');
    }

    expect(() => decodeWorkspaceSnapshot(malformed.snapshot_with_unknown_entry_kind)).toThrow(
      'Invalid workspace snapshot',
    );

    const freshReceipt = fixtureRecord(snapshotReceipts.fresh);
    expect(() => decodeSnapshotReceipt({ ...freshReceipt, unexpected: true })).toThrow('Invalid snapshot receipt');
    expect(() =>
      decodeSnapshotReceipt({ status: 'stale', workspace_token: 'workspace-7' }),
    ).toThrow('Invalid snapshot receipt');
  });

  it('decode_mutation_outcome_rejects_unknown_operation', () => {
    expect(() =>
      decodeMutationOutcome(
        {
          status: 'indeterminate',
          operation: 'anything',
          paths: ['/workspace/notes.md'],
          recovery_message: 'inspect the workspace',
        },
        decodeCommittedPath,
      ),
    ).toThrow('Invalid mutation outcome');
  });

  it('decode_mutation_outcome_accepts_delete_indeterminate', () => {
    const outcome = {
      status: 'indeterminate' as const,
      operation: 'delete' as const,
      paths: ['/workspace/drafts'],
      recovery_message: 'refresh the workspace before retrying',
    };

    expect(decodeMutationOutcome(outcome, decodeCommittedPath)).toEqual(outcome);
  });

  it('decode_open_file_response_rejects_blank_mime_type', () => {
    expect(() =>
      decodeOpenFileResponse({
        kind: 'html',
        path: '/workspace/page.html',
        content_mode: 'text',
        content: '<main>Page</main>',
        mime_type: '   ',
      }),
    ).toThrow('Invalid open file response');
    expect(() =>
      decodeOpenFileResponse({
        kind: 'image',
        path: '/workspace/pixel.png',
        content_mode: 'binary',
        mime_type: '',
      }),
    ).toThrow('Invalid open file response');
  });

  it('open_file_and_snapshot_decoders_reject_non_records_and_extra_fields', () => {
    for (const value of [null, 42, 'wire value', []]) {
      expect(() => decodeOpenFileResponse(value)).toThrow('Invalid open file response');
      expect(() => decodeWorkspaceSnapshot(value)).toThrow('Invalid workspace snapshot');
    }

    expect(() =>
      decodeOpenFileResponse({
        kind: 'markdown',
        path: '/workspace/notes.md',
        content_mode: 'text',
        content: '# Notes',
        unexpected: true,
      }),
    ).toThrow('Invalid open file response');

    expect(() =>
      decodeWorkspaceSnapshot({
        workspace_token: 'workspace-7',
        root: '/workspace',
        files: [],
        directories: [],
        unexpected: true,
      }),
    ).toThrow('Invalid workspace snapshot');
  });
});
