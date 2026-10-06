import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  commitRecentOpen,
  deleteWorkspaceEntry,
  getOpenCommitStatus,
  openWorkspaceFile,
  writeFile,
} from './tauriCommands';
import {
  CONTROL_POLL_DELAY_MS,
  decodePackagedLifecycleE2eSetup,
  type PackagedLifecycleE2ePorts,
  type PackagedLifecycleE2eReceipt,
  type PackagedLifecycleE2eSetup,
} from './packagedLifecycleSetup';
import {
  errorMessage,
  receiptIdentity,
  writeReceipt,
} from './packagedLifecycleSupport';
import {
  runStaleCasStage,
  runStaleFixtureStage,
  runSuccessfulSaveStage,
  runTrashStage,
  waitForControlGo,
} from './packagedLifecycleStageRunners';

async function execute(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
): Promise<PackagedLifecycleE2eReceipt> {
  const { successfulFile, successfulBeforeSha256, intendedSha256, successfulSave, successfulAfterSha256 } =
    await runSuccessfulSaveStage(ports, setup);
  const { staleFile, staleBeforeSha256 } = await runStaleFixtureStage(ports, setup);
  await waitForControlGo(ports, setup);
  const { competingSha256 } = await runStaleCasStage(ports, setup, staleFile.file.file_version);
  await runTrashStage(ports, setup);
  const competingAfterSha256 = competingSha256;
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
