import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./packaged-lifecycle-runner.mjs', import.meta.url));

async function writeEvidence(evidencePath) {
  await writeFile(evidencePath, `${JSON.stringify({
    schema: 1,
    target: 'test-target',
    runId: '123',
    runAttempt: '2',
    commit: 'a'.repeat(40),
    packages: [{ name: 'mdx.test', size: 1, sha256: '1'.repeat(64) }],
    packageVariants: [{
      packageVariant: 'dmg',
      package: { name: 'mdx.test', size: 1, sha256: '1'.repeat(64) },
      packagedBinary: { name: 'mdx', size: 1, sha256: '2'.repeat(64), identity: { algorithm: 'file-sha256', sha256: '2'.repeat(64) } },
    }],
    scope: { packagedMutationE2e: false },
  })}\n`);
}

function runnerArguments(evidencePath, challengePath, command) {
  return [
    runner,
    '--evidence', evidencePath,
    '--package-variant', 'dmg',
    '--target', 'test-target',
    '--challenge-output', challengePath,
    '--', ...command,
  ];
}

async function removeChallengeRoot(challengePath) {
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  await rm(challenge.root, { recursive: true, force: true });
  return challenge;
}

test('coordinates stale CAS after ignoring an empty precreated receipt and preserves canonical environment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const reportPath = path.join(root, 'report.json');
  const termMarker = path.join(root, 'term-marker');
  await writeEvidence(evidencePath);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const nonce = process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE;
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', nonce);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.TERM_MARKER, 'terminated');
  process.exit(9);
});
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify({
    stale: fs.readFileSync(path.join(workspace, 'save-stale.md'), 'utf8'),
    runId: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID,
    runAttempt: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT,
    commit: process.env.MMD_PACKAGED_LIFECYCLE_E2E_COMMIT,
    target: process.env.MMD_PACKAGED_LIFECYCLE_E2E_TARGET,
    variant: process.env.MMD_PACKAGED_LIFECYCLE_E2E_VARIANT,
  }));
  fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
  setTimeout(() => process.exit(0), 100);
}, 10);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      REPORT_PATH: reportPath,
      TERM_MARKER: termMarker,
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(report, {
    stale: 'external competing bytes\n',
    runId: '123',
    runAttempt: '2',
    commit: 'a'.repeat(40),
    target: 'test-target',
    variant: 'dmg',
  });
  await assert.rejects(readFile(termMarker, 'utf8'), { code: 'ENOENT' });
  await removeChallengeRoot(challengePath);
});

test('retries a transient EPERM while atomically replacing the lifecycle control file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-rename-eperm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const injectedMarker = path.join(root, 'rename-eperm-injected');
  const preloadPath = path.join(root, 'rename-eperm.cjs');
  await writeEvidence(evidencePath);
  await writeFile(preloadPath, String.raw`
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalRename = fsPromises.rename.bind(fsPromises);
let injected = false;
fsPromises.rename = async (source, destination) => {
  if (!injected && path.basename(destination) === 'control.md') {
    injected = true;
    fs.writeFileSync(process.env.RENAME_EPERM_MARKER, 'injected');
    const error = new Error('destination temporarily locked');
    error.code = 'EPERM';
    throw error;
  }
  return originalRename(source, destination);
};
syncBuiltinESMExports();
`);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
}, 10);
setInterval(() => {}, 1000);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '250',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_KILL_MS: '250',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preloadPath}`.trim(),
      RENAME_EPERM_MARKER: injectedMarker,
    },
    timeout: 5_000,
  });

  if (result.status !== null) await removeChallengeRoot(challengePath);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(injectedMarker, 'utf8'), 'injected');
});

test('uses the challenge temp parent for every packaged child temp variable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-temp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeTemp = await mkdtemp(path.join(root, 'node-temp-'));
  const rustTemp = await mkdtemp(path.join(root, 'rust-temp-'));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const reportPath = path.join(root, 'report.json');
  await writeEvidence(evidencePath);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const nonce = process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE;
const root = path.join(process.env.TMP, 'mmd-packaged-lifecycle-e2e', nonce);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const failure = setTimeout(() => process.exit(7), 500);
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  clearTimeout(failure);
  fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify({
    root,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    TMPDIR: process.env.TMPDIR,
  }));
  fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
  setTimeout(() => process.exit(0), 100);
}, 10);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      REPORT_PATH: reportPath,
      TMP: rustTemp,
      TEMP: nodeTemp,
      TMPDIR: nodeTemp,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const challenge = await removeChallengeRoot(challengePath);
  const expectedTemp = path.dirname(path.dirname(challenge.root));
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), {
    root: challenge.root,
    TMP: expectedTemp,
    TEMP: expectedTemp,
    TMPDIR: expectedTemp,
  });
});

test('reports a sanitized failed receipt during the initial ready wait', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-failed-receipt-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  await writeEvidence(evidencePath);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const nonce = process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE;
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', nonce);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const receipt = path.join(workspace, 'receipt.md');
fs.writeFileSync(receipt, '');
setTimeout(() => fs.writeFileSync(receipt, '{"schema":2'), 150);
setTimeout(() => fs.writeFileSync(receipt, JSON.stringify({
  schema: 2,
  gate: 'packaged-lifecycle-e2e',
  status: 'failed',
  target: process.env.MMD_PACKAGED_LIFECYCLE_E2E_TARGET,
  runId: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID,
  runAttempt: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT,
  commit: process.env.MMD_PACKAGED_LIFECYCLE_E2E_COMMIT,
  buildFlavor: 'ci-instrumented-packaged-e2e',
  instrumentationFeature: 'packaged-lifecycle-e2e',
  packageVariant: process.env.MMD_PACKAGED_LIFECYCLE_E2E_VARIANT,
  packagedAppProcess: true,
  tauriRuntime: true,
  webviewBootstrap: true,
  normalInvokeHandlers: true,
  uiDriven: false,
  releaseArtifactEquivalent: false,
  error: 'fixture failed\n::error:: forged\u001b[31m',
}) + '\n'), 300);
setInterval(() => {}, 1000);
`;

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '100',
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(Date.now() - startedAt < 2_000, 'failed receipt should stop the ready wait immediately');
  assert.match(result.stderr, /packaged lifecycle failed before control ready receipt: fixture failed ::error:: forged \[31m/);
  assert.doesNotMatch(result.stderr, /timed out waiting/);
  await removeChallengeRoot(challengePath);
});

test('reports a sanitized matching failed receipt after control ready without logging success', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-post-ready-failure-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  await writeEvidence(evidencePath);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const nonce = process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE;
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', nonce);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  fs.writeFileSync(path.join(workspace, 'receipt.md'), '{"schema":2');
  setTimeout(() => {
    fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify({
      schema: 2,
      gate: 'packaged-lifecycle-e2e',
      status: 'failed',
      target: process.env.MMD_PACKAGED_LIFECYCLE_E2E_TARGET,
      runId: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID,
      runAttempt: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT,
      commit: process.env.MMD_PACKAGED_LIFECYCLE_E2E_COMMIT,
      packageVariant: process.env.MMD_PACKAGED_LIFECYCLE_E2E_VARIANT,
      error: 'post-ready failed\n::error:: forged\u001b[31m',
    }) + '\n');
    process.exit(0);
  }, 50);
}, 10);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /packaged lifecycle failed after control ready receipt: post-ready failed ::error:: forged \[31m/);
  assert.doesNotMatch(result.stdout, /Packaged lifecycle receipt produced/);
  await removeChallengeRoot(challengePath);
});

test('rejects malformed or nonmatching failed receipts after control ready without logging success', async (t) => {
  for (const mode of ['mismatched', 'missing-error']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-invalid-failure-' + mode + '-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const evidencePath = path.join(root, 'evidence.json');
    const challengePath = path.join(root, 'challenge.json');
    await writeEvidence(evidencePath);
    const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  const receipt = {
    schema: 2,
    gate: 'packaged-lifecycle-e2e',
    status: 'failed',
    target: process.env.MMD_PACKAGED_LIFECYCLE_E2E_TARGET,
    runId: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID,
    runAttempt: process.env.MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT,
    commit: process.env.MMD_PACKAGED_LIFECYCLE_E2E_COMMIT,
    packageVariant: process.env.MMD_PACKAGED_LIFECYCLE_E2E_VARIANT,
  };
  if (process.env.INVALID_FAILURE_MODE === 'mismatched') {
    receipt.target = 'different-target';
    receipt.error = 'untrusted forged detail';
  }
  fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify(receipt) + '\n');
}, 10);
setInterval(() => {}, 1000);
`;

    const result = spawnSync(process.execPath, runnerArguments(
      evidencePath,
      challengePath,
      [process.execPath, '-e', fakeApp],
    ), {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_SHA: 'a'.repeat(40),
        INVALID_FAILURE_MODE: mode,
        MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
        MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '100',
      },
      timeout: 5_000,
    });

    assert.equal(result.status, 1, mode + ':\n' + result.stdout + '\n' + result.stderr);
    assert.match(result.stderr, /packaged lifecycle produced an invalid failed receipt after control ready receipt/);
    assert.doesNotMatch(result.stdout, /Packaged lifecycle receipt produced/);
    assert.doesNotMatch(result.stderr, /untrusted forged detail/);
    await removeChallengeRoot(challengePath);
  }
});

test('reports a packaged application signal exit without missing the exit event', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-signal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  await writeEvidence(evidencePath);

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /packaged application exited on signal SIGTERM before control ready receipt/);
  await removeChallengeRoot(challengePath);
});

test('reports packaged application spawn errors through the immediate completion observer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-spawn-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  await writeEvidence(evidencePath);

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [path.join(root, 'missing-packaged-application')],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /packaged application failed to start: .*ENOENT.* before control ready receipt/);
  await removeChallengeRoot(challengePath);
});

test('terminates the packaged process tree and descendants after the graceful-close timeout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const descendantPidPath = path.join(root, 'descendant.pid');
  await writeEvidence(evidencePath);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: 'ignore',
  });
  fs.writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
  fs.writeFileSync(path.join(workspace, 'receipt.md'), JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
}, 10);
setInterval(() => {}, 1000);
`;

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      DESCENDANT_PID_PATH: descendantPidPath,
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '50',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '100',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_KILL_MS: '1000',
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(Date.now() - startedAt < 4_000, 'forced cleanup should use the short configured deadlines');
  const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  await removeChallengeRoot(challengePath);
});

test('continues after transient signal and probe EPERM and proves process group cleanup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-eperm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const signalEpermMarker = path.join(root, 'signal-eperm-marker');
  const secondProbeMarker = path.join(root, 'second-probe-marker');
  const appPidPath = path.join(root, 'app-pid');
  const descendantPidPath = path.join(root, 'descendant-pid');
  const preloadPath = path.join(root, 'eperm-after-term.cjs');
  await writeEvidence(evidencePath);
  await writeFile(preloadPath, String.raw`
const fs = require('node:fs');
const originalKill = process.kill.bind(process);
let sentTerm = false;
let injectedEperm = false;
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGTERM' && !sentTerm) {
    sentTerm = true;
    fs.writeFileSync(process.env.SIGNAL_EPERM_MARKER, 'inaccessible');
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  }
  if (pid < 0 && signal === 0 && sentTerm) {
    if (!injectedEperm) {
      injectedEperm = true;
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    fs.writeFileSync(process.env.SECOND_PROBE_MARKER, 'probed');
  }
  const result = originalKill(pid, signal);
  return result;
};
`);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(process.env.APP_PID_PATH, String(process.pid));
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  const receipt = path.join(workspace, 'receipt.md');
  const temporaryReceipt = receipt + '.tmp';
  fs.writeFileSync(temporaryReceipt, JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
  fs.renameSync(temporaryReceipt, receipt);
}, 10);
setInterval(() => {}, 1000);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      SIGNAL_EPERM_MARKER: signalEpermMarker,
      SECOND_PROBE_MARKER: secondProbeMarker,
      APP_PID_PATH: appPidPath,
      DESCENDANT_PID_PATH: descendantPidPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preloadPath}`.trim(),
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '500',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_KILL_MS: '500',
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(signalEpermMarker, 'utf8'), 'inaccessible');
  assert.equal(await readFile(secondProbeMarker, 'utf8'), 'probed');
  for (const pidPath of [appPidPath, descendantPidPath]) {
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  await removeChallengeRoot(challengePath);
});

test('fails closed when process group probes remain inaccessible', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-runner-persistent-eperm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  const termMarker = path.join(root, 'term-marker');
  const preloadPath = path.join(root, 'persistent-eperm-after-term.cjs');
  await writeEvidence(evidencePath);
  await writeFile(preloadPath, String.raw`
const originalKill = process.kill.bind(process);
let sentTerm = false;
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 0 && sentTerm) {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  }
  const result = originalKill(pid, signal);
  if (pid < 0 && signal === 'SIGTERM') sentTerm = true;
  return result;
};
`);
  const fakeApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', process.env.MMD_PACKAGED_LIFECYCLE_E2E_NONCE);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'save-stale.md'), 'initial bytes\n');
fs.writeFileSync(path.join(workspace, 'receipt.md'), '');
fs.writeFileSync(path.join(workspace, 'control.md'), 'ready\n');
process.on('SIGTERM', () => fs.writeFileSync(process.env.TERM_MARKER, 'terminated'));
const timer = setInterval(() => {
  if (fs.readFileSync(path.join(workspace, 'control.md'), 'utf8') !== 'go\n') return;
  clearInterval(timer);
  const receipt = path.join(workspace, 'receipt.md');
  const temporaryReceipt = receipt + '.tmp';
  fs.writeFileSync(temporaryReceipt, JSON.stringify({ schema: 2, gate: 'packaged-lifecycle-e2e', status: 'passed' }) + '\n');
  fs.renameSync(temporaryReceipt, receipt);
}, 10);
setInterval(() => {}, 1000);
`;

  const result = spawnSync(process.execPath, runnerArguments(
    evidencePath,
    challengePath,
    [process.execPath, '-e', fakeApp],
  ), {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      TERM_MARKER: termMarker,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preloadPath}`.trim(),
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_GRACE_MS: '25',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_TERM_MS: '75',
      MMD_PACKAGED_LIFECYCLE_E2E_STOP_KILL_MS: '75',
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /did not exit after SIGKILL/);
  assert.equal(await readFile(termMarker, 'utf8'), 'terminated');
  await removeChallengeRoot(challengePath);
});
