import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  applicationSettledReady,
  isPrimaryReceiptReady,
  launchPackagedTarget,
  launchMacPrimary,
  launchNativeAssociation,
  observePrimaryFocus,
  requireSuccessfulExit,
  runPackagedOpen,
  stopProcessByPid,
  stopPrimary,
  unicodeDeliveryReady,
  waitUntil,
} from './packaged-open-runner.mjs';

function exitedChild(code, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('exit', code, signal));
  return child;
}

function receipt(events, { status = 'collecting', primaryPid = 4100, final = true } = {}) {
  return {
    schema: 2,
    status,
    primary: { pid: primaryPid },
    events: events.map((event, index) => ({ seq: index + 1, ...event })),
    final: final ? {
      queueEmpty: true,
      authorization: { pendingFileReceipts: 0, pendingWorkspaceReceipts: 0 },
    } : null,
  };
}

const primaryEvents = [
  {
    actor: 'native', type: 'native_delivery', intentId: 'open-intent-1', step: 'cli-primary',
    source: 'startup_args', outcome: 'enqueued',
  },
  {
    actor: 'native', type: 'session_restore_queued', intentId: 'open-intent-2', step: 'session-restore',
    opaque: true,
  },
  { actor: 'app', type: 'app_settled', intentId: 'open-intent-1', step: 'cli-primary' },
  { actor: 'app', type: 'app_settled', intentId: 'open-intent-2', step: 'session-restore' },
];

const unicodeEvents = [
  ...primaryEvents,
  {
    actor: 'native', type: 'native_delivery', intentId: 'open-intent-3', step: 'cli-secondary-unicode',
    source: 'secondary_instance', outcome: 'enqueued',
  },
  {
    actor: 'native', type: 'native_delivery', intentId: 'open-intent-3', step: 'cli-secondary-duplicate',
    source: 'secondary_instance', outcome: 'coalesced',
  },
];

const finalEvents = [
  ...unicodeEvents,
  {
    actor: 'native', type: 'native_delivery', intentId: 'open-intent-4', step: 'cli-directory',
    source: 'secondary_instance', outcome: 'enqueued',
  },
  {
    actor: 'native', type: 'native_delivery', intentId: 'open-intent-5', step: 'cli-stale',
    source: 'secondary_instance', outcome: 'enqueued',
  },
  { actor: 'backend', type: 'focus_requested', intentId: 'open-intent-5', step: 'cli-stale' },
  { actor: 'app', type: 'app_settled', intentId: 'open-intent-3', step: 'cli-secondary-unicode' },
  { actor: 'app', type: 'app_settled', intentId: 'open-intent-4', step: 'cli-directory' },
  { actor: 'app', type: 'app_settled', intentId: 'open-intent-5', step: 'cli-stale' },
];

async function runAppImage() {
  const challenge = {
    profile: 'apply-reobserve',
    packageVariant: 'appimage',
    platform: 'linux',
    receiptPath: '/tmp/receipt.json',
    controlPath: '/tmp/control.json',
    scenario: {
      paths: {
        primaryFile: '/tmp/primary.md',
        unicodeFile: '/tmp/文档 space.md',
        renamedUnicodeFile: '/tmp/文档 renamed.md',
        workspaceDirectory: '/tmp/workspace',
        staleFile: '/tmp/stale.md',
        associationFile: '/tmp/association.md',
      },
    },
  };
  const launchedTargets = [];
  const controlWrites = [];
  const renames = [];
  let waitCount = 0;
  let associationLaunches = 0;
  let verificationCalls = 0;

  await runPackagedOpen({
    challengePath: '/tmp/challenge.json',
    binary: '/tmp/mdx',
    output: '/tmp/evidence.json',
    challenge,
  }, {
    launch(_binary, target) {
      launchedTargets.push(target);
      return { pid: 4100, exitCode: null, signalCode: null };
    },
    waitUntil: async () => [
      receipt(primaryEvents),
      receipt(unicodeEvents),
      {
        receipt: receipt(finalEvents),
        focus: finalEvents.find((event) => event.type === 'focus_requested'),
      },
      receipt(finalEvents, { status: 'passed' }),
    ][waitCount++],
    requireSuccessfulExit: async () => {},
    launchAssociation: async () => { associationLaunches += 1; },
    observePrimaryFocus: async () => {},
    writeJsonAtomic: async (file, value) => { controlWrites.push({ file, value }); },
    renameTarget: async (from, to) => { renames.push({ from, to }); },
    verifyEvidence: () => { verificationCalls += 1; },
    stopPrimary: async () => {},
  });

  return { associationLaunches, controlWrites, launchedTargets, renames, verificationCalls };
}

test('waitUntil rejects when the requested observation exceeds its timeout', async () => {
  await assert.rejects(
    waitUntil(async () => undefined, 'a receipt', { timeoutMs: 0, pollIntervalMs: 0 }),
    /timed out waiting for a receipt/,
  );
});

test('requireSuccessfulExit rejects a secondary process with a nonzero exit code', async () => {
  await assert.rejects(
    requireSuccessfulExit(exitedChild(17), 'secondary process', { timeoutMs: 100 }),
    /secondary process failed with exit code 17/,
  );
});

test('requireSuccessfulExit rejects a secondary process terminated by a signal', async () => {
  await assert.rejects(
    requireSuccessfulExit(exitedChild(null, 'SIGABRT'), 'secondary process', { timeoutMs: 100 }),
    /secondary process failed with SIGABRT/,
  );
});

test('requireSuccessfulExit rejects when a secondary process does not exit before timeout', async () => {
  await assert.rejects(
    requireSuccessfulExit(new EventEmitter(), 'secondary process', { timeoutMs: 0 }),
    /secondary process did not exit after forwarding its request/,
  );
});

test('requireSuccessfulExit clears its timeout after a prompt exit', async () => {
  const activeTimeouts = () => process.getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
  const before = activeTimeouts();

  await requireSuccessfulExit(exitedChild(0), 'secondary process', { timeoutMs: 1_000 });

  assert.equal(activeTimeouts(), before);
});

test('observePrimaryFocus rejects when another process remains active', async () => {
  await assert.rejects(
    observePrimaryFocus('linux', 4100, {
      activeWindowPid: () => 4200,
      timeoutMs: 0,
      pollIntervalMs: 0,
    }),
    /timed out waiting for primary process 4100 to become the active window/,
  );
});

test('schema-2 primary readiness requires real app settlement and an empty queue', () => {
  const challenge = { platform: 'linux' };
  assert.equal(isPrimaryReceiptReady(challenge, receipt(primaryEvents)), true);
  assert.equal(isPrimaryReceiptReady(challenge, receipt(primaryEvents.slice(0, -1))), false);
  assert.equal(isPrimaryReceiptReady(challenge, receipt(primaryEvents, { final: false })), false);
  assert.equal(isPrimaryReceiptReady(challenge, {
    status: 'collecting',
    observations: [{ step: 'cli-primary' }],
    queue: { sessionRestoreOpaque: true },
  }), false);

  const macEvents = primaryEvents.map((event) => event.step === 'cli-primary' ? {
    ...event,
    step: 'file-association',
    source: event.type === 'native_delivery' ? 'opened_event' : event.source,
  } : event);
  assert.equal(isPrimaryReceiptReady({ platform: 'macos' }, receipt(macEvents)), true);
});

test('Unicode rename readiness rejects a target already re-observed by the backend', () => {
  assert.throws(() => unicodeDeliveryReady(receipt([
    ...unicodeEvents,
    {
      actor: 'backend', type: 'backend_reobserved', intentId: 'open-intent-3',
      step: 'cli-secondary-unicode',
    },
  ])), /re-observation before the rename race/);
});

test('final readiness requires every intent settled and no pending authorization receipts', () => {
  const challenge = { packageVariant: 'appimage' };
  assert.equal(applicationSettledReady(challenge, receipt(finalEvents))?.focus.intentId, 'open-intent-5');
  const pending = receipt(finalEvents);
  pending.final.authorization.pendingFileReceipts = 1;
  assert.equal(applicationSettledReady(challenge, pending), undefined);
  assert.equal(applicationSettledReady(challenge, receipt(finalEvents.slice(0, -1))), undefined);
});

test('runPackagedOpen reports a primary exit while waiting for its startup receipt', async () => {
  const primary = new EventEmitter();
  Object.assign(primary, { pid: 4100, exitCode: null, signalCode: null });
  queueMicrotask(() => {
    primary.exitCode = 23;
    primary.emit('exit', 23, null);
  });

  await assert.rejects(runPackagedOpen({
    challengePath: '/tmp/challenge.json',
    binary: '/tmp/mdx',
    output: '/tmp/evidence.json',
    challenge: {
      packageVariant: 'appimage',
      platform: 'linux',
      receiptPath: '/tmp/receipt.json',
      controlPath: '/tmp/control.json',
      scenario: { paths: { primaryFile: '/tmp/primary.md' } },
    },
  }, {
    launch: () => primary,
    readJsonIfComplete: async () => undefined,
    waitUntil: (predicate, description) => waitUntil(predicate, description, {
      timeoutMs: 20,
      pollIntervalMs: 1,
    }),
    stopPrimary: async () => {},
  }), /primary packaged process exited before recording its startup intent with exit code 23/);
});

test('launchMacPrimary cold-starts through LaunchServices with only the native association', () => {
  let invocation;
  const child = {};
  const challenge = {
    root: '/tmp/challenge-root',
    nonce: 'a'.repeat(64),
    runId: '123',
    runAttempt: '2',
    commit: 'b'.repeat(40),
    target: 'aarch64-apple-darwin',
    platform: 'macos',
    profile: 'restore-cancel',
    packageVariant: 'dmg',
    scenario: {
      paths: {
        associationFile: '/tmp/fixtures/association.md',
      },
    },
  };

  const launched = launchMacPrimary(
    '/tmp/mdx.app',
    challenge,
    {
      spawn(command, arguments_, options) {
        invocation = { command, arguments_, options };
        return child;
      },
    },
  );

  assert.equal(launched, child);
  assert.equal(invocation.command, 'open');
  assert.deepEqual(invocation.arguments_.slice(0, 3), ['-W', '-a', '/tmp/mdx.app']);
  assert.ok(invocation.arguments_.includes(`MMD_PACKAGED_OPEN_E2E_NONCE=${challenge.nonce}`));
  assert.ok(invocation.arguments_.includes('MMD_PACKAGED_OPEN_E2E_PLATFORM=macos'));
  assert.ok(invocation.arguments_.includes('MMD_PACKAGED_OPEN_E2E_PROFILE=restore-cancel'));
  assert.equal(invocation.arguments_.at(-1), '/tmp/fixtures/association.md');
  assert.equal(invocation.arguments_.includes('--args'), false);
  assert.equal(invocation.options.shell, false);
});

test('launchNativeAssociation passes a Windows target through the PowerShell environment', async () => {
  const child = {};
  let invocation;
  let completed;
  const target = 'C:\\fixtures with spaces\\association.md';
  const challenge = {
    root: 'C:\\challenge-root',
    nonce: 'a'.repeat(64),
    runId: '123',
    runAttempt: '1',
    commit: 'b'.repeat(40),
    target: 'x86_64-pc-windows-msvc',
    packageVariant: 'nsis',
    platform: 'windows',
    profile: 'apply-reobserve',
    scenario: { paths: { associationFile: target } },
  };

  await launchNativeAssociation(challenge, undefined, {
    spawn: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return child;
    },
    requireSuccessfulExit: async (receivedChild, description) => {
      completed = { receivedChild, description };
    },
  });

  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.arguments_, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:MMD_PACKAGED_OPEN_ASSOCIATION_TARGET',
  ]);
  assert.equal(invocation.options.env.MMD_PACKAGED_OPEN_ASSOCIATION_TARGET, target);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(completed, { receivedChild: child, description: 'native association launcher' });
});

test('launchPackagedTarget preserves an absolute AppImage target across AppRun cwd changes', () => {
  const invocations = [];
  const challenge = {
    root: '/tmp/challenge-root',
    nonce: 'a'.repeat(64),
    runId: '123',
    runAttempt: '1',
    commit: 'b'.repeat(40),
    target: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    profile: 'apply-reobserve',
  };
  const spawn = (command, arguments_, options) => {
    invocations.push({ command, arguments_, options });
    return {};
  };

  launchPackagedTarget(
    '/tmp/mdx.AppImage',
    '/tmp/fixtures with spaces/primary.md',
    { ...challenge, packageVariant: 'appimage' },
    { spawn },
  );
  launchPackagedTarget(
    '/usr/bin/mdx',
    '/tmp/fixtures with spaces/primary.md',
    { ...challenge, packageVariant: 'deb' },
    { spawn },
  );

  assert.deepEqual(invocations.map(({ command, arguments_, options }) => ({
    command,
    arguments_,
    cwd: options.cwd,
  })), [
    {
      command: '/tmp/mdx.AppImage',
      arguments_: ['/tmp/fixtures with spaces/primary.md'],
      cwd: '/tmp/fixtures with spaces',
    },
    {
      command: '/usr/bin/mdx',
      arguments_: ['primary.md'],
      cwd: '/tmp/fixtures with spaces',
    },
  ]);
});

test('stopPrimary finds the macOS app by exact binary when no receipt exposed its PID', async () => {
  const launcher = { pid: 4100, exitCode: 0, signalCode: null };
  const stopped = [];

  await stopPrimary(launcher, launcher.pid, '/tmp/mdx.app/Contents/MacOS/mdx', {
    platform: 'darwin',
    findMacReceiverPids: async (binary) => {
      assert.equal(binary, '/tmp/mdx.app/Contents/MacOS/mdx');
      return [4200];
    },
    stopProcessByPid: async (pid) => { stopped.push(pid); },
  });

  assert.deepEqual(stopped, [4200]);
});

test('stopProcessByPid waits for the receiver to disappear after SIGKILL', async () => {
  const signals = [];
  const observations = [true, true, false];

  await stopProcessByPid(4200, {
    processExists: () => observations.shift() ?? false,
    kill: (_pid, signal) => { signals.push(signal); },
    wait: async () => {},
    termTimeoutMs: 0,
    killTimeoutMs: 10,
  });

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(observations.length, 0);
});

test('stopPrimary proves a POSIX receiver exited before the next challenge can start', async () => {
  const primary = new EventEmitter();
  Object.assign(primary, {
    pid: 4100,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
    },
  });
  const stopped = [];

  await stopPrimary(primary, primary.pid, '/tmp/mdx', {
    platform: 'linux',
    stopProcessByPid: async (pid) => { stopped.push(pid); },
  });

  assert.deepEqual(stopped, [primary.pid]);
  assert.equal(primary.signalCode, null);
});

test('runPackagedOpen accepts the receiver PID from a LaunchServices primary', async () => {
  const challenge = {
    profile: 'apply-reobserve',
    packageVariant: 'dmg',
    platform: 'macos',
    receiptPath: '/tmp/receipt.json',
    controlPath: '/tmp/control.json',
    scenario: {
      paths: {
        primaryFile: '/tmp/primary.md',
        unicodeFile: '/tmp/unicode.md',
        renamedUnicodeFile: '/tmp/unicode-renamed.md',
        workspaceDirectory: '/tmp/workspace',
        staleFile: '/tmp/stale.md',
        associationFile: '/tmp/association.md',
      },
    },
  };
  const launcher = { pid: 4100, exitCode: null, signalCode: null };
  const stoppedReceiverPids = [];
  let waitCount = 0;
  let macPrimaryLaunches = 0;
  let associationLaunches = 0;
  const launchedTargets = [];

  await runPackagedOpen({
    challengePath: '/tmp/challenge.json',
    binary: '/tmp/mdx',
    output: '/tmp/evidence.json',
    associationApp: '/tmp/mdx.app',
    challenge,
  }, {
    launchMacPrimary: () => {
      macPrimaryLaunches += 1;
      return launcher;
    },
    launch: (_binary, target) => {
      launchedTargets.push(target);
      return { pid: 4300, exitCode: null, signalCode: null };
    },
    waitUntil: async () => [
      { status: 'collecting', primary: { pid: 4200 } },
      {},
      { focus: { intentId: 'open-intent-6', step: 'cli-stale' } },
      { status: 'passed' },
    ][waitCount++],
    requireSuccessfulExit: async () => {},
    launchAssociation: async () => { associationLaunches += 1; },
    observePrimaryFocus: async () => {},
    writeJsonAtomic: async () => {},
    renameTarget: async () => {},
    verifyEvidence: async () => {},
    stopPrimary: async (_child, receiverPid) => { stoppedReceiverPids.push(receiverPid); },
  });

  assert.equal(macPrimaryLaunches, 1);
  assert.equal(associationLaunches, 0);
  assert.deepEqual(launchedTargets, [
    '/tmp/primary.md',
    '/tmp/unicode.md',
    '/tmp/unicode.md',
    '/tmp/workspace',
    '/tmp/stale.md',
  ]);
  assert.deepEqual(stoppedReceiverPids, [4200]);
});

test('runPackagedOpen omits native association launch for AppImage', async () => {
  const result = await runAppImage();

  assert.equal(result.associationLaunches, 0);
});

test('runPackagedOpen preserves the warm native association launch on Windows and Linux packages', async () => {
  for (const platform of ['windows', 'linux']) {
    const challenge = {
      profile: 'apply-reobserve',
      packageVariant: platform === 'windows' ? 'nsis' : 'deb',
      platform,
      receiptPath: '/tmp/receipt.json',
      controlPath: '/tmp/control.json',
      scenario: {
        paths: {
          primaryFile: '/tmp/primary.md',
          unicodeFile: '/tmp/unicode.md',
          renamedUnicodeFile: '/tmp/unicode-renamed.md',
          workspaceDirectory: '/tmp/workspace',
          staleFile: '/tmp/stale.md',
          associationFile: '/tmp/association.md',
        },
      },
    };
    let associationLaunches = 0;
    let waitCount = 0;

    await runPackagedOpen({
      challengePath: '/tmp/challenge.json',
      binary: '/tmp/mdx',
      output: '/tmp/evidence.json',
      challenge,
    }, {
      launch: () => ({ pid: 4100, exitCode: null, signalCode: null }),
      waitUntil: async () => [
        { status: 'collecting', primary: { pid: 4100 } },
        {},
        { focus: { intentId: 'open-intent-6', step: 'file-association' } },
        { status: 'passed' },
      ][waitCount++],
      requireSuccessfulExit: async () => {},
      launchAssociation: async () => { associationLaunches += 1; },
      observePrimaryFocus: async () => {},
      writeJsonAtomic: async () => {},
      renameTarget: async () => {},
      verifyEvidence: async () => {},
      stopPrimary: async () => {},
    });

    assert.equal(associationLaunches, 1, platform);
  }
});

test('runPackagedOpen preserves CLI focus and verification flow for AppImage', async () => {
  const result = await runAppImage();

  assert.deepEqual(result.launchedTargets, [
    '/tmp/primary.md',
    '/tmp/文档 space.md',
    '/tmp/文档 space.md',
    '/tmp/workspace',
    '/tmp/stale.md',
  ]);
  assert.deepEqual(result.renames, [{
    from: '/tmp/文档 space.md',
    to: '/tmp/文档 renamed.md',
  }]);
  assert.equal(result.controlWrites.length, 1);
  assert.equal(result.controlWrites[0].value.schema, 2);
  assert.equal(result.controlWrites[0].value.focus.intentId, 'open-intent-5');
  assert.equal(result.controlWrites[0].value.focus.step, 'cli-stale');
  assert.equal(result.controlWrites[0].value.focus.observed, true);
  assert.equal(result.verificationCalls, 1);
});
