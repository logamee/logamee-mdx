import type { MutationOutcome, SnapshotReceipt } from '../types';
import {
  hasExactKeys,
  invalidMutationOutcome,
  invalidSnapshotReceipt,
  isRecord,
} from './workspaceDecodePrimitives';
import { decodeWorkspaceSnapshot } from './workspaceSnapshotDecode';

function decodeStaleSnapshotReceipt(value: Record<string, unknown>): SnapshotReceipt | null {
  if (
    !hasExactKeys(value, ['status', 'workspace_token', 'repair_reason']) ||
    typeof value.workspace_token !== 'string' ||
    typeof value.repair_reason !== 'string'
  ) {
    return null;
  }
  return {
    status: 'stale',
    workspace_token: value.workspace_token,
    repair_reason: value.repair_reason,
  };
}

export function decodeSnapshotReceipt(value: unknown): SnapshotReceipt {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return invalidSnapshotReceipt();
  }

  if (value.status === 'fresh') {
    if (!hasExactKeys(value, ['status', 'snapshot'])) return invalidSnapshotReceipt();
    try {
      return { status: 'fresh', snapshot: decodeWorkspaceSnapshot(value.snapshot) };
    } catch {
      return invalidSnapshotReceipt();
    }
  }

  if (value.status === 'stale') {
    return decodeStaleSnapshotReceipt(value) ?? invalidSnapshotReceipt();
  }

  if (value.status === 'not-applicable') {
    if (!hasExactKeys(value, ['status'])) return invalidSnapshotReceipt();
    return { status: 'not-applicable' };
  }

  return invalidSnapshotReceipt();
}

function decodeNotCommittedMutationOutcome(
  value: Record<string, unknown>,
): MutationOutcome<never> | null {
  if (!hasExactKeys(value, ['status', 'message']) || typeof value.message !== 'string') {
    return null;
  }
  return { status: 'confirmed-not-committed', message: value.message };
}

function decodeIndeterminateMutationOutcome(
  value: Record<string, unknown>,
): MutationOutcome<never> | null {
  if (
    !hasExactKeys(value, ['status', 'operation', 'paths', 'recovery_message']) ||
    (value.operation !== 'create' &&
      value.operation !== 'delete' &&
      value.operation !== 'rename' &&
      value.operation !== 'write') ||
    !Array.isArray(value.paths) ||
    !value.paths.every((path) => typeof path === 'string') ||
    typeof value.recovery_message !== 'string'
  ) {
    return null;
  }
  return {
    status: 'indeterminate',
    operation: value.operation,
    paths: [...value.paths],
    recovery_message: value.recovery_message,
  };
}

export function decodeMutationOutcome<T>(
  value: unknown,
  decodeCommitted: (value: unknown) => T,
): MutationOutcome<T> {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return invalidMutationOutcome();
  }
  if (value.status === 'confirmed-not-committed') {
    return decodeNotCommittedMutationOutcome(value) ?? invalidMutationOutcome();
  }
  if (value.status === 'indeterminate') {
    return decodeIndeterminateMutationOutcome(value) ?? invalidMutationOutcome();
  }
  if (value.status !== 'confirmed-committed') return invalidMutationOutcome();
  return decodeCommittedMutationOutcome(value, decodeCommitted);
}

function decodeCommittedMutationOutcome<T>(
  value: Record<string, unknown>,
  decodeCommitted: (value: unknown) => T,
): MutationOutcome<T> {
  if (!hasExactKeys(value, ['status', 'receipt']) || !isRecord(value.receipt)) {
    return invalidMutationOutcome();
  }
  if (!hasExactKeys(value.receipt, ['committed', 'workspace'])) return invalidMutationOutcome();
  try {
    return {
      status: 'confirmed-committed',
      receipt: {
        committed: decodeCommitted(value.receipt.committed),
        workspace: decodeSnapshotReceipt(value.receipt.workspace),
      },
    };
  } catch {
    return invalidMutationOutcome();
  }
}
