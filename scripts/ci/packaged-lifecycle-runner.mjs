import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lifecycleScript = fileURLToPath(new URL('./lifecycle-evidence.mjs', import.meta.url));
const COMPETING_BYTES = 'external competing bytes\n';
const TIMEOUT_MS = 120_000;
const ATOMIC_RENAME_RETRY_ATTEMPTS = 20;
const ATOMIC_RENAME_RETRY_DELAY_MS = 25;
const ATOMIC_RENAME_RETRY_TIMEOUT_MS = 1_000;
const STOP_GRACE_MS = Number(process.env.MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS ?? 5_000);
const STOP_TERM_MS = Number(process.env.MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS ?? 5_000);
const STOP_KILL_MS = Number(process.env.MMD_PACKAGED_LIFECYCLE_E2E_STOP_KILL_MS ?? 5_000);
const usesPosixProcessGroups = process.platform !== 'win32';

function parse(arguments_) {
  const separator = arguments_.indexOf('--');
  if (separator === -1 || separator === arguments_.length - 1) {
    throw new Error('a packaged application command is required after --');
  }
  const values = new Map();
  for (let index = 0; index < separator; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid option near ${key ?? '<end>'}`);
    values.set(key.slice(2), value);
  }
  return { values, command: arguments_.slice(separator + 1) };
}

function one(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`exactly one --${name} is required`);
  return value;
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function observeChild(child) {
  let settled = false;
  const completion = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ kind: 'error', error }));
    child.once('exit', (exitCode, signalCode) => finish({ kind: 'exit', exitCode, signalCode }));
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ kind: 'exit', exitCode: child.exitCode, signalCode: child.signalCode });
    }
  });
  return { completion };
}

function describeCompletion(result) {
  if (result.kind === 'error') return `failed to start: ${result.error.message}`;
  if (result.signalCode !== null) return `exited on signal ${result.signalCode}`;
  return `exited with code ${result.exitCode}`;
}

async function waitUntil(predicate, completion, description) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const outcome = await Promise.race([
      completion.then((result) => ({ type: 'completion', result })),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'poll' }), 100)),
    ]);
    if (outcome.type === 'completion') {
      if (await predicate()) return;
      throw new Error(`packaged application ${describeCompletion(outcome.result)} before ${description}`);
    }
  }
  throw new Error(`timed out waiting for packaged application ${description}`);
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx' });
  const deadline = Date.now() + ATOMIC_RENAME_RETRY_TIMEOUT_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      const transientLock = error?.code === 'EPERM' || error?.code === 'EACCES';
      if (!transientLock || attempt >= ATOMIC_RENAME_RETRY_ATTEMPTS || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAY_MS));
    }
  }
}

function sanitizeReceiptError(message) {
  let sanitized = '';
  for (const character of message) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
    if (sanitized.length >= 500) break;
  }
  return sanitized.replace(/\s+/g, ' ').trim() || 'unspecified packaged lifecycle failure';
}

async function readPackagedReceiptState(file, challenge) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { kind: 'pending' };
    throw error;
  }
  if (receipt.schema !== 2 || receipt.gate !== 'packaged-lifecycle-e2e') {
    return { kind: 'pending' };
  }
  if (receipt.status === 'passed') return { kind: 'passed' };
  if (receipt.status !== 'failed') return { kind: 'pending' };
  if (typeof receipt.error !== 'string') return { kind: 'invalid-failed' };
  for (const field of ['target', 'runId', 'runAttempt', 'commit', 'packageVariant']) {
    if (receipt[field] !== challenge[field]) return { kind: 'invalid-failed' };
  }
  return { kind: 'failed', error: sanitizeReceiptError(receipt.error) };
}

function throwReceiptFailure(state, timing) {
  if (state.kind === 'failed') {
    throw new Error(`packaged lifecycle failed ${timing}: ${state.error}`);
  }
  if (state.kind === 'invalid-failed') {
    throw new Error(`packaged lifecycle produced an invalid failed receipt ${timing}`);
  }
}

async function settlesWithin(completion, milliseconds) {
  return await Promise.race([
    completion.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function processGroupState(pid) {
  try {
    process.kill(-pid, 0);
    return 'present';
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent';
    if (error.code === 'EPERM') return 'inaccessible';
    throw error;
  }
}

async function waitForProcessGroupExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (processGroupState(pid) === 'absent') return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processGroupState(pid) === 'absent';
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent';
    if (error.code === 'EPERM') return 'inaccessible';
    throw error;
  }
}

async function stopPosixProcessGroup(child) {
  if (await waitForProcessGroupExit(child.pid, STOP_GRACE_MS)) return;
  if (signalProcessGroup(child.pid, 'SIGTERM') === 'absent') return;
  if (await waitForProcessGroupExit(child.pid, STOP_TERM_MS)) return;
  if (signalProcessGroup(child.pid, 'SIGKILL') === 'absent') return;
  if (!(await waitForProcessGroupExit(child.pid, STOP_KILL_MS))) {
    throw new Error(`packaged application process group ${child.pid} did not exit after SIGKILL`);
  }
}

async function stopWindowsProcessTree(child, completion) {
  if (await settlesWithin(completion, STOP_GRACE_MS)) return;
  const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(await settlesWithin(completion, Math.min(STOP_TERM_MS, 500)))) {
    throw new Error(result.stderr || `taskkill failed with status ${result.status}`);
  }
  if (!(await settlesWithin(completion, STOP_KILL_MS))) {
    throw new Error(`packaged application process ${child.pid} did not exit after taskkill`);
  }
}

async function stopChild(child, observation) {
  if (child.pid === undefined) {
    await observation.completion;
    return;
  }
  if (usesPosixProcessGroups) {
    await stopPosixProcessGroup(child);
    return;
  }
  await stopWindowsProcessTree(child, observation.completion);
}

const { values, command } = parse(process.argv.slice(2));
const evidence = one(values, 'evidence');
const packageVariant = one(values, 'package-variant');
const target = one(values, 'target');
const challengeOutput = one(values, 'challenge-output');
const issue = spawnSync(process.execPath, [
  lifecycleScript,
  'issue-packaged-challenge',
  '--evidence', evidence,
  '--package-variant', packageVariant,
  '--output', challengeOutput,
], { encoding: 'utf8', env: process.env, shell: false });
if (issue.error) throw issue.error;
if (issue.status !== 0) throw new Error(issue.stderr || 'failed to issue packaged lifecycle challenge');

const challenge = JSON.parse(await readFile(challengeOutput, 'utf8'));
if (challenge.target !== target) throw new Error('packaged lifecycle challenge target mismatch');
console.log(`Packaged lifecycle challenge root: ${challenge.root}`);
const challengeTemp = path.dirname(path.dirname(challenge.root));
const child = spawn(command[0], command.slice(1), {
  env: {
    ...process.env,
    TMP: challengeTemp,
    TEMP: challengeTemp,
    TMPDIR: challengeTemp,
    MMD_PACKAGED_LIFECYCLE_E2E_NONCE: challenge.nonce,
    MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID: challenge.runId,
    MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT: challenge.runAttempt,
    MMD_PACKAGED_LIFECYCLE_E2E_COMMIT: challenge.commit,
    MMD_PACKAGED_LIFECYCLE_E2E_TARGET: challenge.target,
    MMD_PACKAGED_LIFECYCLE_E2E_VARIANT: challenge.packageVariant,
  },
  stdio: 'inherit',
  shell: false,
  detached: usesPosixProcessGroups,
});
const childObservation = observeChild(child);

try {
  await waitUntil(async () => {
    const receiptState = await readPackagedReceiptState(challenge.receiptPath, challenge);
    throwReceiptFailure(receiptState, 'before control ready receipt');
    if (!(await exists(challenge.controlPath))) return false;
    return await readFile(challenge.controlPath, 'utf8') === 'ready\n';
  }, childObservation.completion, 'control ready receipt');
  await writeFile(challenge.stalePath, COMPETING_BYTES);
  await writeAtomic(challenge.controlPath, 'go\n');
  await waitUntil(async () => {
    const receiptState = await readPackagedReceiptState(challenge.receiptPath, challenge);
    throwReceiptFailure(receiptState, 'after control ready receipt');
    return receiptState.kind === 'passed';
  }, childObservation.completion, 'complete lifecycle receipt');
} finally {
  await stopChild(child, childObservation);
}

console.log(`Packaged lifecycle receipt produced for ${packageVariant}.`);
