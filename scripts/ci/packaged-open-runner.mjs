import { spawn, spawnSync } from 'node:child_process';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceScript = fileURLToPath(new URL('./packaged-open-evidence.mjs', import.meta.url));
const TIMEOUT_MS = Number(process.env.MMD_PACKAGED_OPEN_E2E_TIMEOUT_MS ?? 120_000);

function parse(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid option near ${key ?? '<end>'}`);
    if (values.has(key.slice(2))) throw new Error(`${key} must not be repeated`);
    values.set(key.slice(2), value);
  }
  return values;
}

function one(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`exactly one --${name} is required`);
  return value;
}

function optional(values, name) {
  return values.get(name);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJsonIfComplete(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function waitUntil(predicate, description, {
  timeoutMs = TIMEOUT_MS,
  pollIntervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await predicate();
    if (value) return value;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function childCompletion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export async function requireSuccessfulExit(child, description, { timeoutMs = TIMEOUT_MS } = {}) {
  const result = await new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    timeout = setTimeout(() => {
      cleanup();
      resolve({ timeout: true });
    }, timeoutMs);
  });
  if (result.timeout) throw new Error(`${description} did not exit after forwarding its request`);
  if (result.signal || result.code !== 0) {
    throw new Error(`${description} failed with ${result.signal ?? `exit code ${result.code}`}`);
  }
}

function packagedOpenEnvironment(challenge) {
  return {
    MMD_PACKAGED_OPEN_E2E_CHALLENGE: challenge.root,
    MMD_PACKAGED_OPEN_E2E_NONCE: challenge.nonce,
    MMD_PACKAGED_OPEN_E2E_RUN_ID: challenge.runId,
    MMD_PACKAGED_OPEN_E2E_RUN_ATTEMPT: challenge.runAttempt,
    MMD_PACKAGED_OPEN_E2E_COMMIT: challenge.commit,
    MMD_PACKAGED_OPEN_E2E_TARGET: challenge.target,
    MMD_PACKAGED_OPEN_E2E_VARIANT: challenge.packageVariant,
    MMD_PACKAGED_OPEN_E2E_PLATFORM: challenge.platform,
    MMD_PACKAGED_OPEN_E2E_PROFILE: challenge.profile,
  };
}

function appEnvironment(challenge) {
  return { ...process.env, ...packagedOpenEnvironment(challenge) };
}

export function launchPackagedTarget(binary, target, challenge, {
  spawn: spawnProcess = spawn,
} = {}) {
  const targetArgument = challenge.packageVariant === 'appimage' ? target : path.basename(target);
  return spawnProcess(binary, [targetArgument], {
    cwd: path.dirname(target),
    env: appEnvironment(challenge),
    stdio: 'inherit',
    shell: false,
  });
}

export function launchMacPrimary(associationApp, challenge, {
  spawn: spawnProcess = spawn,
} = {}) {
  if (!associationApp) throw new Error('--association-app is required for a DMG challenge');
  const challengeEnvironment = Object.entries(packagedOpenEnvironment(challenge))
    .flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  return spawnProcess('open', [
    '-W', '-a', associationApp,
    ...challengeEnvironment,
    challenge.scenario.paths.associationFile,
  ], {
    stdio: 'inherit',
    shell: false,
  });
}

export async function launchNativeAssociation(challenge, associationApp, {
  spawn: spawnProcess = spawn,
  requireSuccessfulExit: requireExit = requireSuccessfulExit,
} = {}) {
  const target = challenge.scenario.paths.associationFile;
  let command;
  let arguments_;
  let environment = appEnvironment(challenge);
  if (challenge.platform === 'macos') {
    if (!associationApp) throw new Error('--association-app is required for a DMG challenge');
    command = 'open';
    arguments_ = ['-a', associationApp, target];
  } else if (challenge.platform === 'windows') {
    command = 'powershell.exe';
    environment = { ...environment, MMD_PACKAGED_OPEN_ASSOCIATION_TARGET: target };
    arguments_ = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:MMD_PACKAGED_OPEN_ASSOCIATION_TARGET',
    ];
  } else {
    command = 'gio';
    arguments_ = ['open', target];
  }
  const child = spawnProcess(command, arguments_, {
    env: environment,
    stdio: 'inherit',
    shell: false,
  });
  await requireExit(child, 'native association launcher');
}

function activeWindowPid(platform) {
  let command;
  let arguments_;
  if (platform === 'macos') {
    command = 'osascript';
    arguments_ = ['-e', 'tell application "System Events" to unix id of first application process whose frontmost is true'];
  } else if (platform === 'windows') {
    command = 'powershell.exe';
    arguments_ = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$s=@"\nusing System; using System.Runtime.InteropServices; public static class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }\n"@; Add-Type $s; $p=0; [void][F]::GetWindowThreadProcessId([F]::GetForegroundWindow(), [ref]$p); $p',
    ];
  } else {
    command = 'xdotool';
    arguments_ = ['getactivewindow', 'getwindowpid'];
  }
  const result = spawnSync(command, arguments_, { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) return undefined;
  const pid = Number(result.stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export async function observePrimaryFocus(platform, primaryPid, {
  activeWindowPid: readActiveWindowPid = activeWindowPid,
  timeoutMs = TIMEOUT_MS,
  pollIntervalMs = 100,
} = {}) {
  return waitUntil(
    async () => readActiveWindowPid(platform) === primaryPid,
    `primary process ${primaryPid} to become the active window`,
    { timeoutMs, pollIntervalMs },
  );
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs, exists, wait) {
  const deadline = Date.now() + timeoutMs;
  while (exists(pid)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, deadline - Date.now()));
  }
  return true;
}

export async function stopProcessByPid(pid, dependencies = {}) {
  const {
    processExists: exists = processExists,
    kill = (targetPid, signal) => process.kill(targetPid, signal),
    wait = sleep,
    termTimeoutMs = 5_000,
    killTimeoutMs = 5_000,
  } = dependencies;
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  if (await waitForProcessExit(pid, termTimeoutMs, exists, wait)) return;
  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  if (!(await waitForProcessExit(pid, killTimeoutMs, exists, wait))) {
    throw new Error(`packaged receiver process ${pid} did not exit after SIGKILL`);
  }
}

async function findMacReceiverPids(binary) {
  let canonicalBinary;
  try {
    canonicalBinary = await realpath(binary);
  } catch {
    return [];
  }
  const result = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2] === canonicalBinary ? [Number(match[1])] : [];
  });
}

export async function stopPrimary(child, receiverPid = child.pid, binary, dependencies = {}) {
  const {
    platform = process.platform,
    findMacReceiverPids: findReceiverPids = findMacReceiverPids,
    stopProcessByPid: stopPid = stopProcessByPid,
  } = dependencies;
  if (platform === 'darwin') {
    const receiverPids = receiverPid !== child.pid
      ? [receiverPid]
      : binary ? await findReceiverPids(binary) : [];
    for (const pid of receiverPids) await stopPid(pid);
  } else if (platform !== 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await stopPid(receiverPid);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { encoding: 'utf8', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0 && child.exitCode === null) throw new Error(result.stderr || 'taskkill failed');
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([childCompletion(child), sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function assertPrimaryHasNotExited(primary) {
  if (primary.signalCode !== null) {
    throw new Error(
      `primary packaged process exited before recording its startup intent with ${primary.signalCode}`,
    );
  }
  if (primary.exitCode !== null) {
    throw new Error(
      `primary packaged process exited before recording its startup intent with exit code ${primary.exitCode}`,
    );
  }
}

export function isPrimaryReceiptReady(challenge, receipt) {
  if (receipt?.schema !== 2 || receipt.status !== 'collecting'
      || !Array.isArray(receipt.events) || receipt.final?.queueEmpty !== true) {
    return false;
  }
  const expectedStep = challenge.platform === 'macos' ? 'file-association' : 'cli-primary';
  const expectedSource = challenge.platform === 'macos' ? 'opened_event' : 'startup_args';
  const primary = receipt.events.find((event) => (
    event.type === 'native_delivery'
      && event.step === expectedStep
      && event.source === expectedSource
      && event.outcome === 'enqueued'
  ));
  const restore = receipt.events.find((event) => (
    event.type === 'session_restore_queued' && event.opaque === true
  ));
  if (!primary || !restore) return false;
  return [primary.intentId, restore.intentId].every((intentId) => receipt.events.some((event) => (
    event.type === 'app_settled' && event.intentId === intentId
  )));
}

export function unicodeDeliveryReady(receipt) {
  if (receipt?.schema !== 2 || receipt.status !== 'collecting' || !Array.isArray(receipt.events)) {
    return undefined;
  }
  const unicode = receipt.events.find((event) => (
    event.type === 'native_delivery'
      && event.step === 'cli-secondary-unicode'
      && event.outcome === 'enqueued'
  ));
  const duplicate = receipt.events.find((event) => (
    event.type === 'native_delivery'
      && event.step === 'cli-secondary-duplicate'
      && event.outcome === 'coalesced'
      && event.intentId === unicode?.intentId
  ));
  if (!unicode || !duplicate) return undefined;
  if (receipt.events.some((event) => (
    event.intentId === unicode.intentId && event.type === 'backend_reobserved'
  ))) {
    throw new Error('Unicode target reached backend re-observation before the rename race');
  }
  return { receipt, unicode };
}

function expectedDeliveryCount(challenge) {
  return challenge.packageVariant === 'appimage' ? 5 : 6;
}

export function applicationSettledReady(challenge, receipt) {
  if (receipt?.schema !== 2 || receipt.status !== 'collecting'
      || !Array.isArray(receipt.events) || receipt.final?.queueEmpty !== true
      || receipt.final?.authorization?.pendingFileReceipts !== 0
      || receipt.final?.authorization?.pendingWorkspaceReceipts !== 0) {
    return undefined;
  }
  const deliveries = receipt.events.filter((event) => event.type === 'native_delivery');
  if (deliveries.length < expectedDeliveryCount(challenge)) return undefined;
  const enqueuedIntentIds = new Set([
    ...deliveries.filter((event) => event.outcome === 'enqueued').map((event) => event.intentId),
    ...receipt.events.filter((event) => event.type === 'session_restore_queued').map((event) => event.intentId),
  ]);
  const settledIntentIds = new Set(receipt.events
    .filter((event) => event.type === 'app_settled')
    .map((event) => event.intentId));
  if (![...enqueuedIntentIds].every((intentId) => settledIntentIds.has(intentId))) return undefined;
  const focus = [...receipt.events].reverse().find((event) => event.type === 'focus_requested');
  if (!focus) return undefined;
  return { receipt, focus };
}

function verifyEvidence({ challengePath, challenge, output }) {
  const verified = spawnSync(process.execPath, [
    evidenceScript, 'verify', '--challenge', challengePath,
    '--receipt', challenge.receiptPath, '--output', output,
  ], { encoding: 'utf8', env: process.env, shell: false });
  if (verified.error) throw verified.error;
  if (verified.status !== 0) throw new Error(verified.stderr || 'native-open evidence verification failed');
}

export async function runPackagedOpen({
  challengePath,
  binary,
  output,
  associationApp,
  challenge: suppliedChallenge,
}, dependencies = {}) {
  const operations = {
    launch: launchPackagedTarget,
    launchMacPrimary,
    waitUntil,
    readJsonIfComplete,
    requireSuccessfulExit,
    launchAssociation: launchNativeAssociation,
    observePrimaryFocus,
    writeJsonAtomic,
    renameTarget: rename,
    verifyEvidence,
    stopPrimary,
    ...dependencies,
  };
  const challenge = suppliedChallenge ?? JSON.parse(await readFile(challengePath, 'utf8'));
  const primary = challenge.platform === 'macos'
    ? operations.launchMacPrimary(
      associationApp,
      challenge,
    )
    : operations.launch(binary, challenge.scenario.paths.primaryFile, challenge);
  let receiverPid = primary.pid;

  try {
    const collecting = await operations.waitUntil(async () => {
      assertPrimaryHasNotExited(primary);
      const receipt = await operations.readJsonIfComplete(challenge.receiptPath);
      if (receipt?.status === 'failed') throw new Error(receipt.error ?? 'packaged open instrumentation failed');
      return isPrimaryReceiptReady(challenge, receipt) ? receipt : undefined;
    }, 'the primary packaged process to settle its startup open intents');
    if (challenge.platform !== 'macos' && collecting.primary?.pid !== primary.pid) {
      throw new Error('instrumented primary PID does not match launched packaged process');
    }
    receiverPid = collecting.primary?.pid;
    if (!Number.isSafeInteger(receiverPid) || receiverPid <= 0) {
      throw new Error('instrumented primary receipt omitted its receiver PID');
    }

    if (challenge.platform === 'macos') {
      await operations.requireSuccessfulExit(
        operations.launch(binary, challenge.scenario.paths.primaryFile, challenge),
        'primary CLI process',
      );
    }
    const unicodeTarget = challenge.scenario.paths.unicodeFile;
    const duplicates = [
      operations.launch(binary, unicodeTarget, challenge),
      operations.launch(binary, unicodeTarget, challenge),
    ];
    await Promise.all(duplicates.map((child, index) => (
      operations.requireSuccessfulExit(child, `duplicate secondary process ${index + 1}`)
    )));
    await operations.waitUntil(async () => {
      const receipt = await operations.readJsonIfComplete(challenge.receiptPath);
      if (receipt?.status === 'failed') throw new Error(receipt.error ?? 'packaged open instrumentation failed');
      return unicodeDeliveryReady(receipt);
    }, 'the Unicode duplicate delivery to be queued before backend re-observation');
    await operations.renameTarget(
      challenge.scenario.paths.unicodeFile,
      challenge.scenario.paths.renamedUnicodeFile,
    );
    await operations.requireSuccessfulExit(
      operations.launch(binary, challenge.scenario.paths.workspaceDirectory, challenge),
      'directory CLI process',
    );
    await operations.requireSuccessfulExit(
      operations.launch(binary, challenge.scenario.paths.staleFile, challenge),
      'stale-target CLI process',
    );
    if (challenge.platform !== 'macos' && challenge.packageVariant !== 'appimage') {
      await operations.launchAssociation(challenge, associationApp);
    }

    const settled = await operations.waitUntil(async () => {
      const receipt = await operations.readJsonIfComplete(challenge.receiptPath);
      if (receipt?.status === 'failed') throw new Error(receipt.error ?? 'packaged open instrumentation failed');
      return applicationSettledReady(challenge, receipt);
    }, 'the real application to settle every queued open intent');

    await operations.observePrimaryFocus(challenge.platform, receiverPid);
    await operations.writeJsonAtomic(challenge.controlPath, {
      schema: 2,
      focus: {
        intentId: settled.focus.intentId,
        step: settled.focus.step,
        requested: true,
        observed: true,
        method: 'platform-active-window-pid',
        pid: receiverPid,
      },
    });

    await operations.waitUntil(async () => {
      const receipt = await operations.readJsonIfComplete(challenge.receiptPath);
      if (receipt?.status === 'failed') throw new Error(receipt.error ?? 'packaged open instrumentation failed');
      return receipt?.status === 'passed'
        && receipt.schema === 2
        && receipt.final?.queueEmpty === true
        && receipt.events?.some((event) => event.type === 'app_settled')
        ? receipt
        : undefined;
    }, 'the packaged application to finalize native-open evidence');

    await operations.verifyEvidence({ challengePath, challenge, output });
  } finally {
    await operations.stopPrimary(primary, receiverPid, binary);
  }
}

export async function main(arguments_ = process.argv.slice(2)) {
  const values = parse(arguments_);
  const challengePath = one(values, 'challenge');
  const binary = one(values, 'binary');
  const output = one(values, 'output');
  const associationApp = optional(values, 'association-app');
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  await runPackagedOpen({ challengePath, binary, output, associationApp, challenge });
  console.log(`Packaged native-open evidence verified for ${challenge.packageVariant}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
