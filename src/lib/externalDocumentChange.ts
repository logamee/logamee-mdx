import {
  isDocumentDirty,
  isEditableFileKind,
  type DocumentSessionState,
} from './documentSession';
import type { ActiveDocumentWatchSnapshotEnvelope } from './activeDocumentWatch';
import type { OpenFileResponse } from '../types';

function isEditableOpenFile(
  file: OpenFileResponse,
): file is Extract<OpenFileResponse, { kind: 'markdown' | 'html' | 'excalidraw' }> {
  return file.kind === 'markdown' || file.kind === 'html' || file.kind === 'excalidraw';
}

export type ExternalDocumentChangeDecision =
  | { kind: 'apply-document'; state: DocumentSessionState }
  | { kind: 'show-conflict'; envelope: ActiveDocumentWatchSnapshotEnvelope }
  | { kind: 'show-deleted-draft'; envelope: ActiveDocumentWatchSnapshotEnvelope }
  | { kind: 'close-with-notice'; path: string }
  | { kind: 'ignore' };

export function reduceExternalDocumentChange(
  current: DocumentSessionState,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
): ExternalDocumentChangeDecision {
  if (current.authorityStatus !== 'committed') {
    return { kind: 'ignore' };
  }

  if (envelope.snapshot.status === 'missing') {
    if (current.activePath !== envelope.snapshot.path) return { kind: 'ignore' };
    if (isEditableFileKind(current.activeFileKind) && isDocumentDirty(current)) {
      return { kind: 'show-deleted-draft', envelope };
    }
    return { kind: 'close-with-notice', path: envelope.snapshot.path };
  }

  const { file, preview_revision: previewRevision } = envelope.snapshot;
  if (file.kind !== current.activeFileKind) {
    return { kind: 'ignore' };
  }

  if (!isEditableOpenFile(file)) {
    return {
      kind: 'apply-document',
      state: {
        ...current,
        activeMimeType: file.mime_type,
        activePath: file.path,
        bytesBase64: file.kind === 'pdf' || file.kind === 'docx' ? file.bytes_base64 : null,
        content: '',
        documentEpoch: current.documentEpoch + 1,
        lastSavedContent: '',
        previewRevision,
      },
    };
  }

  if (file.content === current.content) {
    return {
      kind: 'apply-document',
      state: {
        ...current,
        activeMimeType: file.mime_type ?? null,
        activePath: file.path,
        lastSavedContent: file.content,
        previewRevision,
      },
    };
  }

  if (current.content === current.lastSavedContent) {
    return {
      kind: 'apply-document',
      state: {
        ...current,
        activeMimeType: file.mime_type ?? null,
        activePath: file.path,
        content: file.content,
        documentEpoch: current.documentEpoch + 1,
        lastSavedContent: file.content,
        previewRevision,
      },
    };
  }

  return { kind: 'show-conflict', envelope };
}

export function coalesceExternalConflict(
  current: ActiveDocumentWatchSnapshotEnvelope | null,
  next: ActiveDocumentWatchSnapshotEnvelope,
): ActiveDocumentWatchSnapshotEnvelope {
  if (!current) return next;
  const sameIdentity = current.watch_id === next.watch_id
    && current.document_id === next.document_id
    && current.document_generation === next.document_generation;
  return sameIdentity && next.sequence > current.sequence ? next : current;
}

export function resolveKeepCurrent(
  currentAtApply: DocumentSessionState,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
): ExternalDocumentChangeDecision {
  if (envelope.document_id !== currentAtApply.documentId) return { kind: 'ignore' };
  if (envelope.snapshot.status === 'missing') {
    return reduceExternalDocumentChange(currentAtApply, envelope);
  }

  const { file, preview_revision: previewRevision } = envelope.snapshot;
  if (
    currentAtApply.authorityStatus !== 'committed'
    || file.kind !== currentAtApply.activeFileKind
    || !isEditableOpenFile(file)
  ) {
    return { kind: 'ignore' };
  }

  return {
    kind: 'apply-document',
    state: {
      ...currentAtApply,
      activeMimeType: file.mime_type ?? null,
      activePath: file.path,
      lastSavedContent: file.content,
      previewRevision,
    },
  };
}

export function resolveUseExternal(
  currentAtApply: DocumentSessionState,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
): ExternalDocumentChangeDecision {
  if (envelope.document_id !== currentAtApply.documentId) return { kind: 'ignore' };
  if (envelope.snapshot.status === 'missing') {
    return reduceExternalDocumentChange(currentAtApply, envelope);
  }

  const { file, preview_revision: previewRevision } = envelope.snapshot;
  if (
    currentAtApply.authorityStatus !== 'committed'
    || file.kind !== currentAtApply.activeFileKind
    || !isEditableOpenFile(file)
  ) {
    return { kind: 'ignore' };
  }

  return {
    kind: 'apply-document',
    state: {
      ...currentAtApply,
      activeMimeType: file.mime_type ?? null,
      activePath: file.path,
      content: file.content,
      documentEpoch: currentAtApply.documentEpoch + 1,
      lastSavedContent: file.content,
      previewRevision,
    },
  };
}
