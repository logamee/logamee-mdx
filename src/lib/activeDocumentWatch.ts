import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { decodeActiveDocumentWatchEvent } from './activeDocumentWatchEvents';
import {
  decodeActiveDocumentWatchRegistration,
  decodeActiveDocumentWatchSnapshotEnvelope,
} from './activeDocumentWatchDecode';
import type { ActiveDocumentWatchTransport } from './activeDocumentWatchTypes';

const ACTIVE_DOCUMENT_WATCH_EVENT = 'mmd-active-document-watch';

export { decodeActiveDocumentWatchEvent } from './activeDocumentWatchEvents';
export { decodeActiveDocumentWatchRegistration, decodeActiveDocumentWatchSnapshotEnvelope } from './activeDocumentWatchDecode';
export type {
  ActiveDocumentWatchEvent,
  ActiveDocumentWatchRegistration,
  ActiveDocumentWatchSnapshotEnvelope,
  ActiveDocumentWatchTransport,
} from './activeDocumentWatchTypes';

function decodeBoolean(value: unknown, command: string): boolean {
  if (value !== true) throw new Error(`Invalid ${command} response`);
  return value;
}

export function createTauriActiveDocumentWatchTransport(
  options: { onError?: (error: unknown) => void } = {},
): ActiveDocumentWatchTransport {
  return {
    async start(path, documentId, documentGeneration) {
      return decodeActiveDocumentWatchRegistration(await invoke<unknown>(
        'start_active_document_watch',
        { path, documentId, documentGeneration },
      ));
    },
    async activate(watchId, documentId, documentGeneration, registrationSequence) {
      return decodeBoolean(await invoke<unknown>('activate_active_document_watch', {
        watchId,
        documentId,
        documentGeneration,
        registrationSequence,
      }), 'active document watch activation');
    },
    async reconcile(watchId, documentId, documentGeneration) {
      return decodeActiveDocumentWatchSnapshotEnvelope(await invoke<unknown>(
        'reconcile_active_document_watch',
        { watchId, documentId, documentGeneration },
      ));
    },
    async stop(watchId) {
      return decodeBoolean(
        await invoke<unknown>('stop_active_document_watch', { watchId }),
        'active document watch stop',
      );
    },
    listen(callback) {
      return listen<unknown>(ACTIVE_DOCUMENT_WATCH_EVENT, (event) => {
        try {
          callback(decodeActiveDocumentWatchEvent(event.payload));
        } catch (error) {
          options.onError?.(error);
        }
      });
    },
  };
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
