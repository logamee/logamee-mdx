import type { OpenCommitStatus, OpenFileResponse, PreparedOpenFileResponse } from '../types';
import { getOpenedDocumentState } from './documentSessionWorkspace';
import type { DocumentSessionState, ProvisionalDocumentTransition } from './documentSessionTypes';
import type { OpenCommitResult } from '../types';

export function createProvisionalDocumentTransition(
  current: DocumentSessionState,
  response: OpenFileResponse,
  identity: Pick<DocumentSessionState, 'documentId' | 'documentEpoch'>,
): ProvisionalDocumentTransition {
  return {
    prior: { ...current },
    provisional: {
      ...getOpenedDocumentState(response),
      ...identity,
      authorityStatus: 'provisional',
    },
  };
}

export function finalizeProvisionalDocument(
  provisional: DocumentSessionState,
): DocumentSessionState {
  return { ...provisional, authorityStatus: 'committed' };
}

export function restoreDocumentSnapshot(snapshot: DocumentSessionState): DocumentSessionState {
  return { ...snapshot };
}

export function nextPreparedOpenGeneration(
  currentGeneration: number,
  requestedGeneration: number,
  prepared: PreparedOpenFileResponse | null,
): number | null {
  if (!prepared || currentGeneration !== requestedGeneration) return null;
  return currentGeneration + 1;
}

interface OpenCommitPorts {
  commit: (openReceipt: string) => Promise<OpenCommitResult>;
  getStatus: (commitOperationId: string) => Promise<OpenCommitStatus>;
  waitBeforeRetry?: () => Promise<void>;
}

const OPEN_COMMIT_STATUS_CHECK_LIMIT = 3;
const OPEN_COMMIT_STATUS_RETRY_DELAY_MS = 50;

function waitBeforeOpenCommitStatusRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, OPEN_COMMIT_STATUS_RETRY_DELAY_MS);
  });
}

export async function resolveOpenCommitOutcome(
  prepared: PreparedOpenFileResponse,
  ports: OpenCommitPorts,
): Promise<OpenCommitStatus> {
  try {
    return await ports.commit(prepared.open_receipt);
  } catch {
    // The backend may have committed before the IPC response was lost.
  }

  for (let attempt = 0; attempt < OPEN_COMMIT_STATUS_CHECK_LIMIT; attempt += 1) {
    let status: OpenCommitStatus;
    try {
      status = await ports.getStatus(prepared.commit_operation_id);
    } catch {
      return { status: 'unknown' };
    }
    if (status.status !== 'pending') return status;
    if (attempt + 1 < OPEN_COMMIT_STATUS_CHECK_LIMIT) {
      try {
        await (ports.waitBeforeRetry ?? waitBeforeOpenCommitStatusRetry)();
      } catch {
        return { status: 'unknown' };
      }
    }
  }

  return { status: 'unknown' };
}
