import { describe, expect, it } from 'vitest';
import binaryWireFixture from '../../test-fixtures/p2/binary-open-wire.json';
import type { WorkspaceFileKind } from '../types';
import {
  type DocumentState,
  getOpenedDocumentState,
  isDocumentDirty,
  isEditableFileKind,
} from './documentSession';
import {
  PaneReplication,
  type PaneCache,
  type PaneReplicatedState,
  type PaneSnapshotEnvelope,
  type PaneTransport,
} from './paneSync';
import { shouldShowUnsavedExitPrompt } from './closeGuard';
import { getWorkspaceLayoutClassName } from './sidebarLayout';
import {
  decodeOpenFileResponse,
  decodeWorkspaceFileKind,
  getWorkspacePresentation,
} from './workspaceFileKind';

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SOURCE_BYTE_LIMITS = {
  pdf: 64 * 1024 * 1024,
  docx: 32 * 1024 * 1024,
} as const;

type BinaryKind = keyof typeof SOURCE_BYTE_LIMITS;

function binaryResponse(kind: BinaryKind, bytesBase64: string) {
  return {
    kind,
    path: `/workspace/document.${kind}`,
    content_mode: 'binary',
    mime_type: kind === 'pdf' ? PDF_MIME : DOCX_MIME,
    bytes_base64: bytesBase64,
  };
}

function canonicalZeroBytesBase64(byteLength: number): string {
  const completeTriples = Math.floor(byteLength / 3);
  const remainder = byteLength % 3;
  return `${'AAAA'.repeat(completeTriples)}${remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : ''}`;
}

describe('P2 binary file policy', () => {
  it('keeps all workspace kinds exhaustive with PDF and DOCX in binary mode', () => {
    const contentModes = {
      markdown: 'text',
      html: 'text',
      excalidraw: 'text',
      image: 'binary',
      video: 'binary',
      audio: 'binary',
      pdf: 'binary',
      docx: 'binary',
    } as const satisfies Record<WorkspaceFileKind, 'text' | 'binary'>;

    expect(Object.keys(contentModes)).toEqual([
      'markdown',
      'html',
      'excalidraw',
      'image',
      'video',
      'audio',
      'pdf',
      'docx',
    ]);
    expect(['pdf', 'docx'].map(decodeWorkspaceFileKind)).toEqual(['pdf', 'docx']);
  });

  it('accepts only the exact PDF and DOCX MIME, keys, binary mode, and bytes field', () => {
    for (const response of binaryWireFixture.valid) {
      expect(decodeOpenFileResponse(response)).toEqual(response);
    }

    for (const response of Object.values(binaryWireFixture.invalid)) {
      expect(() => decodeOpenFileResponse(response)).toThrow('Invalid open file response');
    }
  });

  it('rejects empty, malformed, padded-bit-noncanonical, URL-safe, and data-URL base64', () => {
    for (const bytesBase64 of binaryWireFixture.invalid_base64) {
      expect(() => decodeOpenFileResponse(binaryResponse('pdf', bytesBase64))).toThrow(
        'Invalid open file response',
      );
    }

    expect(() => decodeOpenFileResponse({
      ...binaryResponse('docx', 'UEsDBBQAAAAA'),
      bytes_base64: 42,
    })).toThrow('Invalid open file response');
  });

  it.each([
    ['pdf', SOURCE_BYTE_LIMITS.pdf],
    ['docx', SOURCE_BYTE_LIMITS.docx],
  ] as const)('accepts %s at its exact source limit and rejects one decoded byte more', (kind, limit) => {
    const atLimit = canonicalZeroBytesBase64(limit);
    const overLimit = canonicalZeroBytesBase64(limit + 1);

    expect(decodeOpenFileResponse(binaryResponse(kind, atLimit))).toMatchObject({
      kind,
      bytes_base64: atLimit,
    });
    expect(() => decodeOpenFileResponse(binaryResponse(kind, overLimit))).toThrow(
      'Invalid open file response',
    );
  }, 20_000);

  it('applies binary documents as read-only, saved-equivalent sessions with no save or close guard', () => {
    for (const value of binaryWireFixture.valid) {
      const response = decodeOpenFileResponse(value);
      const state = getOpenedDocumentState(response);

      expect(state).toEqual({
        activeFileKind: value.kind,
        activeMimeType: value.mime_type,
        activePath: value.path,
        bytesBase64: value.bytes_base64,
        content: '',
        lastSavedContent: '',
        previewRevision: 0,
      });
      const clearedBinarySource = {
        ...state,
        bytesBase64: null,
      } satisfies DocumentState;
      expect(clearedBinarySource.bytesBase64).toBeNull();
      expect(isEditableFileKind(state.activeFileKind)).toBe(false);
      expect(isDocumentDirty(state)).toBe(false);
      expect(isDocumentDirty({ ...state, content: 'blocked mutation' })).toBe(false);
      expect(shouldShowUnsavedExitPrompt({ dirty: isDocumentDirty(state), isPopout: false })).toBe(false);
    }
  });

  it('routes PDF and DOCX to a single preview surface without an editor or resizer layout', () => {
    for (const kind of ['pdf', 'docx'] as const) {
      const decodedKind = decodeWorkspaceFileKind(kind);
      const presentation = getWorkspacePresentation(decodedKind);

      expect(presentation).toEqual({ preview: kind });
      expect('editor' in presentation).toBe(false);
      expect(getWorkspaceLayoutClassName(false, decodedKind).split(' ')).toContain('document-mode');
    }
  });

  it('round-trips dedicated binary source bytes through pane replication', async () => {
    const listeners = new Set<(input: unknown) => void>();
    const transport: PaneTransport = {
      emit(input) {
        for (const listener of listeners) listener(input);
      },
      listen(listener) {
        listeners.add(listener);
        return Promise.resolve(() => listeners.delete(listener));
      },
    };
    const cache: PaneCache = {
      read: () => null,
      remove: () => undefined,
      write: () => undefined,
    };
    const observed: PaneSnapshotEnvelope[] = [];
    const response = decodeOpenFileResponse(binaryWireFixture.valid[0]);
    if (response.kind !== 'pdf' && response.kind !== 'docx') {
      throw new Error('Expected a binary document fixture');
    }
    const state = {
      activeFileKind: response.kind,
      activeMimeType: response.mime_type,
      activePath: response.path,
      authorityStatus: 'committed',
      bytesBase64: response.bytes_base64,
      content: '',
      lastSavedContent: '',
      workspaceRoot: '/workspace',
      documentId: 'binary-document',
      previewRevision: 0,
      documentEpoch: 1,
    } satisfies PaneReplicatedState;
    const mainReplication = new PaneReplication({
      role: 'main',
      authorityId: 'main-authority',
      cache,
      transport,
      observe: () => undefined,
    });
    const previewReplication = new PaneReplication({
      role: 'preview-popout',
      requesterId: 'preview-requester',
      cache,
      transport,
      observe: (snapshot) => observed.push(snapshot),
    });

    mainReplication.start();
    previewReplication.start();
    await Promise.resolve();
    mainReplication.publishAuthoritativeState(state);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.state).toEqual(state);
    expect(observed[0]?.state).toMatchObject({
      bytesBase64: response.bytes_base64,
      content: '',
      lastSavedContent: '',
    });

    mainReplication.dispose();
    previewReplication.dispose();
  });
});
