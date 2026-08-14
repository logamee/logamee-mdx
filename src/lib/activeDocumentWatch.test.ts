import { describe, expect, it } from 'vitest';
import canonicalWireFixture from '../../test-fixtures/tauri-wire/canonical.json';
import malformedWireFixture from '../../test-fixtures/tauri-wire/malformed.json';
import {
  decodeActiveDocumentWatchEvent,
  decodeActiveDocumentWatchRegistration,
  decodeActiveDocumentWatchSnapshotEnvelope,
} from './activeDocumentWatch';

describe('active document watch protocol', () => {
  it('decodes a canonical present-text registration', () => {
    const registration = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: 'pane-document-1',
      document_generation: 7,
      sequence: 1,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# External',
          file_version: { canonicalPath: '/workspace/notes.md', platformIdentity: '1', length: '10', modifiedNanos: '1', sha256: 'a'.repeat(64) },
        },
        preview_revision: 1,
      },
    } as const;

    expect(decodeActiveDocumentWatchRegistration(registration)).toEqual(registration);
  });

  it('decodes a canonical renamed snapshot envelope', () => {
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: 'pane-document-1',
      document_generation: 7,
      sequence: 2,
      reason: 'renamed',
      previous_path: '/workspace/notes.md',
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/renamed.md',
          content_mode: 'text',
          content: '# Renamed',
          file_version: { canonicalPath: '/workspace/renamed.md', platformIdentity: '1', length: '9', modifiedNanos: '2', sha256: 'b'.repeat(64) },
        },
        preview_revision: 2,
      },
    } as const;

    expect(decodeActiveDocumentWatchSnapshotEnvelope(envelope)).toEqual(envelope);
  });

  it('decodes a canonical degraded health event', () => {
    const event = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: 'pane-document-1',
      document_generation: 7,
      sequence: 3,
      event: {
        kind: 'health',
        status: 'degraded',
        message: 'Monitoring is temporarily retrying.',
      },
    } as const;

    expect(decodeActiveDocumentWatchEvent(event)).toEqual(event);
  });

  it('decodes every canonical shared watch fixture', () => {
    const canonical = canonicalWireFixture.active_document_watch;
    for (const key of [
      'registration_present_text',
      'registration_present_pdf',
      'registration_missing',
    ] as const) {
      expect(decodeActiveDocumentWatchRegistration(canonical[key])).toEqual(canonical[key]);
    }
    expect(decodeActiveDocumentWatchSnapshotEnvelope(canonical.snapshot_resync))
      .toEqual(canonical.snapshot_resync);
    for (const key of [
      'state_changed',
      'state_renamed',
      'state_missing',
      'health_degraded',
      'health_failed',
    ] as const) {
      expect(decodeActiveDocumentWatchEvent(canonical[key])).toEqual(canonical[key]);
    }
  });

  it('rejects malformed shared watch fixtures without partial acceptance', () => {
    const malformed = malformedWireFixture.active_document_watch;
    for (const key of [
      'registration_extra_key',
      'registration_wrong_version',
      'registration_bad_watch_id',
      'registration_unsafe_generation',
      'present_pdf_invalid_base64',
    ] as const) {
      expect(() => decodeActiveDocumentWatchRegistration(malformed[key]))
        .toThrow('Invalid active document watch registration');
    }
    expect(() => decodeActiveDocumentWatchSnapshotEnvelope(malformed.snapshot_fractional_sequence))
      .toThrow('Invalid active document watch snapshot envelope');
    for (const key of [
      'state_reason_mismatch',
      'rename_without_previous_path',
      'health_unknown_status',
      'health_raw_error_object',
    ] as const) {
      expect(() => decodeActiveDocumentWatchEvent(malformed[key]))
        .toThrow('Invalid active document watch event');
    }
  });
});
