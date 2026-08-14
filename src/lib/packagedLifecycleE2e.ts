import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import packagedPdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import type {
  DeleteWorkspaceEntryResponse,
  DocumentSaveResponse,
  MutationOutcome,
  OpenCommitResult,
  OpenCommitStatus,
  PreparedOpenFileResponse,
} from '../types';
import { resolveOpenCommitOutcome } from './documentSession';
import {
  commitRecentOpen,
  deleteWorkspaceEntry,
  getOpenCommitStatus,
  openWorkspaceFile,
  writeFile,
} from './tauriCommands';

export const PACKAGED_LIFECYCLE_CONTROL_READY = 'ready\n';
export const PACKAGED_LIFECYCLE_CONTROL_GO = 'go\n';
export const PACKAGED_LIFECYCLE_COMPETING_CONTENT = 'external competing bytes\n';

const SAVE_SUCCESS_CONTENT = 'packaged lifecycle saved\n';
const STALE_WRITE_CONTENT = 'runner stale write\n';
const CONTROL_POLL_LIMIT = 240;
const CONTROL_POLL_DELAY_MS = 250;
const CONTROL_OPEN_ATTEMPTS = 3;

// Keep the standard PDF asset manifest complete in the reduced CI runner bundle.
void packagedPdfWorkerUrl;

export interface PackagedLifecycleE2eSetup {
  schema: 1;
  nonce: string;
  workflow: {
    run_id: string;
    run_attempt: string;
    commit: string;
    target: string;
  };
  package_variant: string;
  current_exe_sha256: string;
  workspace: {
    workspace_token: string;
    root: string;
    files: unknown[];
    directories: unknown[];
  };
  paths: {
    save_success: string;
    save_stale: string;
    control: string;
    trash_file: string;
    trash_directory: string;
    receipt: string;
  };
}

export interface PackagedLifecycleE2eReceipt {
  schema: 2;
  gate: 'packaged-lifecycle-e2e';
  status: 'passed' | 'failed';
  target: string;
  runId: string;
  runAttempt: string;
  commit: string;
  buildFlavor: 'ci-instrumented-packaged-e2e';
  instrumentationFeature: 'packaged-lifecycle-e2e';
  packageVariant: string;
  packagedAppProcess: true;
  tauriRuntime: true;
  webviewBootstrap: true;
  normalInvokeHandlers: true;
  uiDriven: false;
  releaseArtifactEquivalent: false;
  currentExeSha256: string;
  nonceDigest: string;
  saveSuccess?: {
    beforeSha256: string;
    intendedSha256: string;
    afterSha256: string;
    expectedVersionSha256: string;
    returnedVersionSha256: string;
    response: 'confirmed_committed';
    exactBytes: true;
  };
  staleCas?: {
    beforeSha256: string;
    externalSha256: string;
    afterSha256: string;
    response: 'conflict';
    externalBytesPreserved: true;
  };
  trash?: [
    {
      kind: 'file';
      response: 'confirmed-committed';
      sourceAbsent: true;
      placementProof: 'native-recovery-receipt-exact-identity';
    },
    {
      kind: 'non-empty-directory';
      response: 'confirmed-committed';
      sourceAbsent: true;
      placementProof: 'native-recovery-receipt-exact-identity';
    },
  ];
  error?: string;
}

export interface PackagedLifecycleE2ePorts {
  setup: () => Promise<PackagedLifecycleE2eSetup>;
  openWorkspaceFile: (path: string) => Promise<PreparedOpenFileResponse>;
  commitRecentOpen: (openReceipt: string) => Promise<OpenCommitResult>;
  getOpenCommitStatus: (commitOperationId: string) => Promise<OpenCommitStatus>;
  writeFile: typeof writeFile;
  deleteWorkspaceEntry: (
    workspaceToken: string,
    path: string,
  ) => Promise<MutationOutcome<DeleteWorkspaceEntryResponse>>;
  wait: () => Promise<void>;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid packaged lifecycle setup: ${key}`);
  }
  return value;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(record);
  return actualKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

export function decodePackagedLifecycleE2eSetup(value: unknown): PackagedLifecycleE2eSetup {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.workspace) || !isRecord(value.paths)) {
    throw new Error('Invalid packaged lifecycle setup');
  }
  if (!isRecord(value.workflow) || !hasExactKeys(value.workflow, ['run_id', 'run_attempt', 'commit', 'target'])) {
    throw new Error('Invalid packaged lifecycle setup: workflow');
  }
  if (!Array.isArray(value.workspace.files) || !Array.isArray(value.workspace.directories)) {
    throw new Error('Invalid packaged lifecycle setup: workspace entries');
  }
  const setup: PackagedLifecycleE2eSetup = {
    schema: 1,
    nonce: requiredString(value, 'nonce'),
    workflow: {
      run_id: requiredString(value.workflow, 'run_id'),
      run_attempt: requiredString(value.workflow, 'run_attempt'),
      commit: requiredString(value.workflow, 'commit'),
      target: requiredString(value.workflow, 'target'),
    },
    package_variant: requiredString(value, 'package_variant'),
    current_exe_sha256: requiredString(value, 'current_exe_sha256'),
    workspace: {
      workspace_token: requiredString(value.workspace, 'workspace_token'),
      root: requiredString(value.workspace, 'root'),
      files: value.workspace.files,
      directories: value.workspace.directories,
    },
    paths: {
      save_success: requiredString(value.paths, 'save_success'),
      save_stale: requiredString(value.paths, 'save_stale'),
      control: requiredString(value.paths, 'control'),
      trash_file: requiredString(value.paths, 'trash_file'),
      trash_directory: requiredString(value.paths, 'trash_directory'),
      receipt: requiredString(value.paths, 'receipt'),
    },
  };
  if (!/^[0-9a-f]{64}$/.test(setup.nonce)) {
    throw new Error('Invalid packaged lifecycle setup: nonce');
  }
  if (!/^[0-9a-f]{64}$/.test(setup.current_exe_sha256)) {
    throw new Error('Invalid packaged lifecycle setup: current_exe_sha256');
  }
  return setup;
}

let operationSequence = 0;

function operationId(kind: string): string {
  operationSequence += 1;
  return `packaged-lifecycle-${kind}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptIdentity(
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

async function openCommittedText(
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

function requireCommittedSave(
  result: DocumentSaveResponse,
  label: string,
): asserts result is Extract<DocumentSaveResponse, { status: 'confirmed_committed' }> {
  if (result.status !== 'confirmed_committed') {
    throw new Error(result.status === 'indeterminate' ? `${label}: ${result.message}` : result.message);
  }
}

function requireCommittedDelete(
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

async function writeReceipt(
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

async function execute(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
): Promise<PackagedLifecycleE2eReceipt> {
  const successfulFile = await openCommittedText(ports, setup.paths.save_success);
  const successfulBeforeSha256 = await sha256(successfulFile.file.content);
  if (successfulBeforeSha256 !== successfulFile.file.file_version.sha256) {
    throw new Error('Save fixture content did not match its file version');
  }
  const intendedSha256 = await sha256(SAVE_SUCCESS_CONTENT);
  const successfulSave = await ports.writeFile(
    setup.paths.save_success,
    SAVE_SUCCESS_CONTENT,
    successfulFile.file.file_version,
    operationId('save-success'),
  );
  requireCommittedSave(successfulSave, 'Save gate was not committed');
  const successfulAfter = await openCommittedText(ports, setup.paths.save_success);
  const successfulAfterSha256 = await sha256(successfulAfter.file.content);
  if (
    successfulAfter.file.content !== SAVE_SUCCESS_CONTENT
    || successfulAfterSha256 !== intendedSha256
    || successfulAfterSha256 !== successfulAfter.file.file_version.sha256
    || successfulSave.version.sha256 !== intendedSha256
  ) {
    throw new Error('Committed save did not preserve the intended exact bytes');
  }

  const staleFile = await openCommittedText(ports, setup.paths.save_stale);
  const staleBeforeSha256 = await sha256(staleFile.file.content);
  if (staleBeforeSha256 !== staleFile.file.file_version.sha256) {
    throw new Error('Stale fixture content did not match its file version');
  }
  const control = await openCommittedText(ports, setup.paths.control);
  const ready = await ports.writeFile(
    setup.paths.control,
    PACKAGED_LIFECYCLE_CONTROL_READY,
    control.file.file_version,
    operationId('control-ready'),
  );
  requireCommittedSave(ready, 'Control ready write was not committed');

  let controlGo = false;
  for (let attempt = 0; attempt < CONTROL_POLL_LIMIT; attempt += 1) {
    const current = await openCommittedText(ports, setup.paths.control, CONTROL_OPEN_ATTEMPTS);
    if (current.file.content === PACKAGED_LIFECYCLE_CONTROL_GO) {
      controlGo = true;
      break;
    }
    await ports.wait();
  }
  if (!controlGo) throw new Error('Timed out waiting for external stale-write mutation');

  const staleSave = await ports.writeFile(
    setup.paths.save_stale,
    STALE_WRITE_CONTENT,
    staleFile.file.file_version,
    operationId('save-stale'),
  );
  if (staleSave.status !== 'conflict') {
    throw new Error(`Expected stale save conflict, received ${staleSave.status}`);
  }
  const competingFile = await openCommittedText(ports, setup.paths.save_stale);
  const competingSha256 = await sha256(PACKAGED_LIFECYCLE_COMPETING_CONTENT);
  const competingAfterSha256 = await sha256(competingFile.file.content);
  if (
    competingFile.file.content !== PACKAGED_LIFECYCLE_COMPETING_CONTENT
    || competingAfterSha256 !== competingSha256
    || competingAfterSha256 !== competingFile.file.file_version.sha256
  ) {
    throw new Error('Stale save changed the competing file content');
  }

  requireCommittedDelete(
    await ports.deleteWorkspaceEntry(setup.workspace.workspace_token, setup.paths.trash_file),
    setup.paths.trash_file,
  );
  requireCommittedDelete(
    await ports.deleteWorkspaceEntry(setup.workspace.workspace_token, setup.paths.trash_directory),
    setup.paths.trash_directory,
  );

  const receipt: PackagedLifecycleE2eReceipt = {
    ...await receiptIdentity(setup),
    status: 'passed',
    saveSuccess: {
      beforeSha256: successfulBeforeSha256,
      intendedSha256,
      afterSha256: successfulAfterSha256,
      expectedVersionSha256: successfulFile.file.file_version.sha256,
      returnedVersionSha256: successfulSave.version.sha256,
      response: 'confirmed_committed',
      exactBytes: true,
    },
    staleCas: {
      beforeSha256: staleBeforeSha256,
      externalSha256: competingSha256,
      afterSha256: competingAfterSha256,
      response: 'conflict',
      externalBytesPreserved: true,
    },
    trash: [
      {
        kind: 'file',
        response: 'confirmed-committed',
        sourceAbsent: true,
        placementProof: 'native-recovery-receipt-exact-identity',
      },
      {
        kind: 'non-empty-directory',
        response: 'confirmed-committed',
        sourceAbsent: true,
        placementProof: 'native-recovery-receipt-exact-identity',
      },
    ],
  };
  await writeReceipt(ports, setup, receipt);
  return receipt;
}

export async function runPackagedLifecycleE2e(
  ports: PackagedLifecycleE2ePorts = defaultPorts,
): Promise<PackagedLifecycleE2eReceipt> {
  return execute(ports, await ports.setup());
}

export async function startPackagedLifecycleE2e(
  ports: PackagedLifecycleE2ePorts = defaultPorts,
): Promise<void> {
  let setup: PackagedLifecycleE2eSetup | null = null;
  try {
    setup = await ports.setup();
    await execute(ports, setup);
  } catch (error) {
    if (setup) {
      const failed: PackagedLifecycleE2eReceipt = {
        ...await receiptIdentity(setup),
        status: 'failed',
        error: errorMessage(error),
      };
      try {
        await writeReceipt(ports, setup, failed);
      } catch {
        // The external harness also treats a missing receipt as a failed run.
      }
    }
  } finally {
    await ports.close();
  }
}

const defaultPorts: PackagedLifecycleE2ePorts = {
  setup: async () => decodePackagedLifecycleE2eSetup(
    await invoke<unknown>('setup_packaged_lifecycle_e2e'),
  ),
  openWorkspaceFile,
  commitRecentOpen,
  getOpenCommitStatus,
  writeFile,
  deleteWorkspaceEntry,
  wait: () => new Promise((resolve) => window.setTimeout(resolve, CONTROL_POLL_DELAY_MS)),
  close: () => getCurrentWindow().close(),
};
