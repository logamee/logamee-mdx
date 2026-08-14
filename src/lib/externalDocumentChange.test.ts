import { describe, expect, it } from 'vitest';
import type { DocumentSessionState } from './documentSession';
import {
  coalesceExternalConflict,
  reduceExternalDocumentChange,
  resolveKeepCurrent,
  resolveUseExternal,
} from './externalDocumentChange';

const fileVersion = {
  canonicalPath: '/workspace/notes.md', platformIdentity: '1', length: '7', modifiedNanos: '1', sha256: 'd'.repeat(64),
};

function editableState(overrides: Partial<DocumentSessionState> = {}): DocumentSessionState {
  return {
    documentId: 'pane-document-1',
    documentEpoch: 4,
    authorityStatus: 'committed',
    activeFileKind: 'markdown',
    activeMimeType: null,
    activePath: '/workspace/notes.md',
    bytesBase64: null,
    content: '# Current',
    lastSavedContent: '# Saved',
    previewRevision: 1,
    ...overrides,
  };
}

describe('external document change decisions', () => {
  it('converges without a prompt when disk text already equals the editor', () => {
    const current = editableState();
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: current.documentId,
      document_generation: 7,
      sequence: 2,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# Current',
          file_version: fileVersion,
        },
        preview_revision: 2,
      },
    } as const;

    expect(reduceExternalDocumentChange(current, envelope)).toEqual({
      kind: 'apply-document',
      state: {
        ...current,
        lastSavedContent: '# Current',
        previewRevision: 2,
      },
    });
  });

  it('reloads a clean editable document and advances its epoch', () => {
    const current = editableState({ content: '# Saved', lastSavedContent: '# Saved' });
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: current.documentId,
      document_generation: 7,
      sequence: 3,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# External',
          file_version: fileVersion,
        },
        preview_revision: 3,
      },
    } as const;

    expect(reduceExternalDocumentChange(current, envelope)).toEqual({
      kind: 'apply-document',
      state: {
        ...current,
        content: '# External',
        documentEpoch: 5,
        lastSavedContent: '# External',
        previewRevision: 3,
      },
    });
  });

  it('prompts when dirty editor text and disk text are distinct', () => {
    const current = editableState();
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: current.documentId,
      document_generation: 7,
      sequence: 4,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# External',
          file_version: fileVersion,
        },
        preview_revision: 4,
      },
    } as const;

    expect(reduceExternalDocumentChange(current, envelope)).toEqual({
      kind: 'show-conflict',
      envelope,
    });
  });

  it('reloads a read-only binary document with new bytes and revision', () => {
    const current = editableState({
      activeFileKind: 'pdf',
      activeMimeType: 'application/pdf',
      bytesBase64: 'AQ==',
      content: '',
      lastSavedContent: '',
    });
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: current.documentId,
      document_generation: 7,
      sequence: 5,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'pdf',
          path: '/workspace/notes.pdf',
          content_mode: 'binary',
          mime_type: 'application/pdf',
          bytes_base64: 'Ag==',
        },
        preview_revision: 5,
      },
    } as const;

    expect(reduceExternalDocumentChange(current, envelope)).toEqual({
      kind: 'apply-document',
      state: {
        ...current,
        activePath: '/workspace/notes.pdf',
        bytesBase64: 'Ag==',
        documentEpoch: 5,
        previewRevision: 5,
      },
    });
  });

  it('preserves a dirty editable draft when the watched file is confirmed missing', () => {
    const current = editableState();
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: current.documentId,
      document_generation: 7,
      sequence: 6,
      reason: 'missing',
      previous_path: null,
      snapshot: {
        status: 'missing',
        path: '/workspace/notes.md',
      },
    } as const;

    expect(reduceExternalDocumentChange(current, envelope)).toEqual({
      kind: 'show-deleted-draft',
      envelope,
    });
  });

  it('coalesces a conflict to the newest sequence for the same watch identity', () => {
    const current = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: 'pane-document-1',
      document_generation: 7,
      sequence: 4,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# First',
          file_version: fileVersion,
        },
        preview_revision: 4,
      },
    } as const;
    const newest = {
      ...current,
      sequence: 6,
      snapshot: {
        ...current.snapshot,
        file: { ...current.snapshot.file, content: '# Newest' },
        preview_revision: 6,
      },
    } as const;

    expect(coalesceExternalConflict(current, newest)).toEqual(newest);
  });

  it('keeps apply-time editor content while advancing the external baseline', () => {
    const currentAtApply = editableState({ content: '# Popout edit while waiting' });
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: currentAtApply.documentId,
      document_generation: 7,
      sequence: 7,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# External',
          file_version: fileVersion,
        },
        preview_revision: 7,
      },
    } as const;

    expect(resolveKeepCurrent(currentAtApply, envelope)).toEqual({
      kind: 'apply-document',
      state: {
        ...currentAtApply,
        lastSavedContent: '# External',
        previewRevision: 7,
      },
    });
  });

  it('uses the latest external text and advances the document epoch', () => {
    const currentAtApply = editableState({ content: '# Dirty now' });
    const envelope = {
      protocol_version: 1,
      watch_id: 'watch-1',
      document_id: currentAtApply.documentId,
      document_generation: 7,
      sequence: 8,
      reason: 'changed',
      previous_path: null,
      snapshot: {
        status: 'present',
        file: {
          kind: 'markdown',
          path: '/workspace/notes.md',
          content_mode: 'text',
          content: '# Latest external',
          file_version: fileVersion,
        },
        preview_revision: 8,
      },
    } as const;

    expect(resolveUseExternal(currentAtApply, envelope)).toEqual({
      kind: 'apply-document',
      state: {
        ...currentAtApply,
        content: '# Latest external',
        documentEpoch: 5,
        lastSavedContent: '# Latest external',
        previewRevision: 8,
      },
    });
  });
});
