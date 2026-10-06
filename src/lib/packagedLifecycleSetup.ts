import packagedPdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import type {
  DeleteWorkspaceEntryResponse,
  MutationOutcome,
  OpenCommitResult,
  OpenCommitStatus,
  PreparedOpenFileResponse,
} from '../types';
import { writeFile } from './tauriCommands';

export const PACKAGED_LIFECYCLE_CONTROL_READY = 'ready\n';
export const PACKAGED_LIFECYCLE_CONTROL_GO = 'go\n';
export const PACKAGED_LIFECYCLE_COMPETING_CONTENT = 'external competing bytes\n';

export const SAVE_SUCCESS_CONTENT = 'packaged lifecycle saved\n';
export const STALE_WRITE_CONTENT = 'runner stale write\n';
export const CONTROL_POLL_LIMIT = 240;
export const CONTROL_POLL_DELAY_MS = 250;
export const CONTROL_OPEN_ATTEMPTS = 3;

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

function isPackagedLifecycleSetupRecord(value: unknown): value is {
  schema: unknown;
  workspace: Record<string, unknown>;
  paths: Record<string, unknown>;
  workflow: unknown;
  nonce?: unknown;
  package_variant?: unknown;
  current_exe_sha256?: unknown;
} & Record<string, unknown> {
  return isRecord(value)
    && value.schema === 1
    && isRecord(value.workspace)
    && isRecord(value.paths);
}

function packagedLifecycleWorkflowRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ['run_id', 'run_attempt', 'commit', 'target'])) {
    throw new Error('Invalid packaged lifecycle setup: workflow');
  }
  return value;
}

function packagedLifecycleWorkspaceEntries(workspace: Record<string, unknown>): { files: unknown[]; directories: unknown[] } {
  if (!Array.isArray(workspace.files) || !Array.isArray(workspace.directories)) {
    throw new Error('Invalid packaged lifecycle setup: workspace entries');
  }
  return { files: workspace.files, directories: workspace.directories };
}

export function decodePackagedLifecycleE2eSetup(value: unknown): PackagedLifecycleE2eSetup {
  if (!isPackagedLifecycleSetupRecord(value)) {
    throw new Error('Invalid packaged lifecycle setup');
  }
  const workflow = packagedLifecycleWorkflowRecord(value.workflow);
  const workspaceEntries = packagedLifecycleWorkspaceEntries(value.workspace);
  const setup: PackagedLifecycleE2eSetup = {
    schema: 1,
    nonce: requiredString(value, 'nonce'),
    workflow: {
      run_id: requiredString(workflow, 'run_id'),
      run_attempt: requiredString(workflow, 'run_attempt'),
      commit: requiredString(workflow, 'commit'),
      target: requiredString(workflow, 'target'),
    },
    package_variant: requiredString(value, 'package_variant'),
    current_exe_sha256: requiredString(value, 'current_exe_sha256'),
    workspace: {
      workspace_token: requiredString(value.workspace, 'workspace_token'),
      root: requiredString(value.workspace, 'root'),
      files: workspaceEntries.files,
      directories: workspaceEntries.directories,
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
