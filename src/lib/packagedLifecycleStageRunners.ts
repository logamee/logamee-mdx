import {
  CONTROL_OPEN_ATTEMPTS,
  CONTROL_POLL_LIMIT,
  PACKAGED_LIFECYCLE_COMPETING_CONTENT,
  PACKAGED_LIFECYCLE_CONTROL_GO,
  PACKAGED_LIFECYCLE_CONTROL_READY,
  SAVE_SUCCESS_CONTENT,
  STALE_WRITE_CONTENT,
  type PackagedLifecycleE2ePorts,
  type PackagedLifecycleE2eSetup,
} from './packagedLifecycleSetup';
import {
  openCommittedText,
  operationId,
  requireCommittedDelete,
  requireCommittedSave,
  sha256,
} from './packagedLifecycleSupport';

export async function runSuccessfulSaveStage(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
) {
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
  return { successfulFile, successfulBeforeSha256, intendedSha256, successfulSave, successfulAfterSha256 };
}

export async function runStaleFixtureStage(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
) {
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
  return { staleFile, staleBeforeSha256 };
}

export async function waitForControlGo(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
): Promise<void> {
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
}

export async function runStaleCasStage(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
  staleFileVersion: Awaited<ReturnType<typeof openCommittedText>>['file']['file_version'],
): Promise<{ staleVersionSha256: string; competingSha256: string }> {
  const staleSave = await ports.writeFile(
    setup.paths.save_stale,
    STALE_WRITE_CONTENT,
    staleFileVersion,
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
  return { staleVersionSha256: staleFileVersion.sha256, competingSha256 };
}

export async function runTrashStage(
  ports: PackagedLifecycleE2ePorts,
  setup: PackagedLifecycleE2eSetup,
): Promise<void> {
  requireCommittedDelete(
    await ports.deleteWorkspaceEntry(setup.workspace.workspace_token, setup.paths.trash_file),
    setup.paths.trash_file,
  );
  requireCommittedDelete(
    await ports.deleteWorkspaceEntry(setup.workspace.workspace_token, setup.paths.trash_directory),
    setup.paths.trash_directory,
  );
}
