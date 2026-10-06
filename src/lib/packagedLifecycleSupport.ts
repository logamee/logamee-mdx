import { resolveOpenCommitOutcome } from './documentSession';
import type {
  DeleteWorkspaceEntryResponse,
  DocumentSaveResponse,
  MutationOutcome,
  PreparedOpenFileResponse,
} from '../types';
import type {
  PackagedLifecycleE2ePorts,
  PackagedLifecycleE2eReceipt,
  PackagedLifecycleE2eSetup,
} from './packagedLifecycleSetup';

let operationSequence = 0;

export function operationId(kind: string): string {
  operationSequence += 1;
  return `packaged-lifecycle-${kind}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function receiptIdentity(
  setup: PackagedLifecycleE2eSetup,
): Promise<Omit<
  PackagedLifecycleE2eReceipt,
  'status' | 'saveSuccess' | 'staleCas' | 'trash' | 'error'
>> {
  return {
    schema: 2,
    gate: 'packaged-lifecycle-e2e',
    target: setup.workflow.target,
    runId: setup.workflow.run_id,
    runAttempt: setup.workflow.run_attempt,
    commit: setup.workflow.commit,
    buildFlavor: 'ci-instrumented-packaged-e2e',
    instrumentationFeature: 'packaged-lifecycle-e2e',
    packageVariant: setup.package_variant,
    packagedAppProcess: true,
    tauriRuntime: true,
    webviewBootstrap: true,
    normalInvokeHandlers: true,
    uiDriven: false,
    releaseArtifactEquivalent: false,
    currentExeSha256: setup.current_exe_sha256,
    nonceDigest: await sha256(setup.nonce),
  };
}

export async function openCommittedText(
  ports: PackagedLifecycleE2ePorts,
  path: string,
  attempts = 1,
): Promise<PreparedOpenFileResponse & { file: Extract<PreparedOpenFileResponse['file'], { content_mode: 'text' }> }> {
  for (let attempt = 1; ; attempt += 1) {
    const prepared = await ports.openWorkspaceFile(path);
    const outcome = await resolveOpenCommitOutcome(prepared, {
      commit: ports.commitRecentOpen,
      getStatus: ports.getOpenCommitStatus,
    });
    if (outcome.status === 'committed') {
      if (prepared.file.content_mode !== 'text' || !('file_version' in prepared.file)) {
        throw new Error(`Expected text fixture: ${path}`);
      }
      return prepared as PreparedOpenFileResponse & {
        file: Extract<PreparedOpenFileResponse['file'], { content_mode: 'text' }>;
      };
    }
    const detail = outcome.status === 'not_committed' ? outcome.message : outcome.status;
    if (outcome.status !== 'not_committed' || attempt >= attempts) {
      throw new Error(`Open commit failed for ${path}: ${detail}`);
    }
    await ports.wait();
  }
}

export function requireCommittedSave(
  result: DocumentSaveResponse,
  label: string,
): asserts result is Extract<DocumentSaveResponse, { status: 'confirmed_committed' }> {
  if (result.status !== 'confirmed_committed') {
    throw new Error(result.status === 'indeterminate' ? `${label}: ${result.message}` : result.message);
  }
}

export function requireCommittedDelete(
  result: MutationOutcome<DeleteWorkspaceEntryResponse>,
  expectedPath: string,
): void {
  if (result.status !== 'confirmed-committed') {
    throw new Error(result.status === 'indeterminate' ? result.recovery_message : result.message);
  }
  if (result.receipt.committed.deleted_path !== expectedPath) {
    throw new Error(`Trash receipt path mismatch: ${expectedPath}`);
  }
}

export async function writeReceipt(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
  receipt: PackagedLifecycleE2eReceipt,
): Promise<void> {
  const prepared = await openCommittedText(ports, setup.paths.receipt);
  const result = await ports.writeFile(
    setup.paths.receipt,
    `${JSON.stringify(receipt, null, 2)}\n`,
    prepared.file.file_version,
    operationId('receipt'),
  );
  requireCommittedSave(result, 'Receipt write was not committed');
}
